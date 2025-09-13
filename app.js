import {E2E} from './crypto.js';
import {STRINGS, applyLang} from './i18n.js';

// === CONFIG: imposta qui il tuo WS (puoi sovrascrivere con ?ws=...) ===
const AUTO_WS_URL = 'wss://silent-backend.onrender.com/ws?room=test';

let ws = null;
let e2e = new E2E();
let isConnecting = false;
let isConnected = false;
let reconnectTimer = null;

// MediaRecorder stato
let mediaStream = null;
let mediaRecorder = null;
let audioChunks = [];
let recStart = 0;

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
  // nuovi
  recBtn: document.getElementById('recBtn'),
  stopRecBtn: document.getElementById('stopRecBtn'),
  recStatus: document.getElementById('recStatus')
};

function escapeHtml(s){ return s.replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }

// I18N
els.langSel.addEventListener('change', ()=> applyLang(els.langSel.value));
applyLang('it');

// Service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}

// Setup initial WS URL
const qs = new URLSearchParams(location.search);
els.wsUrl.value = qs.get('ws') || AUTO_WS_URL;

function setStatus(txt, kind='neutral'){
  els.status.textContent = txt;
  els.status.className = 'pill ' + kind;
}

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
  // auto-distruzione dopo 5 minuti
  setTimeout(()=>{
    URL.revokeObjectURL(url);
    wrap.remove();
  }, 5*60*1000);
}

async function ensureKeys(){
  if (!e2e.myPubRaw) {
    const pub = await e2e.init();
    els.myPub.value = pub;
    const fp = await e2e.myFingerprintHex();
    els.fingerprint.textContent = fp.slice(0,12);
  }
}

function connect(){
  if (isConnecting || isConnected) return;
  const url = els.wsUrl.value.trim();
  if (!url.startsWith('ws')) { alert('URL WS non valido'); return; }
  isConnecting = true;
  setStatus('…', 'neutral');
  ws = new WebSocket(url);
  ws.addEventListener('open', ()=>{
    isConnecting = false; isConnected = true;
    setStatus(STRINGS[els.langSel.value].status_connected, 'ok');
  });
  ws.addEventListener('close', ()=>{
    isConnected = false; isConnecting = false;
    setStatus(STRINGS[els.langSel.value].status_disconnected, 'warn');
    if (reconnectTimer) clearTimeout(reconnectTimer);
  });
  ws.addEventListener('message', async (ev)=>{
    try{
      const msg = JSON.parse(ev.data);
      if (msg.type === 'ping') return;
      if (msg.type === 'key'){
        await ensureKeys();
        await e2e.setPeerPublicKey(msg.raw);
        setStatus(STRINGS[els.langSel.value].status_ready, 'ok');
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

els.connectBtn.addEventListener('click', async ()=>{
  connect();
  await ensureKeys();
  // invia subito la mia chiave appena connesso
  const sendKeyWhenReady = ()=>{
    if (ws && ws.readyState === 1){
      ws.send(JSON.stringify({type:'key', raw: els.myPub.value}));
    } else {
      setTimeout(sendKeyWhenReady, 300);
    }
  };
  sendKeyWhenReady();
});

els.startSession.addEventListener('click', async ()=>{
  await ensureKeys();
  const peerRaw = els.peerPub.value.trim();
  if (!peerRaw) return alert('Incolla la chiave del peer');
  await e2e.setPeerPublicKey(peerRaw);
  if (ws && ws.readyState === 1){
    ws.send(JSON.stringify({type:'key', raw: els.myPub.value}));
  }
  setStatus(STRINGS[els.langSel.value].status_ready, 'ok');
});

els.sendBtn.addEventListener('click', async ()=>{
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
els.input.addEventListener('keydown', (e)=>{
  if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); els.sendBtn.click(); }
});

// pulisci chat
els.clearBtn.addEventListener('click', ()=>{ els.log.innerHTML = ''; });

/* ======================
   Registrazioni vocali
   ====================== */
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
  els.recBtn.disabled = recording;
  els.stopRecBtn.disabled = !recording;
  els.recStatus.textContent = recording ? 'REC…' : '';
  els.recStatus.className = 'pill ' + (recording ? 'warn' : 'neutral');
}

els.recBtn.addEventListener('click', async ()=>{
  if (!isConnected) return alert('Non connesso');
  if (!e2e.ready) return alert('Sessione E2E non attiva');

  await ensureMic();
  audioChunks = [];
  mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm;codecs=opus' });
  mediaRecorder.ondataavailable = (e)=>{ if (e.data && e.data.size) audioChunks.push(e.data); };
  mediaRecorder.onstop = async ()=>{
    try{
      const blob = new Blob(audioChunks, { type: 'audio/webm;codecs=opus' });
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
    }
  };
  recStart = Date.now();
  mediaRecorder.start();
  setRecUi(true);
});

els.stopRecBtn.addEventListener('click', ()=>{
  if (mediaRecorder && mediaRecorder.state !== 'inactive'){
    mediaRecorder.stop();
  }
});
