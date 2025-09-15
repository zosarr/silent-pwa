import {E2E} from './crypto.js';
import {STRINGS, applyLang} from './i18n.js';

// === CONFIG: imposta qui il tuo WS (puoi sovrascrivere con ?ws=...) ===
const AUTO_WS_URL = 'wss://silent-backend.onrender.com/ws?room=test';

let ws = null;
let e2e = new E2E();
let isConnecting = false;
let isConnected = false;
let reconnectTimer = null;

const els = {
  log: document.getElementById('log'),
  input: document.getElementById('msgInput'),
  sendBtn: document.getElementById('sendBtn'),
  myPub: document.getElementById('myPub'),
  peerPub: document.getElementById('peerPub'),
  startSessionBtn: document.getElementById('startSessionBtn'),
  clearBtn: document.getElementById('clearBtn'),
  installBtn: document.getElementById('installBtn'),
  langSelect: document.getElementById('langSelect'),
  copyMyPubBtn: document.getElementById('copyMyPubBtn'),
};

// i18n
const preferred = (navigator.language || 'it').startsWith('it') ? 'it' : 'en';
els.langSelect.value = preferred;
applyLang(preferred);
els.langSelect.addEventListener('change', e=>applyLang(e.target.value));

// PWA install
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault(); deferredPrompt = e;
  els.installBtn.style.display = 'inline-block';
});
els.installBtn.addEventListener('click', async ()=>{
  if(!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  els.installBtn.style.display = 'none';
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// UI helpers
function addMsg(text, kind='server'){
  const li = document.createElement('li');
  li.className = 'msg ' + (kind==='me'?'me':'other');
  li.innerHTML = `<div>${escapeHtml(text)}</div><div class="meta">${new Date().toLocaleTimeString()}</div>`;
  els.log.appendChild(li);
  els.log.scrollTop = els.log.scrollHeight;
  setTimeout(()=>li.remove(), 5 * 60 * 1000); // autodistruzione 5 min
}
function escapeHtml(s){ return s.replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m])); }
function setStatus(labelKey){
  const box = document.getElementById('connStatus');
  if (!box) return;
  if (labelKey === 'connected') {
    box.textContent = 'Connesso';
    box.classList.remove('disconnected');
    box.classList.add('connected');
  } else if (labelKey === 'disconnected') {
    box.textContent = 'Non connesso';
    box.classList.remove('connected');
    box.classList.add('disconnected');
  } else if (labelKey === 'ready') {
    box.textContent = 'Sessione pronta';
    box.classList.remove('disconnected');
    box.classList.add('connected');
  }
}

// E2E init
(async ()=>{
  const myPubB64 = await e2e.init();
  els.myPub.value = myPubB64;
})();

// Copy my public key
els.copyMyPubBtn.addEventListener('click', async ()=>{
  const key = els.myPub.value.trim();
  if (!key) return;
  try {
    await navigator.clipboard.writeText(key);
    addMsg('Chiave copiata negli appunti ✅', 'server');
  } catch {
    els.myPub.select();
    document.execCommand('copy');
    addMsg('Chiave copiata (fallback) ✅', 'server');
  }
});

// Start session (set peer key)
els.startSessionBtn.addEventListener('click', async ()=>{
  const base64 = els.peerPub.value.trim();
  if(!base64) return alert('Incolla la chiave pubblica del peer');
  try{
    await e2e.setPeerPublicKey(base64);
    setStatus('ready'); // NON rimuovere
    sendJson({type:'pubkey', pub: els.myPub.value});
  }catch(err){
    alert('Errore sessione: ' + err.message);
  }
});

// Auto-connect on load + reconnect
function connect(url){
  if (isConnected || isConnecting) return;

  if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
    try { ws.close(1000, 'reconnect'); } catch {}
  }
  try {
    isConnecting = true;
    ws = WebSocket(url);

    ws.onopen = ()=>{
      clearTimeout(reconnectTimer); reconnectTimer = null;
      isConnecting = false; isConnected = true;
      setStatus('connected'); // solo box, niente chat
      sendJson({type:'pubkey', pub: els.myPub.value});
    };

    ws.onmessage = async (ev)=>{
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'pubkey' && data.pub) {
          if (!e2e.ready) {
            try { await e2e.setPeerPublicKey(data.pub); setStatus('ready'); }
            catch(ex){ console.warn('Peer pubkey error', ex); }
          }
        } else if (data.type === 'msg' && data.iv && data.ct) {
          if (!e2e.ready) { /* niente messaggi di stato in chat */ return; }
          const plain = await e2e.decrypt(data.iv, data.ct);
          addMsg(plain, 'other');
        } else if (typeof data === 'string') {
          addMsg(data, 'other');
        }
      } catch {
        addMsg(ev.data, 'other');
      }
    };

    ws.onerror = ()=>{
      // niente addMsg di errore in chat; aggiorniamo solo lo stato
      setStatus('disconnected');
    };

    ws.onclose = ()=>{
      isConnected = false; isConnecting = false;
      setStatus('disconnected');
      scheduleReconnect();
    };
  } catch (e) {
    isConnecting = false;
    setStatus('disconnected');
    scheduleReconnect();
  }
}

function scheduleReconnect(delay=4000){
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(()=>{
    reconnectTimer = null;
    connect(getWsUrl());
  }, delay);
}

function getWsUrl(){
  // override via query string: ?ws=wss://.../ws?room=xyz
  const params = new URLSearchParams(location.search);
  const override = params.get('ws');
  const url = (override && /^wss?:\/\//i.test(override)) ? override : AUTO_WS_URL;
  return url;
}

// avvia connessione automatica quando la pagina è pronta
window.addEventListener('load', ()=> {
  connect(getWsUrl());
});

// invio messaggi cifrati
els.sendBtn.addEventListener('click', async ()=>{
  const text = els.input.value.trim();
  if(!text) return;
  if(!ws || ws.readyState !== 1) return alert('Non connesso');
  if(!e2e.ready) return alert('Sessione non pronta: scambia le chiavi pubbliche');

  const {iv, ct} = await e2e.encrypt(text);
  sendJson({type:'msg', iv, ct});
  addMsg(text, 'me');
  els.input.value = '';
});

function sendJson(obj){
  if(ws && ws.readyState === 1){
    ws.send(JSON.stringify(obj));
  }
}

// pulisci chat
els.clearBtn.addEventListener('click', ()=>{ els.log.innerHTML = ''; });
