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

  async function blobToImage(blob){
    return new Promise((resolve, reject)=>{
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = ()=>{ URL.revokeObjectURL(url); resolve(img); };
      img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('Immagine non valida')); };
      img.src = url;
    });
  }
  function imageToJpegBlob(img, {maxW=1600, maxH=1600, quality=0.85}={}){
    const w = img.naturalWidth, h = img.naturalHeight;
    const ratio = Math.min(maxW/w, maxH/h, 1);
    const nw = Math.round(w*ratio), nh = Math.round(h*ratio);
    const canvas = document.createElement('canvas');
    canvas.width = nw; canvas.height = nh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, nw, nh);
    return new Promise((resolve)=>{
      canvas.toBlob((b)=> resolve({blob:b, width:nw, height:nh}), 'image/jpeg', quality);
    });
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
      els.connTitle.textContent = `Connessione: ${txt}`;
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
        els.connTitle.textContent = 'Connessione: chiave copiata ✔';
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
      const myRaw = myPubExpected || (els.myPub?.value || '');
      try { ws.send(JSON.stringify({ type: 'key', raw: myRaw })); } catch {}
    });

    ws.addEventListener('close', (ev) => {
      console.warn('[WS] close', ev.code, ev.reason);
      isConnecting = false;
      setConnState(false);
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
            console.log('[E2E] ricevuta la mia chiave → ignoro');
            return;
          }

          // Evita reset inutili
          if (e2e.ready && e2e.peerPubRawB64 === peerRaw) return;

          try {
            await e2e.setPeerPublicKey(peerRaw);
            e2e.peerPubRawB64 = peerRaw;
            if (els.connTitle) els.connTitle.textContent = 'Connessione: connesso (E2E attiva)';
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
          const buf = await e2e.decryptBytes(msg.iv, msg.ct);
          const blob = new Blob([buf], { type: msg.mime || 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          addImage(url, 'peer');
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
    // crea i controlli foto (accanto a "Invia") solo a pagina pronta
    ensurePhotoControls();
  })();

  // ===== Avvia Sessione =====
  els.startBtn && els.startBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    await ensureKeys(); // NON rigenera più
    const peerRaw = (els.peerPub?.value || '').trim();
    if (!peerRaw) return alert('Incolla la chiave del peer');

    try {
      await e2e.setPeerPublicKey(peerRaw);   // ora e2e.ready = true
      e2e.peerPubRawB64 = peerRaw;          // memorizza per confronti futuri

      // reinvia la mia chiave, così il peer mi imposta
      if (ws && ws.readyState === 1) {
        const myRaw = myPubExpected || (els.myPub?.value || '');
        ws.send(JSON.stringify({ type: 'key', raw: myRaw }));
      }

      // chiudi il <details> "Scambio chiavi"
      const details = document.querySelector('details');
      if (details) details.open = false;

      if (els.connTitle) els.connTitle.textContent = 'Connessione: connesso (E2E attiva)';
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

    photoBtn.addEventListener('click', ()=>{
      const scatta = window.confirm('Scattare una foto?\nPremi "Annulla" per scegliere dalla galleria.');
      (scatta ? cameraInput : galleryInput).click();
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
      const {blob, width, height} = await imageToJpegBlob(img, {maxW:1600, maxH:1600, quality:0.85});
      const buf = await blob.arrayBuffer();
      const {iv, ct} = await e2e.encryptBytes(buf);
      if (ws && ws.readyState === 1){
        ws.send(JSON.stringify({type:'image', iv, ct, mime:'image/jpeg', w:width, h:height}));
      }
      const url = URL.createObjectURL(blob);
      addImage(url, 'me');
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
