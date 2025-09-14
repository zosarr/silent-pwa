import {E2E} from './crypto.js';
import {STRINGS, applyLang} from './i18n.js';

// === URL WebSocket (connessione automatica) ===
const AUTO_WS_URL = 'wss://silent-backend.onrender.com/ws?room=test';

let ws = null;
let e2e = new E2E();
let isConnecting = false;
let isConnected = false;

// Registrazione audio
let mediaStream = null;
let mediaRecorder = null;
let audioChunks = [];
let recStart = 0;

// PWA install
let deferredPrompt = null;

const els = {
  log: document.getElementById('log'),
  input: document.getElementById('msgInput'),
  sendBtn: document.getElementById('sendBtn'),
  myPub: document.getElementById('myPub'),
  peerPub: document.getElementById('peerPub'),
  startSession: document.getElementById('startSession'),
  connectBtn: document.getElementById('connectBtn'),
  status: document.getElementById('status'),
  fingerprint: document.getElementById('fingerprint'),
  langSel: document.getElementById('langSel'),
  clearBtn: document.getElementById('clearBtn'),
  wsUrl: document.getElementById('wsUrl'),
  recBtn: document.getElementById('recBtn'),
  stopRecBtn: document.getElementById('stopRecBtn')
};

// Riferimento al titolo "Connessione"
const connTitle = document.querySelector('[data-i18n="connection"]');

function escapeHtml(s){ return s.replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }

// I18N
els.langSel && els.langSel.addEventListener('change', ()=> applyLang(els.langSel.value));
applyLang('it');

// Service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}

// === Imposta e nascondi la casella URL WS (niente bottone "Connetti") ===
const qs = new URLSearchParams(location.search);
const FORCED_WS = qs.get('ws') || AUTO_WS_URL;
if (els.wsUrl) { els.wsUrl.value = FORCED_WS; els.wsUrl.style.display = 'none'; }
if (els.connectBtn) els.connectBtn.style.display = 'none';

// === Sposta le etichette SOPRA alle caselle (senza toccare l'HTML) ===
(function fixLabelsAbove(){
  if (els.myPub){
    const labelMy = (els.myPub.parentElement || document).querySelector('[data-i18n="myPub"]');
    if (labelMy && labelMy.nextSibling !== els.myPub){
      labelMy.parentElement.insertBefore(labelMy, els.myPub);
    }
    labelMy && (labelMy.style.display = 'block', labelMy.style.fontWeight = '600', labelMy.style.marginBottom = '6px');
  }
  if (els.peerPub){
    const labelPeer = (els.peerPub.parentElement || document).querySelector('[data-i18n="peerPub"]');
    if (labelPeer && labelPeer.nextSibling !== els.peerPub){
      labelPeer.parentElement.insertBefore(labelPeer, els.peerPub);
    }
    labelPeer && (labelPeer.style.display = 'block', labelPeer.style.fontWeight = '600', labelPeer.style.marginBottom = '6px');
  }
})();

// === Stato “connesso / non connesso”: verde/rosso accanto a "Connessione:" e rimuovi badge sotto ===
function setConnState(connected){
  isConnected = !!connected;
  const txt = connected ? 'connesso' : 'non connesso';
  const color = connected ? '#16a34a' : '#dc2626';

  // titolo con i due punti e lo stato colorato
  if (connTitle){
    connTitle.textContent = `Connessione: ${txt}`;
    connTitle.style.color = color;          // colore della scritta in alto
    connTitle.style.fontWeight = '700';
  }

  // nascondi completamente il badge di stato sotto
  if (els.status){
    els.status.style.display = 'none';
  }
}
setConnState(false);

// === Tasto “Installa” in alto a destra — sempre visibile ===
const headerRight = document.querySelector('header .right');
const installBtn = document.createElement('button');
installBtn.textContent = 'Installa';
installBtn.style.marginLeft = '8px';
installBtn.style.display = '';  // mostra sempre
if (headerRight) headerRight.appendChild(installBtn);

