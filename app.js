import { E2E } from './crypto.js';
import { STRINGS, applyLang } from './i18n.js';

// === CONFIG ===
const AUTO_WS_URL = 'wss://silent-backend.onrender.com/ws?room=test';

// Stato globale
let ws = null;
let e2e = new E2E();
let isConnecting = false;
let isConnected = false;
let reconnectTimer = null;
let pingTimer = null;

// Shortcut per listener "sicuri" (non esplode se l'elemento manca)
function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }

// Riferimenti UI
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
  


  // Immagini
  imgInput: document.getElementById('imgInput'),
  sendImgBtn: document.getElementById('sendImgBtn'),
  imgPreviewDlg: document.getElementById('imgPreviewDlg'),
  imgPreview: document.getElementById('imgPreview'),
  confirmSendImg: document.getElementById('confirmSendImg'),
  cancelSendImg: document.getElementById('cancelSendImg'),

  // Audio
  recBtn: document.getElementById('recBtn'),
  stopRecBtn: document.getElementById('stopRecBtn'),
  recTimer: document.getElementById('recTimer'),
};
function isStandalone(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}


// ====== i18n ======
const preferred = (navigator.language || 'it').startsWith('it') ? 'it' : 'en';
if (els.langSelect) {
  els.langSelect.value = preferred;
  applyLang(preferred);
  on(els.langSelect, 'change', e => applyLang(e.target.value));
}

// ====== PWA install ======
let deferredPrompt = null;

function refreshInstallBtnVisibility(){
  if (!els.installBtn) return;
  els.installBtn.style.display = isStandalone() ? 'none' : 'inline-block';
}
window.addEventListener('appinstalled', refreshInstallBtnVisibility);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e;
  refreshInstallBtnVisibility(); // mostra il bottone
});
on(els.installBtn, 'click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
  }
  refreshInstallBtnVisibility();
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}
// mostra lo stato corretto anche se il prompt non è ancora arrivato
refreshInstallBtnVisibility();


