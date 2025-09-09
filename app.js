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
  imgInput: document.getElementById('imgInput'),
  sendImgBtn: document.getElementById('sendImgBtn'),
  imgPreviewDlg: document.getElementById('imgPreviewDlg'),
  imgPreview: document.getElementById('imgPreview'),
  confirmSendImg: document.getElementById('confirmSendImg'),
  cancelSendImg: document.getElementById('cancelSendImg'),

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
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

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
function addImageFromBlob(blob, kind='other'){
  const li = document.createElement('li');
  li.className = 'msg ' + (kind==='me'?'me':'other');
  const url = URL.createObjectURL(blob);
  const img = document.createElement('img');
  img.src = url;
  img.alt = 'Immagine';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = new Date().toLocaleTimeString();
  li.appendChild(img); li.appendChild(meta);
  els.log.appendChild(li); els.log.scrollTop = els.log.scrollHeight;
  setTimeout(()=>{ URL.revokeObjectURL(url); li.remove(); }, 5*60*1000);
}
function utf8(s){ return new TextEncoder().encode(s); }
function concatU8(...arrays){
  let len = arrays.reduce((a,b)=>a + b.length, 0);
  let out = new Uint8Array(len); let off=0;
  for (const a of arrays){ out.set(a, off); off += a.length; }
  return out;
}

// Format:
// [0..3]  'SIMG' (53 49 4D 47)
// [4]     version (1)
// [5]     ivLen (12)
// [6]     mimeLen (uint8)
// [7..8]  nameLen (uint16 BE)
// [9..12] payloadLen (uint32 BE)
// [..]    iv | mimeUtf8 | nameUtf8 | ciphertext
function buildImagePacket(ivU8, mimeStr, nameStr, cipherU8){
  const magic = utf8('SIMG'); // 4 bytes
  const ver = new Uint8Array([1]);
  const ivLen = new Uint8Array([ivU8.length]);
  const mimeU8 = utf8(mimeStr || '');
  const mimeLen = new Uint8Array([mimeU8.length]);
  const nameU8 = utf8(nameStr || '');
  const nameLen = new Uint8Array([(nameU8.length>>8)&0xff, nameU8.length&0xff]);
  const payLen = new Uint8Array([
    (cipherU8.length>>>24)&0xff, (cipherU8.length>>>16)&0xff,
    (cipherU8.length>>>8)&0xff, cipherU8.length&0xff
  ]);
  return concatU8(magic, ver, ivLen, mimeLen, nameLen, payLen, ivU8, mimeU8, nameU8, cipherU8).buffer;
}

function parseImagePacket(ab){
  const u = new Uint8Array(ab);
  if (u.length < 13) return null;
  if (String.fromCharCode(u[0],u[1],u[2],u[3]) !== 'SIMG') return null;
  const ver = u[4]; if (ver !== 1) return null;
  const ivLen = u[5];
  const mimeLen = u[6];
  const nameLen = (u[7]<<8) | u[8];
  const payLen = (u[9]<<24) | (u[10]<<16) | (u[11]<<8) | u[12];

  let p = 13;
  const iv = u.slice(p, p+ivLen); p += ivLen;
  const mime = new TextDecoder().decode(u.slice(p, p+mimeLen)); p += mimeLen;
  const name = new TextDecoder().decode(u.slice(p, p+nameLen)); p += nameLen;
  const ct = u.slice(p, p+payLen).buffer;

  return { iv, mime, name, ct };
}
async function compressImageToBlob(file, maxSide=1280, quality=0.8){
  const img = await new Promise((res,rej)=>{
    const fr = new FileReader();
    fr.onload = ()=>{ const im = new Image(); im.onload = ()=>res(im); im.onerror = rej; im.src = String(fr.result); };
    fr.onerror = rej; fr.readAsDataURL(file);
  });
  const canvas = document.createElement('canvas');
  let {width, height} = img;
  if (width > height) {
    if (width > maxSide) { height = Math.round(height * (maxSide/width)); width = maxSide; }
  } else {
    if (height > maxSide) { width = Math.round(width * (maxSide/height)); height = maxSide; }
  }
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, width, height);
  const mime = 'image/jpeg'; // uniformiamo
  const blob = await new Promise(res => canvas.toBlob(res, mime, quality));
  return blob; // Blob JPEG compresso
}
let _pendingImage = null;

