import {E2E} from './crypto.js';
import {STRINGS, applyLang} from './i18n.js';

let ws = null;
let e2e = new E2E();
let isConnecting = false;
let isConnected = false;

const els = {
  wsUrl: document.getElementById('wsUrl'),
  connectBtn: document.getElementById('connectBtn'),
  disconnectBtn: document.getElementById('disconnectBtn'),
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
  // bump cache version nel sw quando cambi (vedi sw.js)
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
  const map = STRINGS[els.langSelect.value];
  addMsg(map[`status_${labelKey}`] || labelKey, 'server');
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
    // fallback
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
    setStatus('ready');
    sendJson({type:'pubkey', pub: els.myPub.value});
  }catch(err){
    alert('Errore sessione: ' + err.message);
  }
});

// Connect (anti-duplicati)
els.connectBtn.addEventListener('click', ()=>{
  const url = els.wsUrl.value.trim();
  if(!url) return alert('URL WebSocket vuoto');
  if(!/^wss?:\/\//i.test(url)) return alert('L’URL deve iniziare con ws:// o wss://');

  // evita connessioni multiple
  if (isConnected || isConnecting) return;

  // chiudi eventuale socket precedente ancora aperto
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
    try { ws.close(1000, 'reconnect'); } catch {}
  }

  try {
    isConnecting = true;
    els.connectBtn.disabled = true;

    ws = new WebSocket(url);

    ws.onopen = () => {
      isConnecting = false;
      isConnected = true;
      setStatus('connected');
      sendJson({type:'pubkey', pub: els.myPub.value});
    };

    ws.onmessage = async (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'pubkey' && data.pub) {
          if (!e2e.ready) {
            try { await e2e.setPeerPublicKey(data.pub); setStatus('ready'); }
            catch(ex){ console.warn('Peer pubkey error', ex); }
          }
        } else if (data.type === 'msg' && data.iv && data.ct) {
          if (!e2e.ready) { addMsg('[Encrypted] In attesa chiave…'); return; }
          const plain = await e2e.decrypt(data.iv, data.ct);
          addMsg(plain, 'other');
        } else if (typeof data === 'string') {
          addMsg(data, 'other'); // fallback (echo server)
        }
      } catch {
        addMsg(ev.data, 'other');
      }
    };

    ws.onerror = (ev) => {
      console.error('WS error', ev);
      addMsg('Errore WebSocket (vedi console).', 'server');
    };

    ws.onclose = (ev) => {
      isConnected = false;
      isConnecting = false;
      els.connectBtn.disabled = false;
      setStatus('disconnected');
    };

  } catch (e) {
    isConnecting = false;
    els.connectBtn.disabled = false;
    alert('Errore creando WebSocket: ' + e.message);
  }
});

// Disconnect
els.disconnectBtn.addEventListener('click', ()=>{
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
    ws.close(1000, 'manual');
  }
});

// Send encrypted message
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

// Clear chat
els.clearBtn.addEventListener('click', ()=>{ els.log.innerHTML = ''; });