// ====== UI helpers ======
function addMsg(text, kind = 'server') {
  if (!els.log) return;
  const li = document.createElement('li');
  li.className = 'msg ' + (kind === 'me' ? 'me' : 'other');
  li.innerHTML = `<div>${escapeHtml(text)}</div><div class="meta">${new Date().toLocaleTimeString()}</div>`;
  els.log.appendChild(li);
  els.log.scrollTop = els.log.scrollHeight;
  setTimeout(() => li.remove(), 5 * 60 * 1000);
}
function addImageFromBlob(blob, kind = 'other') {
  if (!els.log) return;
  const li = document.createElement('li');
  li.className = 'msg ' + (kind === 'me' ? 'me' : 'other');
  const url = URL.createObjectURL(blob);
  const img = document.createElement('img');
  img.src = url;
  img.alt = 'Immagine';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = new Date().toLocaleTimeString();
  li.appendChild(img); li.appendChild(meta);
  els.log.appendChild(li); els.log.scrollTop = els.log.scrollHeight;
  setTimeout(() => { URL.revokeObjectURL(url); li.remove(); }, 5 * 60 * 1000);
}
function addAudioFromBlob(blob, kind = 'other') {
  if (!els.log) return;
  const li = document.createElement('li');
  li.className = 'msg ' + (kind === 'me' ? 'me' : 'other');
  const url = URL.createObjectURL(blob);
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.src = url;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = new Date().toLocaleTimeString();
  li.appendChild(audio); li.appendChild(meta);
  els.log.appendChild(li); els.log.scrollTop = els.log.scrollHeight;
  setTimeout(() => { URL.revokeObjectURL(url); li.remove(); }, 5 * 60 * 1000);
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[m]));
}
function setStatus(labelKey) {
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

// ====== E2E ======
(async () => {
  const myPubB64 = await e2e.init();
  if (els.myPub) els.myPub.value = myPubB64;
})();

on(els.copyMyPubBtn, 'click', async () => {
  if (!els.myPub) return;
  const key = els.myPub.value.trim();
  if (!key) return;
  try { await navigator.clipboard.writeText(key); addMsg('Chiave copiata ✅', 'server'); }
  catch { els.myPub.select(); document.execCommand('copy'); addMsg('Chiave copiata (fallback) ✅', 'server'); }
});

on(els.startSessionBtn, 'click', async () => {
  if (!els.peerPub) return;
  const base64 = els.peerPub.value.trim();
  if (!base64) return alert('Incolla la chiave utente');
  try {
    await e2e.setPeerPublicKey(base64);
    setStatus('ready');
    sendJson({ type: 'pubkey', pub: els.myPub?.value || '' });

    // 👇 CHIUDI il pannello (resta riapribile toccando il <summary>)
    document.getElementById('keysPanel')?.removeAttribute('open');
  } catch (err) {
    alert('Errore sessione: ' + err.message);
  }
});


// ====== WebSocket ======
function connect(url) {
  if (isConnected || isConnecting) return;

  if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
    try { ws.close(1000, 'reconnect'); } catch { }
  }
  try {
    isConnecting = true;
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      clearTimeout(reconnectTimer); reconnectTimer = null;
      isConnecting = false; isConnected = true;
      setStatus('connected');
      sendJson({ type: 'pubkey', pub: els.myPub?.value || '' });

      // Keepalive ping (riduce chiusure per idle)
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === 1) {
          try { ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch {}
        }
      }, 25000);
    };

    ws.onmessage = async (ev) => {
      // Binario: prova immagini (SIMG), poi audio (SAUD)
      if (ev.data instanceof ArrayBuffer) {
        try {
          const simg = parseImagePacket(ev.data);
          if (simg && e2e.ready) {
            const ptAb = await e2e.decryptBytes(simg.iv, simg.ct);
            const blob = new Blob([ptAb], { type: simg.mime || 'image/jpeg' });
            addImageFromBlob(blob, 'other');
            return;
          }
          const saud = parseAudioPacket(ev.data);
          if (saud && e2e.ready) {
            const ptAb = await e2e.decryptBytes(saud.iv, saud.ct);
            let mime = saud.mime || 'audio/webm;codecs=opus';
            let blob;
            if (canPlayMime(mime)) {
              blob = new Blob([ptAb], { type: mime });
            } else {
              // Fallback universale: decodifica e ricodifica in WAV
              blob = await decodeToWavBlob(ptAb);
              mime = 'audio/wav';
            }
            addAudioFromBlob(blob, 'other');
            return;
          }
        } catch (ex) { console.warn('Errore pacchetto binario', ex); }
        return;
      }

      // Testo JSON (pubkey/msg/ping)
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'ping') return; // ignora keepalive
        if (data.type === 'pubkey' && data.pub) {
          if (!e2e.ready) {
            try { await e2e.setPeerPublicKey(data.pub); setStatus('ready'); } catch { }
          }
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

    ws.onerror = () => setStatus('disconnected');
    ws.onclose = () => {
      isConnected = false; isConnecting = false;
      setStatus('disconnected');
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      scheduleReconnect();
    };

  } catch (e) {
    isConnecting = false;
    console.error('WS exception', e);
    scheduleReconnect();
  }
}

