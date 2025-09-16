import { E2E } from './crypto.js';
import { applyLang } from './i18n.js';

window.addEventListener('DOMContentLoaded', () => {
  // ===== Config =====
  const AUTO_WS_URL = 'wss://silent-backend.onrender.com/ws?room=test';
  const qs = new URLSearchParams(location.search);
  const FORCED_WS = qs.get('ws') || AUTO_WS_URL;
  document.getElementById('wsEndpoint')?.textContent = FORCED_WS;

  // ===== Stato =====
  let ws = null;
  let e2e = new E2E();
  let isConnecting = false;
  let isConnected = false;
  let reconnectTimer = null;
  let backoffMs = 2000; // 2s → 4s → 8s … max 15s

  let deferredPrompt = null;

  // Chiavi: evita rigenerazioni e cambi accidentali
  let keysGenerated = false;   // genera solo una volta
  let myPubExpected = null;    // valore “bloccato” della mia chiave (base64)

  // Nuovi flag per comportamento manuale E2E
  let sessionStarted = false;  // E2E parte solo dopo click "Avvia sessione"
  let pendingPeerKey = null;   // se ricevo la chiave prima del click la salvo

  // ===== DOM =====
  const $ = (s) => document.querySelector(s);
  const els = {
    langSel:     $('#langSelect'),
    installBtn:  $('#installBtn'),
    clearBtn:    $('#clearBtn'),

    connTitle:   document.querySelector('[data-i18n="connection"]'),
    connStatus:  $('#connStatus'),

    myPub:       $('#myPub'),
    copyMyBtn:   $('#copyMyPubBtn'),
    peerPub:     $('#peerPub'),
    startBtn:    $('#startSessionBtn'),

    log:         $('#log'),
    input:       $('#msgInput'),
    sendBtn:     $('#sendBtn'),
    composer:    document.querySelector('.composer'),
  };

  // ===== Utils =====
  const escapeHtml = (s) => (s ? s.replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m])) : '');

  function addMsg(text, who = 'peer') {
    if (!els.log) return;
    const li = document.createElement('li');
    li.className = who;
    const div = document.createElement('div');
    div.className = 'bubble';
    if (who === 'me') div.classList.add('me');
    div.innerHTML = escapeHtml(text);
    li.appendChild(div);
    els.log.appendChild(li);
    els.log.scrollTop = els.log.scrollHeight;
    setTimeout(() => li.remove(), 5 * 60 * 1000); // autodistruzione dopo 5 min
  }

  function addImage(url, who='peer'){
    if (!els.log) return;
    const li = document.createElement('li');
    li.className = who;
    const div = document.createElement('div');
    div.className = 'bubble';
    if (who === 'me') div.classList.add('me');
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'foto';
    img.style.maxWidth = '70%';
    img.style.borderRadius = '8px';
    div.appendChild(img);
    li.appendChild(div);
    els.log.appendChild(li);
    els.log.scrollTop = els.log.scrollHeight;
    setTimeout(()=>{ URL.revokeObjectURL(url); li.remove(); }, 5*60*1000);
  }

  // nuovo: aggiunge audio alla UI
  function addAudio(blobOrUrl, who='peer', durationSec=null) {
    if (!els.log) return;
    const li = document.createElement('li');
    li.className = who;
    const div = document.createElement('div');
    div.className = 'bubble';
    if (who === 'me') div.classList.add('me');
    const audio = document.createElement('audio');
    audio.controls = true;
    let url;
    if (typeof blobOrUrl === 'string') {
      url = blobOrUrl;
      audio.src = url;
    } else {
      url = URL.createObjectURL(blobOrUrl);
      audio.src = url;
      // revoca dopo 5 minuti quando rimuoviamo il li
    }
    div.appendChild(audio);
    if (durationSec !== null) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${durationSec}s` + (who === 'me' ? ' • Inviato' : '');
      div.appendChild(meta);
    }
    li.appendChild(div);
    els.log.appendChild(li);
    els.log.scrollTop = els.log.scrollHeight;
    setTimeout(()=>{ if (url && url.startsWith('blob:')) URL.revokeObjectURL(url); li.remove(); }, 5*60*1000);
  }

  // === Helper immagine / Base64 (robusti su smartphone) ===
  function blobToImage(blob){
    return new Promise((resolve, reject)=>{
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = ()=>{ URL.revokeObjectURL(url); resolve(img); };
      img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('Immagine non valida')); };
      img.src = url;
    });
  }
  function imageToJpegBlob(img, {maxW=1280, maxH=1280, quality=0.85}={}){
    const w = img.naturalWidth, h = img.naturalHeight;
    const r = Math.min(maxW/w, maxH/h, 1);
    const nw = Math.round(w*r), nh = Math.round(h*r);
    const canvas = document.createElement('canvas');
    canvas.width = nw; canvas.height = nh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, nw, nh);
    return new Promise((resolve)=>{
      if (canvas.toBlob){
        canvas.toBlob(b => resolve({ blob: b, width: nw, height: nh }), 'image/jpeg', quality);
      } else {
        const dataURL = canvas.toDataURL('image/jpeg', quality);
        fetch(dataURL).then(r => r.blob()).then(b => resolve({ blob: b, width: nw, height: nh }));
      }
    });
  }
  // Converte un Blob in base64 in modo sicuro (niente stack overflow)
  function blobToBase64(blob){
    return new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result || '';
        const b64 = String(dataUrl).split(',')[1] || ''; // rimuove "data:...;base64,"
        resolve(b64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  // Base64 -> ArrayBuffer per ricostruire il Blob in ricezione
  function b64ToAb(b64){
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  // Ridimensiona/ricomprime più aggressivo per mobile (budget più basso)
  async function adaptAndEncodeImage(originalImg){
    const targets = [
      {max: 960, q: 0.80},
      {max: 720, q: 0.76},
      {max: 600, q: 0.74},
      {max: 480, q: 0.72},
      {max: 360, q: 0.70},
    ];
    const SAFE_B64_LEN = 300_000;

    let lastBlob = null, lastW = null, lastH = null, lastB64 = null;

    for (const t of targets){
      const {blob, width, height} = await imageToJpegBlob(originalImg, {maxW:t.max, maxH:t.max, quality:t.q});
      const b64 = await blobToBase64(blob);
      lastBlob = blob; lastW = width; lastH = height; lastB64 = b64;
      if (b64.length <= SAFE_B64_LEN){
        return { b64, width, height, blob };
      }
    }
    return { b64: lastB64, width: lastW, height: lastH, blob: lastBlob };
  }

  // ===== I18N & SW =====
  els.langSel && els.langSel.addEventListener('change', () => applyLang(els.langSel.value));
  applyLang('it');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }

  // ===== Stato Connessione =====
  function setConnState(connected) {
    isConnected = !!connected;
    const txt = connected ? 'connesso' : 'non connesso';
    const color = connected ? '#16a34a' : '#dc2626';

    if (els.connTitle) {
      els.connTitle.textContent = `: ${txt}`;
      els.connTitle.style.color = color;
      els.connTitle.style.fontWeight = '700';
    }
    if (els.connStatus) {
      els.connStatus.textContent = connected ? 'Connesso' : 'Non connesso';
      els.connStatus.classList.toggle('connected', connected);
      els.connStatus.classList.toggle('disconnected', !connected);
    }
  }
  setConnState(false);

  // ===== Install PWA =====
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
  });
  els.installBtn && els.installBtn.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch {}
      deferredPrompt = null;
      return;
    }
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (isStandalone) alert('L’app è già installata.');
    else if (isIOS) alert('iPhone/iPad: 1) Condividi • 2) Aggiungi alla schermata Home.');
    else alert('Apri il menu del browser → “Installa app” / “Aggiungi alla schermata Home”.');
  });

  // ===== E2E =====
  async function ensureKeys(){
    if (keysGenerated) return; // evita rigenerazioni
    if (!e2e.myPubRaw) {
      const pub = await e2e.init(); // genera una sola volta
      myPubExpected = pub;
      if (els.myPub) els.myPub.value = pub;
      if (els.myPub) {
        els.myPub.readOnly = true;
        els.myPub.addEventListener('input', ()=>{
          if (myPubExpected && els.myPub.value !== myPubExpected) {
            els.myPub.value = myPubExpected;
          }
        });
      }
    }
    keysGenerated = true;
  }

  // Copia chiave
  els.copyMyBtn && els.copyMyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(els.myPub?.value || '');
      if (els.connTitle) {
        els.connTitle.textContent = ': chiave copiata ✔';
        setTimeout(() => setConnState(isConnected), 1200);
      }
    } catch (e) {
      alert('Impossibile copiare: ' + e.message);
    }
  });

  // ===== WebSocket =====
  function humanCloseReason(ev) {
    if (location.protocol === 'https:' && FORCED_WS.startsWith('ws://')) {
      return 'Mixed Content: la pagina è HTTPS ma il WS è ws:// (usa wss://)';
    }
    if (ev.code === 1006) return 'Handshake/TLS/Server irraggiungibile';
    if (ev.code === 1000) return 'Chiusura normale';
    if (ev.code === 1001) return 'Server riavviato o pagina cambiata';
    return ev.reason || '';
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    backoffMs = Math.min(backoffMs * 2, 15000);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoffMs);
  }

  function connect() {
    if (isConnecting || isConnected) return;
    isConnecting = true;
    setConnState(false);

    try {
      console.log('[WS] connecting to:', FORCED_WS);
      ws = new WebSocket(FORCED_WS);
    } catch (e) {
      console.error('[WS] constructor error:', e);
      isConnecting = false;
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', async () => {
      console.log('[WS] open');
      isConnecting = false;
      setConnState(true);
      backoffMs = 2000;
      await ensureKeys();
      // NOTA: non inviamo la chiave qui. L'utente dovrà premere "Avvia sessione" per far partire l'E2E.
    });

    ws.addEventListener('close', (ev) => {
      console.warn('[WS] close', ev.code, ev.reason);
      isConnecting = false;
      setConnState(false);
      // reset stato sessione manuale
      sessionStarted = false;
      pendingPeerKey = null;
      console.warn('[WS] reason:', humanCloseReason(ev));
      scheduleReconnect();
    });

    ws.addEventListener('error', (ev) => {
      console.error('[WS] error', ev);
    });

    ws.addEventListener('message', async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'ping') return;

        if (msg.type === 'key' || msg.type === 'pubkey') {
          // supporta entrambi i nomi: 'key' o 'pubkey'
          await ensureKeys();
          const peerRaw = (msg.raw || msg.pub || '').trim();
          const myRaw   = (myPubExpected || els.myPub?.value || '').trim();

          // Se il server ributta la TUA chiave, ignorala
          if (!peerRaw || peerRaw === myRaw) {
            console.log('[E2E] ricevuta la mia chiave → ignoro');
            return;
          }

          // Se la sessione non è stata ancora avviata dall'utente, memorizza la chiave in pending
          if (!sessionStarted) {
            pendingPeerKey = peerRaw;
            console.log('[E2E] chiave peer ricevuta ma in attesa di "Avvia sessione"');
            return;
          }

          // Se la sessione è iniziata, procedi a impostare la chiave peer
          if (e2e.ready && e2e.peerPubRawB64 === peerRaw) return;

          try {
            await e2e.setPeerPublicKey(peerRaw);
            e2e.peerPubRawB64 = peerRaw;
            if (els.connTitle) els.connTitle.textContent = ': connesso (E2E attiva)';
            console.log('[E2E] peer key impostata');
          } catch (e) {
            console.error('setPeerPublicKey error:', e);
          }
          return;
        }

        // Non tentare decrypt se E2E non è pronta
        if (!e2e.ready) return;

        if (msg.type === 'msg') {
          const plain = await e2e.decrypt(msg.iv, msg.ct);
          addMsg(plain, 'peer');
          return;
        }

        if (msg.type === 'image') {
          const b64 = await e2e.decrypt(msg.iv, msg.ct);               // base64 string
          const buf = b64ToAb(b64);                                    // -> ArrayBuffer
          const blob = new Blob([buf], { type: msg.mime || 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          addImage(url, 'peer');
          return;
        }

        if (msg.type === 'audio') {
          // audio cifrato in base64 -> decrittazione -> riproduzione
          try {
            const b64 = await e2e.decrypt(msg.iv, msg.ct); // base64 string of audio
            const ab = b64ToAb(b64);
            const blob = new Blob([ab], { type: msg.mime || 'audio/webm' });
            addAudio(blob, 'peer', msg.duration || null);
          } catch (err) {
            console.error('Errore decrypt audio:', err);
          }
          return;
        }

      } catch (e) {
        console.error('[WS] message error:', e);
      }
    });
  }

  // keep-alive ping (alcuni hosting chiudono su inattività)
  setInterval(() => {
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch {}
  }, 25000);

  // auto start
  (async function autoStart() {
    await ensureKeys();
    connect();
    ensureComposerControls();
  })();

  // ===== Avvia Sessione =====
  els.startBtn && els.startBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    await ensureKeys(); // NON rigenera più
    sessionStarted = true;

    let peerRaw = (els.peerPub?.value || '').trim();
    if (!peerRaw && pendingPeerKey) peerRaw = pendingPeerKey;

    if (!peerRaw) {
      alert('Incolla la chiave del peer oppure attendi che arrivi e ripremi "Avvia sessione".');
      return;
    }

    try {
      await e2e.setPeerPublicKey(peerRaw);   // ora e2e.ready = true
      e2e.peerPubRawB64 = peerRaw;          // memorizza per confronti futuri

      // invia la mia chiave così il peer potrà impostare la mia chiave come peer
      if (ws && ws.readyState === 1) {
        const myRaw = myPubExpected || (els.myPub?.value || '');
        try { ws.send(JSON.stringify({ type: 'key', raw: myRaw })); } catch {}
      }

      const details = document.querySelector('details');
      if (details) details.open = false;

      if (els.connTitle) els.connTitle.textContent = ': connesso (E2E attiva)';
    } catch (err) {
      console.error('Errore Avvia sessione:', err);
      alert('Errore avvio sessione: ' + (err && err.message ? err.message : err));
    }
  });

  // ===== Invia messaggio di testo =====
  els.sendBtn && els.sendBtn.addEventListener('click', async () => {
    if (!isConnected) return alert('Non connesso');
    if (!e2e.ready) return alert('Scambio chiavi incompleto: premi "Avvia sessione" o attendi la chiave del peer.');
    const text = (els.input?.value || '').trim();
    if (!text) return;

    try {
      const { iv, ct } = await e2e.encrypt(text);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'msg', iv, ct }));
      }
      addMsg(text, 'me');
      if (els.input) els.input.value = '';
    } catch (e) {
      console.error('Send error:', e);
      alert('Errore invio messaggio: ' + (e && e.message ? e.message : e));
    }
  });

  els.input && els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      els.sendBtn && els.sendBtn.click();
    }
  });

  // ===== Pulisci chat =====
  els.clearBtn && els.clearBtn.addEventListener('click', () => {
    if (els.log) els.log.innerHTML = '';
  });

  // ===== Foto & Audio controls: crea i pulsanti accanto al composer =====
  function ensureComposerControls(){
    if (!els.composer) return;

    // Photo button (come prima)
    if (!document.getElementById('photoBtn')) {
      const photoBtn = document.createElement('button');
      photoBtn.id = 'photoBtn';
      photoBtn.textContent = 'Foto';
      photoBtn.title = 'Scatta o scegli dalla galleria';
      photoBtn.style.marginLeft = '6px';
      els.composer.appendChild(photoBtn);

      // two inputs for camera & gallery
      const cameraInput  = document.createElement('input');
      cameraInput.type = 'file';
      cameraInput.accept = 'image/*';
      cameraInput.capture = 'environment';
      cameraInput.style.display = 'none';

      const galleryInput = document.createElement('input');
      galleryInput.type = 'file';
      galleryInput.accept = 'image/*';
      galleryInput.style.display = 'none';

      document.body.appendChild(cameraInput);
      document.body.appendChild(galleryInput);

      // menu
      els.composer.style.position = 'relative';
      const menu = document.createElement('div');
      menu.className = 'photo-menu hidden';
      menu.style.position = 'absolute';
      menu.style.zIndex = '60';
      menu.style.padding = '8px';
      menu.style.background = '#fff';
      menu.style.border = '1px solid #e5e7eb';
      menu.style.borderRadius = '8px';
      menu.style.display = 'none';
      menu.innerHTML = `
        <button type="button" data-act="camera">Scatta</button>
        <button type="button" data-act="gallery">Galleria</button>
      `;
      els.composer.appendChild(menu);

      photoBtn.addEventListener('click', (e)=>{
        e.preventDefault();
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        menu.style.left = '-10px';
        menu.style.top = '-80px';
      });

      menu.addEventListener('click', (e)=>{
        const act = e.target?.getAttribute('data-act');
        if (act === 'camera') cameraInput.click();
        if (act === 'gallery') galleryInput.click();
        menu.style.display = 'none';
      });

      document.addEventListener('click', (e)=>{
        if (!menu.contains(e.target) && e.target !== photoBtn) {
          menu.style.display = 'none';
        }
      });

      cameraInput.addEventListener('change', ()=> handleFile(cameraInput.files && cameraInput.files[0]));
      galleryInput.addEventListener('change', ()=> handleFile(galleryInput.files && galleryInput.files[0]));
    }

    // ===== Audio recorder buttons (limite 30s) =====
    if (!document.getElementById('recordBtn')) {
      const audioControls = document.createElement('div');
      audioControls.id = 'audio-controls';
      audioControls.style.marginLeft = '6px';
      audioControls.innerHTML = `
        <button id="recordBtn">🎙️ Registra</button>
        <button id="stopBtn" disabled>■ Ferma</button>
        <span id="recStatus">Pronto</span>
      `;
      els.composer.appendChild(audioControls);

      const recordBtn = document.getElementById('recordBtn');
      const stopBtn = document.getElementById('stopBtn');
      const recStatus = document.getElementById('recStatus');

      // --------------- configurazione durata massima ---------------
      const MAX_RECORD_SEC = 30; // limite in secondi
      let mediaRecorder = null;
      let recChunks = [];
      let recStartTs = 0;
      let currentStream = null;
      let maxTimer = null;
      let tickTimer = null;

      // processa la registrazione (condivide logica di invio)
      async function processRecording(blob, durationSec) {
        // anteprima locale
        try { addAudio(blob, 'me', durationSec); } catch(e){ console.warn(e); }

        // invio automatico
        try {
          if (!isConnected) {
            recStatus.textContent = 'Non connesso';
            return;
          }
          if (!e2e.ready) {
            recStatus.textContent = 'E2E non pronta';
            alert('Scambio chiavi incompleto: premi "Avvia sessione" o attendi la chiave del peer.');
            return;
          }

          const b64 = await blobToBase64(blob); // usa la funzione esistente
          const { iv, ct } = await e2e.encrypt(b64);
          const payload = { type: 'audio', iv, ct, mime: blob.type, duration: durationSec, size: blob.size };
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify(payload));
            recStatus.textContent = 'Inviato';
          } else {
            recStatus.textContent = 'Non connesso';
            console.warn('WebSocket non connesso: impossibile inviare audio');
          }
        } catch (err) {
          console.error('Errore invio audio:', err);
          recStatus.textContent = 'Errore invio';
        } finally {
          // pulizia stream se ancora attivo
          if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
          recordBtn.disabled = false;
          stopBtn.disabled = true;
        }
      }

      // avvia registrazione (gestisce timer di stop automatico e conto alla rovescia)
      recordBtn.addEventListener('click', async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          currentStream = stream;
          recChunks = [];
          mediaRecorder = new MediaRecorder(stream);
          mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };

          mediaRecorder.onstop = async () => {
            // crea blob dai chunk e chiama processRecording
            const blob = new Blob(recChunks, { type: recChunks[0]?.type || 'audio/webm' });
            const durationSec = Math.round((Date.now() - recStartTs) / 1000);
            // cancella timers
            if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
            if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
            await processRecording(blob, durationSec);
          };

          // start
          mediaRecorder.start();
          recStartTs = Date.now();
          recStatus.textContent = `Registrazione — ${MAX_RECORD_SEC}s rimanenti`;
          recordBtn.disabled = true;
          stopBtn.disabled = false;

          // auto-stop dopo MAX_RECORD_SEC
          maxTimer = setTimeout(() => {
            // se ancora registriamo, fermiamo
            try { if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop(); } catch(e){ console.warn(e); }
          }, MAX_RECORD_SEC * 1000);

          // tick per aggiornare display (250ms per reattività)
          tickTimer = setInterval(() => {
            const elapsed = Math.floor((Date.now() - recStartTs) / 1000);
            const remaining = Math.max(0, MAX_RECORD_SEC - elapsed);
            recStatus.textContent = `Registrazione — ${remaining}s rimanenti`;
            if (remaining <= 0) {
              // safety: pulizia tick (onstop handler farà il resto)
              if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
            }
          }, 250);
        } catch (err) {
          console.error('Permesso microfono negato o errore:', err);
          recStatus.textContent = 'Errore accesso microfono';
        }
      });

      // stop manuale: ferma mediaRecorder (l'onstop si occupa di invio)
      stopBtn.addEventListener('click', async () => {
        if (!mediaRecorder) return;
        try {
          // cancella timer di auto-stop
          if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
          if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
          if (mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
          } else {
            // se non in stato 'recording' ma abbiamo chunk, processali comunque
            const blob = new Blob(recChunks, { type: recChunks[0]?.type || 'audio/webm' });
            const durationSec = Math.round((Date.now() - recStartTs) / 1000);
            await processRecording(blob, durationSec);
          }
        } catch (e) {
          console.warn('MediaRecorder stop error', e);
          // cleanup forzato
          if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
          recordBtn.disabled = false;
          stopBtn.disabled = true;
          recStatus.textContent = 'Pronto';
        }
      });
    }
    // ===== fine Audio recorder buttons =====
  }

  async function handleFile(file){
    if (!file) return;
    if (!isConnected) return alert('Non connesso');
    if (!e2e.ready) return alert('Scambio chiavi incompleto: premi "Avvia sessione" o attendi la chiave del peer.');
    try{
      const img = await blobToImage(file);
      let { b64, width, height, blob } = await adaptAndEncodeImage(img);
      try {
        const { iv, ct } = await e2e.encrypt(b64);
        if (ws && ws.readyState === 1){
          ws.send(JSON.stringify({ type:'image', iv, ct, mime:'image/jpeg', w:width, h:height }));
        }
        const url = URL.createObjectURL(blob);
        addImage(url, 'me');
      } catch (err) {
        console.warn('Encrypt fallita, ritento a 320px:', err);
        const tiny = await imageToJpegBlob(img, { maxW: 320, maxH: 320, quality: 0.68 });
        const tinyB64 = await blobToBase64(tiny.blob);
        const { iv, ct } = await e2e.encrypt(tinyB64);
        if (ws && ws.readyState === 1){
          ws.send(JSON.stringify({ type:'image', iv, ct, mime:'image/jpeg', w:tiny.width, h:tiny.height }));
        }
        const url = URL.createObjectURL(tiny.blob);
        addImage(url, 'me');
      }

    }catch(err){
      console.error('Errore invio foto:', err);
      alert('Errore invio foto: ' + (err && err.message ? err.message : err));
    }
  }

  // ===== Riconnessione quando torni in foreground =====
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!ws || ws.readyState !== 1)) connect();
  });
});
