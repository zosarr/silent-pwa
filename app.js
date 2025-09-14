import {E2E} from './crypto.js';
import {STRINGS, applyLang} from './i18n.js';

// === URL WebSocket (connessione automatica) ===
const AUTO_WS_URL = 'wss://silent-backend.onrender.com/ws?room=test';

let ws = null;
let e2e = new E2E();
let isConnecting = false;
let isConnected = false;

// Registrazione audio (usa eventuali pulsanti esistenti: #recBtn, #stopRecBtn)
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

// === Stato “connesso / non connesso” grande e con colori ===
function setConnState(connected){
  isConnected = !!connected;
  els.status.textContent = connected ? 'connesso' : 'non connesso';
  els.status.className = 'pill';
  els.status.style.fontSize = '18px';
  els.status.style.fontWeight = '800';
  els.status.style.backgroundColor = connected ? '#16a34a' : '#dc2626'; // verde/rosso
  els.status.style.color = '#ffffff';
}
setConnState(false);

// === Tasto “Installa” in alto a destra (senza toccare l’HTML) ===
const headerRight = document.querySelector('header .right');
const installBtn = document.createElement('button');
installBtn.textContent = 'Installa';
installBtn.style.marginLeft = '8px';
installBtn.style.display = 'none';
if (headerRight) headerRight.appendChild(installBtn);

window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredPrompt = e;
  installBtn.style.display = '';
});
installBtn.addEventListener('click', async ()=>{
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  try { await deferredPrompt.userChoice; } catch {}
  deferredPrompt = null;
  installBtn.style.display = 'none';
});

// === Sezione “Scambio chiavi”: nascondi SOLO le frasi; chiudi alla partenza; riapri col doppio click sullo stato ===
const sessionSection = els.startSession && els.startSession.closest('section');
const sessionTitle = sessionSection ? sessionSection.querySelector('[data-i18n="session"]') : null;
const sessionHint  = sessionSection ? sessionSection.querySelector('[data-i18n="sessionHint"]') : null;
if (sessionTitle) sessionTitle.style.display = 'none';
if (sessionHint)  sessionHint.style.display  = 'none';

function showSession(){ if(sessionSection) sessionSection.style.display=''; }
function hideSession(){ if(sessionSection) sessionSection.style.display='none'; }
// Ri-apertura/chiusura con doppio click sull’etichetta di stato
els.status && els.status.addEventListener('dblclick', ()=>{
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

// === COPIA CHIAVE: bottone “Copia chiave” accanto alla mia casella (senza cambiare HTML) ===
(function injectCopyMyKey(){
  if (!els.myPub) return;
  const btn = document.createElement('button');
  btn.id = 'copyMyKey';
  btn.textContent = 'Copia chiave';
  btn.style.marginTop = '6px';
  btn.addEventListener('click', async ()=>{
    try{
      await navigator.clipboard.writeText(els.myPub.value || '');
      // feedback rapido sullo stato
      const old = els.status.textContent;
      els.status.textContent = 'copiata ✔';
      setTimeout(()=>{ els.status.textContent = old; setConnState(isConnected); }, 1200);
    }catch(e){ alert('Impossibile copiare: ' + e.message); }
  });
  // Inserisco subito dopo la textarea
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

// === Avvia sessione: chiudi sezione; riapri con doppio click sullo stato ===
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

// === Invio TESTO: il tasto Invia invia SOLO messaggi di testo ===
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

// === Registrazione AUDIO con pulsanti dedicati (recBtn / stopRecBtn) ===
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
  const baseTxt = isConnected ? 'connesso' : 'non connesso';
  els.status.textContent = recording ? 'REC…' : baseTxt;
  els.status.style.backgroundColor = recording ? '#dc2626' : (isConnected ? '#16a34a' : '#dc2626');
  els.status.style.color = '#ffffff';
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

// === FOTO: bottone “Foto” + uso camera (senza cambiare HTML) ===
(function injectPhotoControls(){
  if (!els.sendBtn) return;
  const photoBtn = document.createElement('button');
  photoBtn.id = 'photoBtn';
  photoBtn.textContent = 'Foto';
  photoBtn.style.marginLeft = '6px';
  els.sendBtn.parentElement && els.sendBtn.parentElement.appendChild(photoBtn);

  // input file nascosto: usa la camera se disponibile
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.capture = 'environment';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  photoBtn.addEventListener('click', ()=> fileInput.click());

  fileInput.addEventListener('change', async ()=>{
    if (!fileInput.files || !fileInput.files[0]) return;
    if (!isConnected) return alert('Non connesso');
    if (!e2e.ready) return alert('Sessione E2E non attiva');

    const file = fileInput.files[0];
    try{
      // carica immagine e ricomprimi a JPEG per contenere il peso
      const img = await blobToImage(file);
      const {blob, width, height} = await imageToJpegBlob(img, {maxW: 1600, maxH: 1600, quality: 0.85});
      const buf = await blob.arrayBuffer();
      const {iv, ct} = await e2e.encryptBytes(buf);
      if (ws && ws.readyState === 1){
        ws.send(JSON.stringify({type:'image', iv, ct, mime: 'image/jpeg', w: width, h: height}));
      }
      const url = URL.createObjectURL(blob);
      addImageMsg(url, 'me');
    }catch(err){
      console.error(err);
      alert('Errore invio foto: ' + err.message);
    }finally{
      fileInput.value = '';
    }
  });

  function blobToImage(blob){
    return new Promise((resolve, reject)=>{
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = ()=>{ URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (e)=>{ URL.revokeObjectURL(url); reject(new Error('Immagine non valida')); };
      img.src = url;
    });
  }
  function imageToJpegBlob(img, {maxW=1600, maxH=1600, quality=0.85}={}){
    const {naturalWidth:w, naturalHeight:h} = img;
    let nw=w, nh=h;
    const ratio = Math.min(maxW/w, maxH/h, 1);
    nw = Math.round(w*ratio); nh = Math.round(h*ratio);
    const canvas = document.createElement('canvas');
    canvas.width = nw; canvas.height = nh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, nw, nh);
    return new Promise((resolve)=>{
      canvas.toBlob((b)=> resolve({blob:b, width:nw, height:nh}), 'image/jpeg', quality);
    });
  }
})();