function scheduleReconnect(delay = 4000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(getWsUrl()); }, delay);
}
function getWsUrl() {
  const params = new URLSearchParams(location.search);
  const override = params.get('ws');
  const url = (override && /^wss?:\/\//i.test(override)) ? override : AUTO_WS_URL;
  return url;
}
window.addEventListener('load', () => connect(getWsUrl()));

// Avviso su chiusura/refresh se connessi o in registrazione
window.addEventListener('beforeunload', (e) => {
  if (isConnected || (typeof mediaRecorder !== 'undefined' && mediaRecorder && mediaRecorder.state === 'recording')) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function sendJson(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ====== Invio testo ======
on(els.sendBtn, 'click', async () => {
  if (!els.input) return;
  const text = els.input.value.trim();
  if (!text) return;
  if (!ws || ws.readyState !== 1) return alert('Non connesso');
  if (!e2e.ready) return alert('Sessione non pronta');
  const { iv, ct } = await e2e.encrypt(text);
  sendJson({ type: 'msg', iv, ct });
  addMsg(text, 'me');
  els.input.value = '';
});

// ====== Immagini ======
let _pendingImage = null;

on(els.sendImgBtn, 'click', () => els.imgInput && els.imgInput.click());

on(els.imgInput, 'change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const blob = await compressImageToBlob(file, 1280, 0.8);
    _pendingImage = { blob, name: file.name || 'image.jpg', mime: 'image/jpeg' };
    if (els.imgPreview) els.imgPreview.src = URL.createObjectURL(blob);
    els.imgPreviewDlg?.showModal();
  } catch (err) {
    alert('Errore preparazione immagine: ' + err.message);
    _pendingImage = null;
  }
});
on(els.cancelSendImg, 'click', () => {
  if (els.imgPreview && els.imgPreview.src) URL.revokeObjectURL(els.imgPreview.src);
  if (els.imgPreview) els.imgPreview.src = '';
  _pendingImage = null;
  els.imgPreviewDlg?.close();
});
on(els.confirmSendImg, 'click', async () => {
  if (!_pendingImage) return;
  if (!ws || ws.readyState !== 1) { alert('Non connesso'); return; }
  if (!e2e.ready) { alert('Sessione non pronta'); return; }
  try {
    const ab = await _pendingImage.blob.arrayBuffer();
    const { iv, ct } = await e2e.encryptBytes(ab);
    const packet = buildImagePacket(new Uint8Array(iv), _pendingImage.mime, _pendingImage.name, new Uint8Array(ct));
    ws.send(packet);
    addImageFromBlob(_pendingImage.blob, 'me');
  } catch (err) {
    alert('Errore invio immagine: ' + err.message);
  } finally {
    if (els.imgPreview && els.imgPreview.src) URL.revokeObjectURL(els.imgPreview.src);
    if (els.imgPreview) els.imgPreview.src = '';
    _pendingImage = null;
    els.imgPreviewDlg?.close();
  }
});

// ====== Audio ======
let mediaStream = null;
let mediaRecorder = null;
let recChunks = [];
let recStartTs = 0;
let recInterval = null;

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
function startTimerUI() {
  if (!els.recTimer) return;
  let t = 0;
  els.recTimer.textContent = '00:00';
  els.recTimer.style.display = 'inline-block';
  recInterval = setInterval(() => { t++; els.recTimer.textContent = formatTime(t); }, 1000);
}
function stopTimerUI() {
  if (recInterval) clearInterval(recInterval);
  recInterval = null;
  if (els.recTimer) els.recTimer.style.display = 'none';
}
function pickAudioMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg'
  ];
  for (const t of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

on(els.recBtn, 'click', async () => {
  if (!navigator.mediaDevices?.getUserMedia) { alert('Registrazione non supportata.'); return; }
  const mime = pickAudioMime();
  if (!mime) { alert('MIME audio non supportato su questo browser.'); return; }
  if (!ws || ws.readyState !== 1) { alert('Non connesso'); return; }
  if (!e2e.ready) { alert('Sessione non pronta'); return; }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: mime });

    recChunks = [];
    recStartTs = Date.now();
    if (els.recBtn) els.recBtn.style.display = 'none';
    if (els.stopRecBtn) els.stopRecBtn.style.display = 'inline-block';
    startTimerUI();

    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stopTimerUI();
      if (els.stopRecBtn) els.stopRecBtn.style.display = 'none';
      if (els.recBtn) els.recBtn.style.display = 'inline-block';
      const durationMs = Date.now() - recStartTs;

      const mimeNow = mediaRecorder.mimeType || mime;
      const blob = new Blob(recChunks, { type: mimeNow });
      recChunks = [];

      try {
        const ab = await blob.arrayBuffer();
        const { iv, ct } = await e2e.encryptBytes(ab);
        const packet = buildAudioPacket(new Uint8Array(iv), mimeNow, durationMs, new Uint8Array(ct));
        ws.send(packet);
        addAudioFromBlob(blob, 'me');
      } catch (err) {
        alert('Errore invio audio: ' + err.message);
      } finally {
        try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch { }
        mediaStream = null;
        mediaRecorder = null;
      }
    };

    mediaRecorder.start(250);
  } catch (err) {
    alert('Impossibile avviare la registrazione: ' + err.message);
    try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch { }
    mediaStream = null; mediaRecorder = null;
    if (els.stopRecBtn) els.stopRecBtn.style.display = 'none';
    if (els.recBtn) els.recBtn.style.display = 'inline-block';
    stopTimerUI();
  }
});

