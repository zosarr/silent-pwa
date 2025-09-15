import {E2E} from './crypto.js';
import {STRINGS, applyLang} from './i18n.js';

window.addEventListener('DOMContentLoaded', () => {
  // ===== CONFIG =====
  const AUTO_WS_URL = 'wss://silent-backend.onrender.com/ws?room=test'; // puoi anche ometterlo: vedasi fallback dinamico

  let ws = null;
  let e2e = new E2E();
  let isConnecting = false;
  let isConnected = false;
  let reconnectTimer = null;
  let backoffMs = 2000;

  let mediaStream = null;
  let mediaRecorder = null;
  let audioChunks = [];
  let recStart = 0;

  let deferredPrompt = null;

  // ===== SAFE GETTERS =====
  const $ = (sel) => document.querySelector(sel);
  const els = {
    log: $('#log'),
    input: $('#msgInput'),
    sendBtn: $('#sendBtn'),
    myPub: $('#myPub'),
    peerPub: $('#peerPub'),
    startSession: $('#startSession'),
    connectBtn: $('#connectBtn'),
    status: $('#status'),
    fingerprint: $('#fingerprint'),
    langSel: $('#langSel'),
    clearBtn: $('#clearBtn'),
    wsUrl: $('#wsUrl'),
    recBtn: $('#recBtn'),
    stopRecBtn: $('#stopRecBtn'),
    connTitle: $('[data-i18n="connection"]')
  };

  // ===== BANNER ERRORE A SCHERMO =====
  let errBar = $('#wsErrorBar');
  if (!errBar) {
    errBar = document.createElement('div');
    errBar.id = 'wsErrorBar';
    errBar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9999;padding:8px 12px;background:#dc2626;color:#fff;font-weight:700;display:none;text-align:center;';
    document.body.appendChild(errBar);
  }
  function showError(msg) {
    console.error('[WS]', msg);
    errBar.textContent = msg;
    errBar.style.display = '';
  }
  function hideError() {
    errBar.style.display = 'none';
  }

  const qs = new URLSearchParams(location.search);

  // ===== UTIL =====
  function escapeHtml(s){
    return s ? s.replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])) : '';
  }
  function pickWsUrl(){
    // 1) priorità all’override via ?ws=
    const fromQs = qs.get('ws');
    if (fromQs && /^wss?:\/\//i.test(fromQs)) return fromQs;
    // 2) AUTO_WS_URL se valido
    if (AUTO_WS_URL && /^wss?:\/\//i.test(AUTO_WS_URL)) return AUTO_WS_URL;
    // 3) fallback dinamico: stesso host dell’app
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws?room=test`;
  }

  // ===== I18N & SW =====
  if (els.langSel) els.langSel.addEventListener('change', ()=> applyLang(els.langSel.value));
  applyLang('it');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }

  // ===== WS URL input & Connect button =====
  const FORCED_WS = pickWsUrl();
  if (els.wsUrl) { els.wsUrl.value = FORCED_WS; els.wsUrl.style.display = 'none'; }
  if (els.connectBtn) els.connectBtn.style.display = 'none';

  // ===== LABELS SOPRA ALLE CASELLE (senza toccare HTML) =====
  (function fixLabelsAbove(){
    if (els.myPub){
      const labelMy = (els.myPub.parentElement || document).querySelector('[data-i18n="myPub"]');
      if (labelMy && labelMy.nextSibling !== els.myPub){ labelMy.parentElement.insertBefore(labelMy, els.myPub); }
      if (labelMy){ labelMy.style.display='block'; labelMy.style.fontWeight='600'; labelMy.style.marginBottom='6px'; }
    }
    if (els.peerPub){
      const labelPeer = (els.peerPub.parentElement || document).querySelector('[data-i18n="peerPub"]');
      if (labelPeer && labelPeer.nextSibling !== els.peerPub){ labelPeer.parentElement.insertBefore(labelPeer, els.peerPub); }
      if (labelPeer){ labelPeer.style.display='block'; labelPeer.style.fontWeight='600'; labelPeer.style.marginBottom='6px'; }
    }
  })();

  // ===== STATO CONNESSIONE (in alto, verde/rosso) =====
  function setConnState(connected){
    isConnected = !!connected;
    const txt = connected ? 'connesso' : 'non connesso';
    const color = connected ? '#16a34a' : '#dc2626';
    if (els.connTitle){
      els.connTitle.textContent = `Connessione: ${txt}`;
      els.connTitle.style.color = color;
      els.connTitle.style.fontWeight = '700';
    }
    if (els.status){ els.status.style.display = 'none'; } // nascondi pill sotto
  }
  setConnState(false);

  // ===== TASTO INSTALLA (sempre presente) =====
  (function ensureInstallBtn(){
    let btn = $('#installBtn');
    const container = $('header .right') || $('header') || document.body;
    if (!btn){
      btn = document.createElement('button');
      btn.id = 'installBtn';
      btn.textContent = 'Installa';
      btn.style.marginLeft = '8px';
      container.appendChild(btn);
    }
    window.addEventListener('beforeinstallprompt', (e)=>{
      e.preventDefault();
      deferredPrompt = e; // prompt tenuto per il click utente
    });
    btn.addEventListener('click', async ()=>{
      if (deferredPrompt){
        deferredPrompt.prompt();
        try { await deferredPrompt.userChoice; } catch {}
        deferredPrompt = null;
        return;
      }
      const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
      if (isStandalone){ alert('L’app è già installata.'); }
      else if (isIOS){ alert('iPhone/iPad: 1) Condividi • 2) Aggiungi alla schermata Home.'); }
      else { alert('Apri il menu del browser → “Installa app” / “Aggiungi alla schermata Home”.'); }
    });
  })();

  // ===== CHAT UI =====
  function addMsg(text, who='peer'){
    if (!els.log) return;
    const el = document.createElement('div');
    el.className = 'msg ' + who;
    el.innerHTML = escapeHtml(text);
    els.log.appendChild(el);
    els.log.scrollTop = els.log.scrollHeight;
    setTimeout(()=> el.remove(), 5*60*1000);
  }
  function addAudioMsg(url, who='peer', durMs=null){
    if (!els.log) return;
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + who;
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = url;
    if (durMs) {
      const s = Math.round(durMs/1000);
      const meta = document.createElement('small');
      meta.textContent = ` ${s}s`;
      wrap.appendChild(meta);
    }
    wrap.appendChild(audio);
    els.log.appendChild(wrap);
    els.log.scrollTop = els.log.scrollHeight;
    setTimeout(()=>{ URL.revokeObjectURL(url); wrap.remove(); }, 5*60*1000);
  }
  function addImageMsg(url, who='peer'){
    if (!els.log) return;
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + who;
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'foto';
    img.style.maxWidth = '70%';
    img.style.borderRadius = '8px';
    wrap.appendChild(img);
    els.log.appendChild(wrap);
    els.log.scrollTop = els.log.scrollHeight;
    setTimeout(()=>{ URL.revokeObjectURL(url); wrap.remove(); }, 5*60*1000);
  }

  // ===== E2E =====
  async function ensureKeys(){
    if (!e2e.myPubRaw) {
      const pub = await e2e.init();
      if (els.myPub) els.myPub.value = pub;
      if (els.fingerprint){
        const fp = await e2e.myFingerprintHex();
        els.fingerprint.textContent = fp.slice(0,12);
      }
    }
  }

  // Copia chiave
  (function injectCopyMyKey(){
    if (!els.myPub) return;
    let btn = $('#copyMyKey');
    if (!btn){
      btn = document.createElement('button');
      btn.id = 'copyMyKey';
      btn.textContent = 'Copia chiave';
      btn.style.marginTop = '6px';
      btn.addEventListener('click', async ()=>{
        try{
          await navigator.clipboard.writeText(els.myPub.value || '');
          if (els.connTitle){ els.connTitle.textContent = 'Connessione: chiave copiata ✔'; setTimeout(()=> setConnState(isConnected), 1200); }
        }catch(e){ alert('Impossibile copiare: ' + e.message); }
      });
      els.myPub.parentElement && els.myPub.parentElement.insertBefore(btn, els.myPub.nextSibling);
    }
  })();

  // ===== WS =====
  function connect(){
    if (isConnecting || isConnected) return;
    const url = (els.wsUrl && els.wsUrl.value) || FORCED_WS;
    isConnecting = true;
    setConnState(false);
    hideError();

    console.log('[WS] connecting to:', url);
    try{
      ws = new WebSocket(url);
    }catch(e){
      isConnecting = false;
      showError('Errore iniziale WebSocket: ' + (e && e.message ? e.message : e));
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', ()=>{
      console.log('[WS] open');
      isConnecting = false;
      isConnected = true;
      backoffMs = 2000;
      setConnState(true);
      hideError();
    });

    ws.addEventListener('close', (ev)=>{
      console.warn('[WS] close', ev.code, ev.reason);
      isConnecting = false;
      isConnected = false;
      setConnState(false);
      const reason = humanCloseReason(ev);
      showError(`Connessione chiusa (${ev.code})${reason ? ': ' + reason : ''}`);
      scheduleReconnect();
    });

    ws.addEventListener('error', (ev)=>{
      console.error('[WS] error', ev);
      // alcuni browser danno solo "errore generico"
      showError('Errore WebSocket generico (controlla URL/SSL/Firewall)');
    });

    ws.addEventListener('message', async (ev)=>{
      try{
        const msg = JSON.parse(ev.data);
        if (msg.type === 'ping') return;
        if (msg.type === 'key'){
          await ensureKeys();
          await e2e.setPeerPublicKey(msg.raw);
          return;
        }
        if (msg.type === 'msg'){
          if (!e2e.ready) return;
          const plain = await e2e.decrypt(msg.iv, msg.ct);
          addMsg(plain, 'peer');
          return;
        }
        if (msg.type === 'audio'){
          if (!e2e.ready) return;
          const buf = await e2e.decryptBytes(msg.iv, msg.ct);
          const blob = new Blob([buf], { type: msg.mime || 'audio/webm;codecs=opus' });
          const url = URL.createObjectURL(blob);
          addAudioMsg(url, 'peer', msg.dur);
          return;
        }
        if (msg.type === 'image'){
          if (!e2e.ready) return;
          const buf = await e2e.decryptBytes(msg.iv, msg.ct);
          const blob = new Blob([buf], { type: msg.mime || 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          addImageMsg(url, 'peer');
          return;
        }
      }catch(e){
        console.error('[WS] message error', e);
      }
    });
  }

  function humanCloseReason(ev){
    // messaggi più chiari
    if (location.protocol === 'https:' && ((els.wsUrl && els.wsUrl.value.startsWith('ws://')))) {
      return 'Mixed Content: la pagina è HTTPS ma il WS è ws:// (usa wss://)';
    }
    if (ev.code === 1006) return 'Handshake fallito / TLS / server irraggiungibile';
    if (ev.code === 1000) return 'Chiusura normale';
    if (ev.code === 1001) return 'Server riavviato o pagina cambiata';
    return ev.reason || '';
  }

  function scheduleReconnect(){
    if (reconnectTimer) return;
    backoffMs = Math.min(backoffMs * 2, 15000);
    console.log('[WS] retry in', backoffMs, 'ms');
    reconnectTimer = setTimeout(()=>{ reconnectTimer=null; connect(); }, backoffMs);
  }

  // keep-alive ping (alcuni hosting chiudono se inattivo)
  setInterval(()=>{
    try{
      if (ws && ws.readyState === 1){
        ws.send(JSON.stringify({ type:'ping', t: Date.now() }));
      }
    }catch(_){}
  }, 25000);

  (async function autoStart(){
    await ensureKeys();
    connect();
    const sendKeyWhenReady = ()=>{
      if (ws && ws.readyState === 1){
        ws.send(JSON.stringify({type:'key', raw: els.myPub ? els.myPub.value : ''}));
      } else {
        setTimeout(sendKeyWhenReady, 300);
      }
    };
    sendKeyWhenReady();
  })();

  if (els.startSession) els.startSession.addEventListener('click', async ()=>{
    await ensureKeys();
    const peerRaw = els.peerPub && els.peerPub.value && els.peerPub.value.trim();
    if (!peerRaw) return alert('Incolla la chiave del peer');
    await e2e.setPeerPublicKey(peerRaw);
    if (ws && ws.readyState === 1){
      ws.send(JSON.stringify({type:'key', raw: els.myPub ? els.myPub.value : ''}));
    }
    const section = els.startSession.closest('section'); if (section) section.style.display='none';
  });

  if (els.sendBtn) els.sendBtn.addEventListener('click', async ()=>{
    if (!isConnected) return alert('Non connesso');
    if (!e2e.ready) return alert('Sessione E2E non attiva');
    const text = els.input && els.input.value ? els.input.value.trim() : '';
    if (!text) return;
    const {iv, ct} = await e2e.encrypt(text);
    if (ws && ws.readyState === 1){
      ws.send(JSON.stringify({type:'msg', iv, ct}));
    }
    addMsg(text, 'me');
    if (els.input) els.input.value = '';
  });

  if (els.input) els.input.addEventListener('keydown', (e)=>{
    if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); els.sendBtn && els.sendBtn.click(); }
  });

  if (els.clearBtn) els.clearBtn.addEventListener('click', ()=>{ if (els.log) els.log.innerHTML = ''; });

  // ===== AUDIO =====
  async function ensureMic(){
    if (mediaStream) return mediaStream;
    try{ mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true }); return mediaStream; }
    catch(err){ alert('Microfono non disponibile: ' + err.message); throw err; }
  }

  // Pulsanti media (se mancano li creo accanto al tasto Invia)
  function ensureMediaButtons(){
    const row = (els.sendBtn && els.sendBtn.parentElement) || (els.input && els.input.parentElement) || document.body;
    if (!$('#recBtn')){
      const b = document.createElement('button'); b.id='recBtn'; b.textContent='🎙️ Registra'; b.title='Registra audio'; row.appendChild(b); els.recBtn=b;
    }
    if (!$('#stopRecBtn')){
      const b = document.createElement('button'); b.id='stopRecBtn'; b.textContent='Stop'; b.title='Stop'; b.disabled=true; row.appendChild(b); els.stopRecBtn=b;
    }
    if (!$('#photoBtn')){
      const b = document.createElement('button'); b.id='photoBtn'; b.textContent='Foto'; b.title='Invia foto'; row.appendChild(b);
      attachPhotoHandlers(b);
    }
  }

  function attachPhotoHandlers(photoBtn){
    const cameraInput  = document.createElement('input');
    cameraInput.type = 'file'; cameraInput.accept = 'image/*'; cameraInput.capture = 'environment'; cameraInput.style.display='none';
    const galleryInput = document.createElement('input');
    galleryInput.type = 'file'; galleryInput.accept = 'image/*'; galleryInput.style.display='none';
    document.body.appendChild(cameraInput);
    document.body.appendChild(galleryInput);
    photoBtn.addEventListener('click', ()=>{
      const scatta = window.confirm('Scattare una foto?\nPremi "Annulla" per scegliere dalla galleria.');
      (scatta ? cameraInput : galleryInput).click();
    });
    const handleFile = async (file)=>{
      if (!file) return;
      if (!isConnected) return alert('Non connesso');
      if (!e2e.ready) return alert('Sessione E2E non attiva');
      try{
        const img = await blobToImage(file);
        const {blob, width, height} = await imageToJpegBlob(img, {maxW:1600, maxH:1600, quality:0.85});
        const buf = await blob.arrayBuffer();
        const {iv, ct} = await e2e.encryptBytes(buf);
        if (ws && ws.readyState === 1){
          ws.send(JSON.stringify({type:'image', iv, ct, mime:'image/jpeg', w:width, h:height}));
        }
        const url = URL.createObjectURL(blob);
        addImageMsg(url, 'me');
      }catch(err){ console.error(err); alert('Errore invio foto: ' + err.message); }
    };
    cameraInput.addEventListener('change', ()=> handleFile(cameraInput.files && cameraInput.files[0]));
    galleryInput.addEventListener('change', ()=> handleFile(galleryInput.files && galleryInput.files[0]));
  }

  function blobToImage(blob){
    return new Promise((resolve, reject)=>{
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = ()=>{ URL.revokeObjectURL(url); resolve(img); };
      img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('Immagine non valida')); };
      img.src = url;
    });
  }
  function imageToJpegBlob(img, {maxW=1600, maxH=1600, quality=0.85}={}){
    const {naturalWidth:w, naturalHeight:h} = img;
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

  ensureMediaButtons();

  // (re)wire audio
  els.stopRecBtn = $('#stopRecBtn');
  els.recBtn = $('#recBtn');
  if (els.recBtn && els.stopRecBtn){
    els.stopRecBtn.disabled = true;
    els.recBtn.addEventListener('click', async ()=>{
      if (!isConnected) return alert('Non connesso');
      if (!e2e.ready) return alert('Sessione E2E non attiva');
      await ensureMic();
      audioChunks = [];
      let mr;
      try{ mr = new MediaRecorder(mediaStream, { mimeType: 'audio/webm;codecs=opus' }); }
      catch{ try { mr = new MediaRecorder(mediaStream, { mimeType: 'audio/webm' }); }
             catch { mr = new MediaRecorder(mediaStream); } }
      mediaRecorder = mr;
      mediaRecorder.ondataavailable = (ev)=>{ if (ev.data && ev.data.size) audioChunks.push(ev.data); };
      mediaRecorder.onstop = async ()=>{
        try{
          const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
          const dur = Date.now() - recStart;
          const buf = await blob.arrayBuffer();
          const {iv, ct} = await e2e.encryptBytes(buf);
          if (ws && ws.readyState === 1){
            ws.send(JSON.stringify({type:'audio', iv, ct, mime: blob.type, dur}));
          }
          const url = URL.createObjectURL(blob);
          addAudioMsg(url, 'me', dur);
        }catch(err){ console.error(err); alert('Errore invio audio: ' + err.message); }
        finally{ els.recBtn.disabled=false; els.stopRecBtn.disabled=true; }
      };
      recStart = Date.now();
      mediaRecorder.start();
      els.recBtn.disabled = true;
      els.stopRecBtn.disabled = false;
    });
    els.stopRecBtn.addEventListener('click', ()=>{
      if (mediaRecorder && mediaRecorder.state !== 'inactive'){ mediaRecorder.stop(); }
    });
  }

  // Riconnessione al ritorno in foreground
  document.addEventListener('visibilitychange', ()=>{
    if (document.visibilityState === 'visible' && (!ws || ws.readyState !== 1)) connect();
  });
});

