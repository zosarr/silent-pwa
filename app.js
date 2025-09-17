// app.js — Silent PWA (testo, foto, audio E2E)

// === Imports originali ===
import { E2E } from './crypto.js';
import { applyLang } from './i18n.js';

window.addEventListener('DOMContentLoaded', () => {
  // ===== Config =====
  const AUTO_WS_URL = 'wss://silent-backend.onrender.com/ws?room=test';
  const qs = new URLSearchParams(location.search);
  const FORCED_WS = qs.get('ws') || AUTO_WS_URL;

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

  // ===== Utils testo & media =====
  const escapeHtml = (s) => (s ? s.replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m])) : '');

  function addMsg(text, who = 'peer') {
    if (!els.log) return;
    const li = document.createElement('li');
    li.className = who;
    li.innerHTML = escapeHtml(text);
    els.log.appendChild(li);
    els.log.scrollTop = els.log.scrollHeight;
    setTimeout(() => li.remove(), 5 * 60 * 1000); // autodistruzione dopo 5 min
  }

  function addImage(url, who='peer'){
    if (!els.log) return;
    const li = document.createElement('li');
    li.className = who;
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'foto';
    img.style.maxWidth = '70%';
    img.style.borderRadius = '8px';
    li.appendChild(img);
    els.log.appendChild(li);
    els.log.scrollTop = els.log.scrollHeight;
    setTimeout(()=>{ URL.revokeObjectURL(url); li.remove(); }, 5*60*1000);
  }

  // === Player audio in chat (NUOVO) ===
  function addAudio(url, who='peer', mime='audio/webm') {
    if (!els.log) return;
    const li = document.createElement('li');
    li.className = who;

    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = url;
    audio.type = mime;
    audio.style.maxWidth = '70%';
    audio.style.display = 'block';

    li.appendChild(audio);
    els.log.appendChild(li);
    els.log.scrollTop = els.log.scrollHeight;

    setTimeout(() => { URL.revokeObjectURL(url); li.remove(); }, 5 * 60 * 1000);
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
        // fallback per browser senza toBlob
        const dataURL = canvas.toDataURL('image/jpeg', quality);
        fetch(dataURL).then(r => r.blob()).then(b => resolve({ blob: b, width: nw, height: nh }));
      }
    });
  }
  // Converte un Blob in base64 (usato anche per audio)
  function blobToBase64(blob){
    return new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result || '';
        const b64 = String(dataUrl).split(',')[1] || ''; // rimuove "data:.base64,"
        resolve(b64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  // Base64 -> ArrayBuffer per ricostruire un Blob (immagini/audio in ricezione)
  function b64ToAb(b64){
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  // Ridimensiona/ricomprime aggressivo per mobile (foto)
  async function adaptAndEncodeImage(originalImg){
    const targets = [
      {max: 960, q: 0.80},
      {max: 720, q: 0.76},
      {max: 600, q: 0.74},
      {max: 480, q: 0.72},
      {max: 360, q: 0.70},
    ];
    // ~300k chars base64 ≈ ~225 KB reali
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
    // se nessun target rientra nel budget, usa l'ultimo (più piccolo)
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
      // “blinda” il campo UI: non deve cambiare
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

        if (msg.type === 'key') {
          await ensureKeys();
          const peerRaw = (msg.raw || '').trim();
          const myRaw   = (myPubExpected || els.myPub?.value || '').trim();

          // Se il server ributta la TUA chiave, ignorala
          if (!peerRaw || peerRaw === myRaw) {
            console.log('[E3E] ricevuta la mia chiave → ignoro');
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
          const b64 = await e2e.decrypt(msg.iv, msg.ct);               // base64 (jpeg)
          const buf = b64ToAb(b64);                                    // -> ArrayBuffer
          const blob = new Blob([buf], { type: msg.mime || 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          addImage(url, 'peer');
          return;
        }

        // === RICEZIONE AUDIO (NUOVO) ===
        if (msg.type === 'audio') {
          const b64  = await e2e.decrypt(msg.iv, msg.ct); // base64 audio
          const buf  = b64ToAb(b64);
          const mime = msg.mime || 'audio/webm';
          const blob = new Blob([buf], { type: mime });
          const url  = URL.createObjectURL(blob);
          addAudio(url, 'peer', mime);
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

  // ===== Avvia Sessione =====
  els.startBtn && els.startBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    await ensureKeys(); // NON rigenera più
    // l'utente ora ha esplicitamente richiesto di avviare la sessione
    sessionStarted = true;

    // preferisci la chiave incollata dall'utente, altrimenti usa quella pending
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

      // chiudi il <details> "Scambio chiavi"
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

  // ===== Foto: scatta o scegli dalla galleria (senza cambiare HTML) =====
  function ensurePhotoControls(){
    if (!els.composer || document.getElementById('photoBtn')) return;
    const photoBtn = document.createElement('button');
    photoBtn.id = 'photoBtn';
    photoBtn.textContent = 'Foto';
    photoBtn.title = 'Scatta o scegli dalla galleria';
    photoBtn.style.marginLeft = '6px';
    els.composer.appendChild(photoBtn);

    // due input invisibili: camera & galleria
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

    // --- Mini-menu Scatta / Galleria ---
    els.composer.style.position = 'relative'; // per posizionare il menu

    const menu = document.createElement('div');
    menu.className = 'photo-menu hidden';
    menu.innerHTML = `
      <button type="button" data-act="camera">Scatta</button>
      <button type="button" data-act="gallery">Galleria</button>
    `;
    els.composer.appendChild(menu);

    photoBtn.addEventListener('click', (e)=>{
      e.preventDefault();
      // mostra il menu centrato
      menu.classList.remove('hidden');
      menu.style.left = '50%';
      menu.style.top = '50%';
      menu.style.transform = 'translate(-50%, -50%)';
    });

    // azioni menu
    menu.addEventListener('click', (e)=>{
      const act = e.target?.getAttribute('data-act');
      if (act === 'camera') cameraInput.click();
      if (act === 'gallery') galleryInput.click();
      menu.classList.add('hidden');
    });

    // chiudi se clicchi fuori
    document.addEventListener('click', (e)=>{
      if (!menu.contains(e.target) && e.target !== photoBtn) {
        menu.classList.add('hidden');
      }
    });

    cameraInput.addEventListener('change', ()=> handleFile(cameraInput.files && cameraInput.files[0]));
    galleryInput.addEventListener('change', ()=> handleFile(galleryInput.files && galleryInput.files[0]));
  }

  async function handleFile(file){
    if (!file) return;
    if (!isConnected) return alert('Non connesso');
    if (!e2e.ready) return alert('Scambio chiavi incompleto: premi "Avvia sessione" o attendi la chiave del peer.');
    try{
      const img = await blobToImage(file);

      // invio robusto con retry su cifratura
      let { b64, width, height, blob } = await adaptAndEncodeImage(img);
      try {
        const { iv, ct } = await e2e.encrypt(b64);
        if (ws && ws.readyState === 1){
          ws.send(JSON.stringify({ type:'image', iv, ct, mime:'image/jpeg', w:width, h:height }));
        }
        const url = URL.createObjectURL(blob);
        addImage(url, 'me');
      } catch (err) {
        // encrypt/JSON troppo pesante → riprova molto più piccolo
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

  // ===== AUDIO: registra e invia (pulsanti Rec/Stop, limite 60s) — NUOVO =====
  let mediaStream = null;
  let mediaRecorder = null;
  let audioChunks = [];
  let audioMime = 'audio/webm;codecs=opus';
  let audioTimer = null; // timer limite

  function pickBestAudioMime(){
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/mpeg'
    ];
    for (const c of candidates) {
      try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c; } catch {}
    }
    return 'audio/webm;codecs=opus';
  }

  async function ensureAudioControls(){
    if (!els.composer || document.getElementById('recBtn')) return;

    const recBtn  = document.createElement('button');
    recBtn.id = 'recBtn';
    recBtn.textContent = 'Rec';
    recBtn.title = 'Inizia registrazione';
    recBtn.style.marginLeft = '6px';

    const stopBtn = document.createElement('button');
    stopBtn.id = 'stopBtn';
    stopBtn.textContent = 'Stop';
    stopBtn.title = 'Ferma e invia';
    stopBtn.style.marginLeft = '6px';
    stopBtn.disabled = true;

    els.composer.appendChild(recBtn);
    els.composer.appendChild(stopBtn);

    recBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!isConnected) return alert('Non connesso');
      if (!e2e.ready)   return alert('Scambio chiavi incompleto: premi "Avvia sessione".');

      try {
        // prepara stream e recorder
        mediaStream?.getTracks()?.forEach(t => t.stop());
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];
        audioMime = pickBestAudioMime();
        mediaRecorder = new MediaRecorder(mediaStream, { mimeType: audioMime });

        mediaRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) audioChunks.push(ev.data); };

        mediaRecorder.onstop = async () => {
          clearTimeout(audioTimer);   // ferma timer
          audioTimer = null;

          try {
            const blob = new Blob(audioChunks, { type: audioMime.split(';')[0] });
            // preview locale subito
            const localUrl = URL.createObjectURL(blob);
            addAudio(localUrl, 'me', audioMime);

            // invio (base64 cifrato E2E)
            const b64 = await blobToBase64(blob);
            const { iv, ct } = await e2e.encrypt(b64);
            if (ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ type:'audio', iv, ct, mime: audioMime }));
            }
          } catch (err) {
            console.error('Errore invio audio:', err);
            alert('Errore invio audio: ' + (err && err.message ? err.message : err));
          } finally {
            // chiudi lo stream microfono
            try { mediaStream?.getTracks()?.forEach(t => t.stop()); } catch {}
            mediaStream = null;
            mediaRecorder = null;
            audioChunks = [];
            recBtn.disabled  = false;
            stopBtn.disabled = true;
          }
        };

        mediaRecorder.start(); // nessun timeslice: invia tutto alla fine

        // attiva timer 60s (stop automatico + invio)
        audioTimer = setTimeout(() => {
          if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
            alert('Registrazione interrotta: limite 60s raggiunto');
          }
        }, 60 * 1000);

        recBtn.disabled  = true;
        stopBtn.disabled = false;
      } catch (err) {
        console.error('Errore Rec:', err);
        alert('Permesso microfono negato o non disponibile.');
        try { mediaStream?.getTracks()?.forEach(t => t.stop()); } catch {}
        mediaStream = null;
        mediaRecorder = null;
        audioChunks = [];
        recBtn.disabled  = false;
        stopBtn.disabled = true;
      }
    });

    stopBtn.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop(); // scatena onstop => cifra + invia
        }
      } catch {}
    });
  }

  // ===== Riconnessione quando torni in foreground =====
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!ws || ws.readyState !== 1)) connect();
  });

  // ===== AUTO START =====
  (async function autoStart() {
    await ensureKeys();
    connect();
    // crea i controlli foto & audio (accanto a "Invia") solo a pagina pronta
    ensurePhotoControls();   // originale
    ensureAudioControls();   // NUOVO
  })();

});