on(els.stopRecBtn, 'click', () => { try { mediaRecorder && mediaRecorder.stop(); } catch { } });

// ====== Utils binari comuni ======
function utf8(s) { return new TextEncoder().encode(s); }
function concatU8(...arrays) {
  let len = arrays.reduce((a, b) => a + b.length, 0);
  let out = new Uint8Array(len), off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// IMMAGINI (SIMG)
function buildImagePacket(ivU8, mimeStr, nameStr, cipherU8) {
  // [0..3]'SIMG' [4]ver=1 [5]ivLen [6]mimeLen [7..8]nameLen [9..12]payLen | iv | mime | name | ct
  const magic = utf8('SIMG');
  const ver = new Uint8Array([1]);
  const ivLen = new Uint8Array([ivU8.length]);
  const mimeU8 = utf8(mimeStr || '');
  const mimeLen = new Uint8Array([mimeU8.length]);
  const nameU8 = utf8(nameStr || '');
  const nameLen = new Uint8Array([(nameU8.length >> 8) & 0xff, nameU8.length & 0xff]);
  const payLen = new Uint8Array([
    (cipherU8.length >>> 24) & 0xff, (cipherU8.length >>> 16) & 0xff,
    (cipherU8.length >>> 8) & 0xff, cipherU8.length & 0xff
  ]);
  return concatU8(magic, ver, ivLen, mimeLen, nameLen, payLen, ivU8, mimeU8, nameU8, cipherU8).buffer;
}
function parseImagePacket(ab) {
  const u = new Uint8Array(ab);
  if (u.length < 13) return null;
  if (String.fromCharCode(u[0], u[1], u[2], u[3]) !== 'SIMG') return null;
  const ver = u[4]; if (ver !== 1) return null;
  const ivLen = u[5];
  const mimeLen = u[6];
  const nameLen = (u[7] << 8) | u[8];
  const payLen = (u[9] << 24) | (u[10] << 16) | (u[11] << 8) | u[12];
  let p = 13;
  const iv = u.slice(p, p + ivLen); p += ivLen;
  const mime = new TextDecoder().decode(u.slice(p, p + mimeLen)); p += mimeLen;
  const name = new TextDecoder().decode(u.slice(p, p + nameLen)); p += nameLen;
  const ct = u.slice(p, p + payLen).buffer;
  return { iv, mime, name, ct };
}

// AUDIO (SAUD)
function buildAudioPacket(ivU8, mimeStr, durationMs, cipherU8) {
  // [0..3]'SAUD' [4]ver=1 [5]ivLen [6]mimeLen [7..10]durMs [11..14]payLen | iv | mime | ct
  const magic = utf8('SAUD');
  const ver = new Uint8Array([1]);
  const ivLen = new Uint8Array([ivU8.length]);
  const mimeU8 = utf8(mimeStr || '');
  const mimeLen = new Uint8Array([mimeU8.length]);
  const dur = new Uint8Array([
    (durationMs >>> 24) & 0xff, (durationMs >>> 16) & 0xff, (durationMs >>> 8) & 0xff, durationMs & 0xff
  ]);
  const payLen = new Uint8Array([
    (cipherU8.length >>> 24) & 0xff, (cipherU8.length >>> 16) & 0xff, (cipherU8.length >>> 8) & 0xff, cipherU8.length & 0xff
  ]);
  return concatU8(magic, ver, ivLen, mimeLen, dur, payLen, ivU8, mimeU8, cipherU8).buffer;
}
function parseAudioPacket(ab) {
  const u = new Uint8Array(ab);
  if (u.length < 15) return null;
  if (String.fromCharCode(u[0], u[1], u[2], u[3]) !== 'SAUD') return null;
  const ver = u[4]; if (ver !== 1) return null;
  const ivLen = u[5];
  const mimeLen = u[6];
  const durMs = (u[7] << 24) | (u[8] << 16) | (u[9] << 8) | u[10];
  const payLen = (u[11] << 24) | (u[12] << 16) | (u[13] << 8) | u[14];
  let p = 15;
  const iv = u.slice(p, p + ivLen); p += ivLen;
  const mime = new TextDecoder().decode(u.slice(p, p + mimeLen)); p += mimeLen;
  const ct = u.slice(p, p + payLen).buffer;
  return { iv, mime, durMs, ct };
}

// ====== Utils per immagini ======
async function compressImageToBlob(file, maxSide = 1280, quality = 0.8) {
  const img = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = String(fr.result); };
    fr.onerror = rej; fr.readAsDataURL(file);
  });
  let { width, height } = img;
  if (width > height) {
    if (width > maxSide) { height = Math.round(height * (maxSide / width)); width = maxSide; }
  } else {
    if (height > maxSide) { width = Math.round(width * (maxSide / height)); height = maxSide; }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, width, height);
  const mime = 'image/jpeg';
  const blob = await new Promise(res => canvas.toBlob(res, mime, quality));
  return blob;
}

