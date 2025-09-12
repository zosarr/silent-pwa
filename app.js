// app.js — main client logic
import { CryptoE2E } from './crypto.js';
import { I18N } from './i18n.js';

const state = {
  ws: null,
  room: null,
  keys: null, // { kp, pubJwk }
  peerPubKey: null,
  aesKey: null,
  language: 'it',
  installed: false,
  pendingInstallEvent: null,
};

const chatEl = document.getElementById('chat');
const tmpl = document.getElementById('bubbleTmpl');
const connState = document.getElementById('connState');
const sessionState = document.getElementById('sessionState');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const btnImage = document.getElementById('btnImage');
const btnAudio = document.getElementById('btnAudio');
const imagePicker = document.getElementById('imagePicker');
const installBtn = document.getElementById('installBtn');
const langSelect = document.getElementById('langSelect');

// i18n
langSelect.addEventListener('change', () => {
  state.language = langSelect.value;
  I18N.apply(state.language);
});
I18N.apply(state.language);

// PWA install button logic
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.pendingInstallEvent = e;
  if (!state.installed) installBtn.classList.remove('hidden');
});
installBtn.addEventListener('click', async () => {
  if(state.pendingInstallEvent){
    state.pendingInstallEvent.prompt();
    await state.pendingInstallEvent.userChoice;
    installBtn.classList.add('hidden');
  }
});
window.addEventListener('appinstalled', () => {
  state.installed = true;
  installBtn.classList.add('hidden');
});

// Key generation on startup
(async () => {
  state.keys = await CryptoE2E.generateKeyPair();
  document.getElementById('myPubKey').value = JSON.stringify(state.keys.pubJwk, null, 2);
  updateConnState();
})();

document.getElementById('copyMyKey').addEventListener('click', async () => {
  await navigator.clipboard.writeText(JSON.stringify(state.keys.pubJwk));
});
document.getElementById('setPeerKey').addEventListener('click', async () => {
  try{
    const text = document.getElementById('peerPubKey').value;
    const jwk = JSON.parse(text);
    state.peerPubKey = await CryptoE2E.importPeerPublic(jwk);
    await maybeDeriveSession();
  }catch(e){
    alert('Chiave peer non valida');
  }
});
document.getElementById('connectRoom').addEventListener('click', () => {
  const roomId = document.getElementById('roomId').value.trim() || 'demo';
  connect(roomId);
});

function updateConnState(){
  const c = state.ws && state.ws.readyState === WebSocket.OPEN;
  connState.textContent = c ? (state.language==='it'?'Connesso':'Connected') : (state.language==='it'?'Non connesso':'Not connected');
  sessionState.textContent = state.aesKey ? (state.language==='it'?'Sessione pronta':'Session ready') : connState.textContent;
}
function updateSessionState(){ updateConnState(); }

async function maybeDeriveSession(){
  if(state.keys?.kp?.privateKey && state.peerPubKey){
    state.aesKey = await CryptoE2E.deriveAesGcmKey(state.keys.kp.privateKey, state.peerPubKey);
    updateSessionState();
  }
}

function connect(room){
  state.room = room;
  const wsUrl = (() => {
    // Env override if you deploy WS separately
    if (window.BUILD_WS_URL) return `${window.BUILD_WS_URL}${window.BUILD_WS_URL.includes('?')?'&':'?'}room=${encodeURIComponent(room)}`;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const host = location.hostname + (location.port ? ':' + location.port : '');
    return `${proto}://${host}/ws?room=${encodeURIComponent(room)}`;
  })();

  if(state.ws){ try{ state.ws.close(); }catch(_){} }
  state.ws = new WebSocket(wsUrl);
  state.ws.binaryType = 'arraybuffer';

  state.ws.addEventListener('open', () => updateConnState());
  state.ws.addEventListener('close', () => { updateConnState(); retryConnect(); });
  state.ws.addEventListener('error', () => { updateConnState(); });
  state.ws.addEventListener('message', onWsMessage);
}

let reconnectTimer = null;
function retryConnect(){
  if(!state.room) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(state.room), 2000);
}