window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredPrompt = e;
});
installBtn.addEventListener('click', async ()=>{
  // Se Chrome/Android fornisce il prompt nativo
  if (deferredPrompt){
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch {}
    deferredPrompt = null;
    return;
  }
  // iOS/Safari o quando il prompt non è disponibile: istruzioni rapide
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isStandalone){
    alert('L’app è già installata.');
  } else if (isIOS){
    alert('Su iPhone/iPad: 1) Tocca • Condividi • 2) "Aggiungi alla schermata Home".');
  } else {
    alert('Se non vedi il prompt, usa il menu del browser per "Installa app" o "Aggiungi alla schermata Home".');
  }
});

// === Sezione “Scambio chiavi”: nascondi SOLO le frasi; chiudi dopo avvio; riapribile col doppio click sullo stato ===
const sessionSection = els.startSession && els.startSession.closest('section');
const sessionTitle = sessionSection ? sessionSection.querySelector('[data-i18n="session"]') : null;
const sessionHint  = sessionSection ? sessionSection.querySelector('[data-i18n="sessionHint"]') : null;
if (sessionTitle) sessionTitle.style.display = 'none';
if (sessionHint)  sessionHint.style.display  = 'none';

function showSession(){ if(sessionSection) sessionSection.style.display=''; }
function hideSession(){ if(sessionSection) sessionSection.style.display='none'; }
connTitle && connTitle.addEventListener('dblclick', ()=>{
  if (!sessionSection) return;
  const hidden = sessionSection.style.display === 'none';
  hidden ? showSession() : hideSession();
});

// === Chat UI ===
function addMsg(text, who='peer'){
  const el = document.createElement('div');
  el.className = 'msg ' + who;
  el.innerHTML = escapeHtml(text);
  els.log.appendChild(el);
  els.log.scrollTop = els.log.scrollHeight;
  setTimeout(()=> el.remove(), 5*60*1000);
}
function addAudioMsg(url, who='peer', durMs=null){
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

// === E2E ===
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

// === Bottone “Copia chiave” sotto la mia casella (senza cambiare HTML) ===
(function injectCopyMyKey(){
  if (!els.myPub) return;
  const btn = document.createElement('button');
  btn.id = 'copyMyKey';
  btn.textContent = 'Copia chiave';
  btn.style.marginTop = '6px';
  btn.addEventListener('click', async ()=>{
    try{
      await navigator.clipboard.writeText(els.myPub.value || '');
      const old = connTitle && connTitle.textContent;
      if (connTitle){
        connTitle.textContent = 'Connessione: chiave copiata ✔';
        setTimeout(()=> setConnState(isConnected), 1200);
      }
    }catch(e){ alert('Impossibile copiare: ' + e.message); }
  });
  els.myPub.parentElement && els.myPub.parentElement.insertBefore(btn, els.myPub.nextSibling);
})();

// === WebSocket ===
function connect(){
  if (isConnecting || isConnected) return;
  const url = FORCED_WS;
  isConnecting = true;
  setConnState(false);
  ws = new WebSocket(url);
  ws.addEventListener('open', ()=>{
    isConnecting = false;
    setConnState(true);
  });
  ws.addEventListener('close', ()=>{
    isConnecting = false;
    setConnState(false);
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
    }catch(e){ /* ignore */ }
  });
}

// === Auto-connessione + invio chiave mia quando pronto ===
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

// === Avvia sessione: chiudi sezione; riapri con doppio click sul titolo “Connessione” ===
els.startSession && els.startSession.addEventListener('click', async ()=>{
  await ensureKeys();
  const peerRaw = els.peerPub && els.peerPub.value.trim();
  if (!peerRaw) return alert('Incolla la chiave del peer');
  await e2e.setPeerPublicKey(peerRaw);
  if (ws && ws.readyState === 1){
    ws.send(JSON.stringify({type:'key', raw: els.myPub ? els.myPub.value : ''}));
  }
  hideSession();
});

