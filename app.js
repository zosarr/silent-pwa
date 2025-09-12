import {E2E} from './crypto.js';
import {STRINGS, applyLang} from './i18n.js';

// === CONFIG ===
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
  setTimeout(()=>li.remove(), 5 * 60 * 1000);
}
function escapeHtml(s){ return s.replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[m])); }

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
    addMsg('Chiave copiata ✅', 'server');
  } catch {
    els.myPub.select();
    document.execCommand('copy');
    addMsg('Chiave copiata (fallback) ✅', 'server');
  }
});

// Start session (set peer key)
els.startSessionBtn.addEventListener('click', async ()=>{
  const base64 = els.peerPub.value.trim();
  if(!base64) return alert('Incolla la chiave utente');
  try{
    await e2e.setPeerPublicKey(base64);
    setStatus('ready');
    sendJson({type:'pubkey', pub: els.myPub.value});
  }catch(err){
    alert('Errore sessione: ' + err.message);
  }
});

// === WebSocket connect/reconnect ===
function connect(url){
  if (isConnected || isConnecting) return;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
    try { ws.close(1000, 'reconnect'); } catch {}
  }
  try {
    isConnecting = true;
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';   // per immagini

    ws.onopen = ()=>{
      clearTimeout(reconnectTimer); reconnectTimer = null;
      isConnecting = false; isConnected = true;
      setStatus('connected');
      sendJson({type:'pubkey', pub: els.myPub.value});
    };

    ws.onmessage = async (ev)=>{
      if (ev.data instanceof ArrayBuffer) {
        try{
          const parsed = parseImagePacket(ev.data);
          if (!parsed || !e2e.ready) return;
          const ptAb = await e2e.decryptBytes(parsed.iv, parsed.ct);
          const blob = new Blob([ptAb], { type: parsed.mime || 'image/jpeg' });
          addImageFromBlob(blob, 'other');
        }catch(ex){ console.warn('Errore immagine', ex); }
        return;
      }
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'pubkey' && data.pub) {
          if (!e2e.ready) {
            try { await e2e.setPeerPublicKey(data.pub); setStatus('ready'); } catch(ex){}
          }
        } else if (data.type === 'msg' && data.iv && data.ct) {
          if (!e2e.ready) return;
          const plain = await e2e.decrypt(data.iv, data.ct);
          addMsg(plain, 'other');
        }
      } catch { addMsg(ev.data, 'other'); }
    };

    ws.onerror = ()=> setStatus('disconnected');
    ws.onclose = ()=>{ isConnected=false; isConnecting=false; setStatus('disconnected'); scheduleReconnect(); };

  } catch (e) {
    isConnecting = false;
    console.error('New WebSocket exception', e);
    scheduleReconnect();
  }
}

function scheduleReconnect(delay=4000){
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(()=>{ reconnectTimer=null; connect(getWsUrl()); }, delay);
}

function getWsUrl(){
  const params = new URLSearchParams(location.search);
  const override = params.get('ws');
  const url = (override && /^wss?:\/\//i.test(override)) ? override : AUTO_WS_URL;
  return url;
}

window.addEventListener('load', ()=> connect(getWsUrl()));

// === INVIO TESTO ===
els.sendBtn.addEventListener('click', async ()=>{
  const text = els.input.value.trim();
  if(!text) return;
  if(!ws || ws.readyState !== 1) return alert('Non connesso');
  if(!e2e.ready) return alert('Sessione non pronta');
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

// === INVIO IMMAGINI ===
let _pendingImage = null;

els.sendImgBtn.addEventListener('click', ()=> els.imgInput.click());

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

els.cancelSendImg.addEventListener('click', ()=>{
  if (els.imgPreview.src) URL.revokeObjectURL(els.imgPreview.src);
  els.imgPreview.src = '';
  _pendingImage = null;
  els.imgPreviewDlg.close();
});

els.confirmSendImg.addEventListener('click', async ()=>{
  if(!_pendingImage) return;
  if(!ws || ws.readyState !== 1){ alert('Non connesso'); return; }
  if(!e2e.ready){ alert('Sessione non pronta'); return; }
  try{
    const ab = await _pendingImage.blob.arrayBuffer();
    const {iv, ct} = await e2e.encryptBytes(ab);
    const packet = buildImagePacket(new Uint8Array(iv), _pendingImage.mime, _pendingImage.name, new Uint8Array(ct));
    ws.send(packet);
    addImageFromBlob(_pendingImage.blob, 'me');
  }catch(err){
    alert('Errore invio immagine: '+err.message);
  }finally{
    if (els.imgPreview.src) URL.revokeObjectURL(els.imgPreview.src);
    els.imgPreview.src = ''; _pendingImage=null; els.imgPreviewDlg.close();
  }
});

// === UTILS BINARI ===
function utf8(s){ return new TextEncoder().encode(s); }
function concatU8(...arrays){
  let len = arrays.reduce((a,b)=>a+b.length, 0);
  let out = new Uint8Array(len), off=0;
  for(const a of arrays){ out.set(a, off); off+=a.length; }
  return out;
}

function buildImagePacket(ivU8, mimeStr, nameStr, cipherU8){
  const magic = utf8('SIMG');
  const ver = new Uint8Array([1]);
  const ivLen = new Uint8Array([ivU8.length]);
  const mimeU8 = utf8(mimeStr||'');
  const mimeLen = new Uint8Array([mimeU8.length]);
  const nameU8 = utf8(nameStr||'');
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
  let p=13;
  const iv = u.slice(p, p+ivLen); p+=ivLen;
  const mime = new TextDecoder().decode(u.slice(p, p+mimeLen)); p+=mimeLen;
  const name = new TextDecoder().decode(u.slice(p, p+nameLen)); p+=nameLen;
  const ct = u.slice(p, p+payLen).buffer;
  return {iv, mime, name, ct};
}

async function compressImageToBlob(file, maxSide=1280, quality=0.8){
  const img = await new Promise((res,rej)=>{
    const fr = new FileReader();
    fr.onload = ()=>{ const im=new Image(); im.onload=()=>res(im); im.onerror=rej; im.src=String(fr.result); };
    fr.onerror = rej; fr.readAsDataURL(file);
  });
  let {width, height} = img;
  if (width > height) {
    if (width > maxSide){ height=Math.round(height*(maxSide/width)); width=maxSide; }
  } else {
    if (height > maxSide){ width=Math.round(width*(maxSide/height)); height=maxSide; }
  }
  const canvas=document.createElement('canvas'); canvas.width=width; canvas.height=height;
  const ctx=canvas.getContext('2d'); ctx.drawImage(img,0,0,width,height);
  const mime='image/jpeg';
  const blob=await new Promise(res=>canvas.toBlob(res,mime,quality));
  return blob;
}

// pulisci chat
els.clearBtn.addEventListener('click', ()=>{ els.log.innerHTML=''; });