async function onWsMessage(ev){
  try{
    if(typeof ev.data === 'string'){
      const msg = JSON.parse(ev.data);
      if(msg.type === 'msg'){
        if(!state.aesKey) return;
        const text = await CryptoE2E.decryptText(state.aesKey, msg.payload);
        addBubble(text, 'them');
      }
    } else {
      if(!state.aesKey) return;
      const buffer = await CryptoE2E.decryptBytes(state.aesKey, ev.data);
      const blob = new Blob([buffer]);
      const url = URL.createObjectURL(blob);
      // Try image first
      const img = new Image();
      img.onload = () => { addBubble(img, 'them'); URL.revokeObjectURL(url); };
      img.onerror = () => {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = url;
        addBubble(audio, 'them');
      };
      img.src = url;
    }
  }catch(e){ console.error('onWsMessage error', e); }
}

function selfDestruct(el, ms=5*60*1000){ setTimeout(()=>el.remove(), ms); }

function addBubble(content, who){
  const node = tmpl.content.firstElementChild.cloneNode(true);
  node.classList.add(who === 'me' ? 'me' : 'them');
  const contentEl = node.querySelector('.content');
  const whenEl = node.querySelector('.when');
  if(typeof content === 'string'){ contentEl.textContent = content; } else { contentEl.appendChild(content); }
  whenEl.textContent = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  chatEl.appendChild(node);
  chatEl.scrollTop = chatEl.scrollHeight;
  selfDestruct(node);
}

// Send text
sendBtn.addEventListener('click', sendText);
document.getElementById('messageInput').addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); sendText(); } });
async function sendText(){
  const text = messageInput.value.trim();
  if(!text) return;
  if(!state.ws || state.ws.readyState !== WebSocket.OPEN){ alert('Non connesso'); return; }
  if(!state.aesKey){ alert('Sessione non pronta'); return; }
  const payload = await CryptoE2E.encryptText(state.aesKey, text);
  state.ws.send(JSON.stringify({ type:'msg', payload }));
  addBubble(text, 'me');
  messageInput.value='';
}

// Images
document.getElementById('btnImage').addEventListener('click', () => imagePicker.click());
imagePicker.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if(!file) return;
  const img = await loadImageFile(file);
  const { blob } = await compressImage(img, 1280, 0.8);
  const url = URL.createObjectURL(blob);
  const dlg = document.getElementById('imagePreview');
  const pv = document.getElementById('previewImg');
  pv.src = url;
  dlg.showModal();
  document.getElementById('cancelPreview').onclick = () => { dlg.close(); URL.revokeObjectURL(url); };
  document.getElementById('sendImage').onclick = async () => {
    await sendBinary(await blob.arrayBuffer());
    addBubble(pv.cloneNode(true), 'me');
    dlg.close(); URL.revokeObjectURL(url);
  };
});
function loadImageFile(file){
  return new Promise((resolve,reject) => { const img=new Image(); img.onload=()=>resolve(img); img.onerror=reject; img.src=URL.createObjectURL(file); });
}
function compressImage(img, maxSide=1280, quality=0.8){
  let {width,height}=img; const r=Math.min(1, maxSide/Math.max(width,height));
  width=Math.round(width*r); height=Math.round(height*r);
  const canvas=document.createElement('canvas'); canvas.width=width; canvas.height=height;
  const ctx=canvas.getContext('2d'); ctx.drawImage(img,0,0,width,height);
  return new Promise(res=>canvas.toBlob(b=>res({blob:b}), 'image/jpeg', quality));
}

// Audio via MediaRecorder
let mediaRecorder, chunks = [];
btnAudio.addEventListener('click', async () => {
  if(mediaRecorder && mediaRecorder.state === 'recording'){ mediaRecorder.stop(); btnAudio.textContent='🎤'; return; }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream);
  chunks = [];
  mediaRecorder.ondataavailable = e => chunks.push(e.data);
  mediaRecorder.onstop = async () => {
    const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    const ab = await blob.arrayBuffer();
    await sendBinary(ab);
    const url = URL.createObjectURL(blob);
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = url;
    addBubble(audio, 'me');
  };
  mediaRecorder.start();
  btnAudio.textContent = '⏹️';
});

async function sendBinary(arrayBuffer){
  if(!state.ws || state.ws.readyState !== WebSocket.OPEN){ alert('Non connesso'); return; }
  if(!state.aesKey){ alert('Sessione non pronta'); return; }
  const encrypted = await CryptoE2E.encryptBytes(state.aesKey, new Uint8Array(arrayBuffer));
  state.ws.send(encrypted);
}

// Init
window.addEventListener('load', () => updateConnState());
