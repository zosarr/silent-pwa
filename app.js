import {E2E} from './crypto.js';
import {STRINGS, applyLang} from './i18n.js';

// === CONFIG: URL WS automatico (l'input verrà nascosto) ===
const AUTO_WS_URL = 'wss://silent-backend.onrender.com/ws?room=test';

let ws = null;
let e2e = new E2E();
let isConnecting = false;
let isConnected = false;

// Stato registrazione (usa pulsanti dedicati)
let mediaStream = null;
let mediaRecorder = null;
let audioChunks = [];
let recStart = 0;

// PWA install prompt
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

function escapeHtml(s){ return s.replace(/[&<>\"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;' }[m])); }

// I18N
els.langSel && els.langSel.addEventListener('change', ()=> applyLang(els.langSel.value));
applyLang('it');

// Service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}

// Setup initial WS URL (forzato) e nascondi la casella
const qs = new URLSearchParams(location.search);
const FORCED_WS = qs.get('ws') || AUTO_WS_URL;
if (els.wsUrl) { els.wsUrl.value = FORCED_WS; els.wsUrl.style.display = 'none'; }
if (els.connectBtn) els.connectBtn.style.display = 'none'; // no "Connetti" button

// ====== Stato connessione: testo grande + colori ======
function setConnState(connected){
  isConnected = !!connected;
  const txt = connected ? 'connesso' : 'non connesso';
  els.status.textContent = 'txt;
  els.status.className = 'pill';
  els.status.style.fontSize = '18px';
  els.status.style.fontWeight = '800';
  els.status.style.backgroundColor = connected ? '#16a34a' : '#dc2626'; // verde/rosso
  els.status.style.color = '#ffffff';
}
setConnState(false);

// ====== Tasto "Installa" in alto a destra ======
const headerRight = document.querySelector('header .right');
const installBtn = document.createElement('button');
installBtn.textContent = 'Installa';
installBtn.style.marginLeft = '8px';
installBtn.style.display = 'none';
headerRight && headerRight.appendChild(installBtn);

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

// ====== Sezione "Scambio chiavi": nascondi testi ======
const sessionSection = els.startSession && els.startSession.closest('section');
const sessionTitle = sessionSection ? sessionSection.querySelector('[data-i18n="session"]') : null;
const sessionHint  = sessionSection ? sessionSection.querySelector('[data-i18n="sessionHint"]') : null;
sessionTitle && (sessionTitle.style.display = 'none');
sessionHint  && (sessionHint.style.display  = 'none');

// Ri-apertura/chiusura sezione chiavi con doppio click sullo stato
function showSession(){ if(sessionSection){ sessionSection.style.display=''; } }
function hideSession(){ if(sessionSection){ sessionSection.style.display='none'; } }
els.status && els.status.addEventListener('dblclick', ()=>{
  if (!sessionSection) return;
  const hidden = sessionSection.style.display === 'none';
  hidden ? showSession() : hideSession();
});

// ====== Chat UI ======
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

// ====== E2E keys ======
async function ensureKeys(){
  if (!e2e.myPubRaw) {
    const pub = await e2e.init();
    els.myPub && (els.myPub.value = pub);
    if (els.fingerprint){
      const fp = await e2e.myFingerprintHex();
      els.fingerprint.textContent = fp.slice(0,12);
    }
  }
}

// ====== WebSocket ======
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
    }catch(e){ /* ignore */ }
  });
}

// Auto-connessione
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

// Avvia sessione: chiudi la sezione chiavi
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

// Invio testo
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

// Registrazione audio con pulsanti dedicati
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