// apri selettore
els.sendImgBtn.addEventListener('click', ()=> els.imgInput.click());

// dopo selezione file, mostra anteprima
els.imgInput.addEventListener('change', async (ev)=>{
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;

  try{
    const blob = await compressImageToBlob(file, 1280, 0.8);
    _pendingImage = { blob, name: file.name || 'image.jpg', mime: 'image/jpeg' };
    els.imgPreview.src = URL.createObjectURL(blob);
    els.imgPreviewDlg.showModal();
  }catch(err){
    alert('Errore preparazione immagine: '+err.message);
    _pendingImage = null;
  }
});

// annulla
els.cancelSendImg.addEventListener('click', ()=>{
  if (els.imgPreview.src) URL.revokeObjectURL(els.imgPreview.src);
  els.imgPreview.src = '';
  _pendingImage = null;
  els.imgPreviewDlg.close();
});

// conferma invio
els.confirmSendImg.addEventListener('click', async ()=>{
  if(!_pendingImage) return;
  if(!ws || ws.readyState !== 1){ alert('Non connesso'); return; }
  if(!e2e.ready){ alert('Sessione non pronta'); return; }

  try{
    const ab = await _pendingImage.blob.arrayBuffer();
    const {iv, ct} = await e2e.encryptBytes(ab); // cifriamo binario
    const packet = buildImagePacket(new Uint8Array(iv), _pendingImage.mime, _pendingImage.name, new Uint8Array(ct));
    ws.send(packet); // 🔥 invio binario

    // mostra subito nell'interfaccia
    addImageFromBlob(_pendingImage.blob, 'me');
  }catch(err){
    alert('Errore invio immagine: '+err.message);
  }finally{
    if (els.imgPreview.src) URL.revokeObjectURL(els.imgPreview.src);
    els.imgPreview.src = '';
    _pendingImage = null;
    els.imgPreviewDlg.close();
  }
});
ws.onmessage = async (ev)=>{
  // Se è binario, arriva come ArrayBuffer (grazie a ws.binaryType = 'arraybuffer')
  if (ev.data instanceof ArrayBuffer) {
    try{
      const parsed = parseImagePacket(ev.data);
      if (!parsed) return; // non è un nostro pacchetto SIMG
      if (!e2e.ready) return;

      const ptAb = await e2e.decryptBytes(parsed.iv, parsed.ct);
      const blob = new Blob([ptAb], { type: parsed.mime || 'image/jpeg' });
      addImageFromBlob(blob, 'other');
    }catch(ex){
      // ignora o log
      console.warn('Errore parsing/decrypt immagine', ex);
    }
    return;
  }

  // ...qui sotto resta la tua gestione attuale dei messaggi testuali JSON...
  try {
    const data = JSON.parse(ev.data);
    if (data.type === 'pubkey' && data.pub) {
      if (!e2e.ready) { try { await e2e.setPeerPublicKey(data.pub); setStatus('ready'); } catch(ex){} }
    } else if (data.type === 'msg' && data.iv && data.ct) {
      if (!e2e.ready) return;
      const plain = await e2e.decrypt(data.iv, data.ct);
      addMsg(plain, 'other');
    } else if (typeof data === 'string') {
      addMsg(data, 'other');
    }
  } catch {
    addMsg(ev.data, 'other');
  }
};


// pulisci chat
els.clearBtn.addEventListener('click', ()=>{ els.log.innerHTML = ''; });