// ====== Utils audio: compatibilità MIME + fallback WAV ======
function canPlayMime(mime) {
  try { return !!new Audio().canPlayType(mime); } catch { return false; }
}
function encodeWavFromAudioBuffer(audioBuffer) {
  const numCh = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const samples = audioBuffer.length;

  // interleave (se stereo)
  let pcm;
  if (numCh === 2) {
    const L = audioBuffer.getChannelData(0), R = audioBuffer.getChannelData(1);
    pcm = new Float32Array(samples * 2);
    for (let i = 0, j = 0; i < samples; i++, j += 2) { pcm[j] = L[i]; pcm[j + 1] = R[i]; }
  } else {
    pcm = audioBuffer.getChannelData(0);
  }

  const bytesPerSample = 2;
  const blockAlign = (numCh) * bytesPerSample;
  const buffer = new ArrayBuffer(44 + pcm.length * bytesPerSample);
  const view = new DataView(buffer);

  const writeString = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  let offset = 0;
  writeString(offset, 'RIFF'); offset += 4;
  view.setUint32(offset, 36 + pcm.length * bytesPerSample, true); offset += 4;
  writeString(offset, 'WAVE'); offset += 4;
  writeString(offset, 'fmt '); offset += 4;
  view.setUint32(offset, 16, true); offset += 4;           // Subchunk1Size
  view.setUint16(offset, 1, true); offset += 2;            // AudioFormat PCM
  view.setUint16(offset, numCh, true); offset += 2;        // NumChannels
  view.setUint32(offset, sampleRate, true); offset += 4;   // SampleRate
  view.setUint32(offset, sampleRate * blockAlign, true); offset += 4; // ByteRate
  view.setUint16(offset, blockAlign, true); offset += 2;   // BlockAlign
  view.setUint16(offset, 16, true); offset += 2;           // BitsPerSample
  writeString(offset, 'data'); offset += 4;
  view.setUint32(offset, pcm.length * bytesPerSample, true); offset += 4;

  // float32 -> int16
  let idx = offset;
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(idx, clamp(pcm[i]) * 0x7FFF, true);
    idx += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}
async function decodeToWavBlob(arrayBuffer) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  return encodeWavFromAudioBuffer(audioBuffer);
}

// ====== Pulisci chat ======
on(els.clearBtn, 'click', () => { if (els.log) els.log.innerHTML = ''; });

// ====== Avvio connessione ======
window.addEventListener('load', () => connect(getWsUrl()));