// === Invio TESTO ===
els.sendBtn && els.sendBtn.addEventListener('click', async ()=>{
  if (!isConnected) return alert('Non connesso');
  if (!e2e.ready) return alert('Sessione E2E non attiva');
  const text = els.input.value.trim();
  if (!text) return;
  const {iv, ct} = await e2e.encrypt(text);
  if (ws && ws.readyState === 1){
    ws.send(JSON.stringify({type:'msg', iv, ct}));
  }
  addMsg(text, 'me');
  els.input.value = '';
});

// Enter to send
els.input && els.input.addEventListener('keydown', (e)=>{
  if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); els.sendBtn.click(); }
});

// pulisci chat
els.clearBtn && els.clearBtn.addEventListener('click', ()=>{ els.log.innerHTML = ''; });

// === AUDIO: pulsanti rec/stop dedicati ===
async function ensureMic(){
  if (mediaStream) return mediaStream;
  try{
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return mediaStream;
  }catch(err){
    alert('Microfono non disponibile: ' + err.message);
    throw err;
  }
}
function setRecUi(recording){
  const color = recording ? '#dc2626' : (isConnected ? '#16a34a' : '#dc2626');
  if (connTitle){
    connTitle.style.color = color;
    connTitle.textContent = recording ? 'Connessione: REC…' : `Connessione: ${isConnected ? 'connesso' : 'non connesso'}`;
  }
}
if (els.recBtn && els.stopRecBtn){
  els.stopRecBtn.disabled = true;
  els.recBtn.addEventListener('click', async ()=>{
    if (!isConnected) return alert('Non connesso');
    if (!e2e.ready) return alert('Sessione E2E non attiva');
    await ensureMic();
    audioChunks = [];
    let mime = 'audio/webm;codecs=opus';
    try{
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime });
    }catch{
      try { mime = 'audio/webm'; mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime }); }
      catch { mediaRecorder = new MediaRecorder(mediaStream); }
    }
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
      }catch(err){
        console.error(err);
        alert('Errore invio audio: ' + err.message);
      }finally{
        setRecUi(false);
        els.recBtn.disabled = false;
        els.stopRecBtn.disabled = true;
      }
    };
    recStart = Date.now();
    mediaRecorder.start();
    setRecUi(true);
    els.recBtn.disabled = true;
    els.stopRecBtn.disabled = false;
  });
  els.stopRecBtn.addEventListener('click', ()=>{
    if (mediaRecorder && mediaRecorder.state !== 'inactive'){
      mediaRecorder.stop();
    }
  });
}

// === FOTO: scelta tra SCATTA o GALLERIA (senza cambiare HTML) ===
(function injectPhotoControls(){
  if (!els.sendBtn) return;
  const photoBtn = document.createElement('button');
  photoBtn.id = 'photoBtn';
  photoBtn.textContent = 'Foto';
  photoBtn.style.marginLeft = '6px';
  els.sendBtn.parentElement && els.sendBtn.parentElement.appendChild(photoBtn);

  const cameraInput  = document.createElement('input');
  cameraInput.type = 'file'; cameraInput.accept = 'image/*'; cameraInput.capture = 'environment';
  cameraInput.style.display = 'none';
  const galleryInput = document.createElement('input');
  galleryInput.type = 'file'; galleryInput.accept = 'image/*';
  galleryInput.style.display = 'none';
  document.body.appendChild(cameraInput);
  document.body.appendChild(galleryInput);

  photoBtn.addEventListener('click', async ()=>{
    const scatta = window.confirm('Scattare una foto?\nPremi "Annulla" per scegliere dalla galleria.');
    (scatta ? cameraInput : galleryInput).click();
  });

  async function handleFile(file){
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
    }catch(err){
      console.error(err);
      alert('Errore invio foto: ' + err.message);
    }
  }

  cameraInput.addEventListener('change', ()=> handleFile(cameraInput.files && cameraInput.files[0]));
  galleryInput.addEventListener('change', ()=> handleFile(galleryInput.files && galleryInput.files[0]));

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
})();
