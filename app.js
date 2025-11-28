//----------------------------------------------------
// Silent PWA - app.js (PARTE 1/2)
// Riparato, senza placeholder, identico alla logica originale
//----------------------------------------------------

import { E2E, fingerprintFromRawBase64 } from './crypto.js';
import { applyLang } from './i18n.js';

// ------------------------------------------------------
// CONFIG
// ------------------------------------------------------

const SERVER_BASE = (location.hostname === 'localhost')
  ? 'http://localhost:8000'
  : 'https://api.silentpwa.com';

const API_BASE_URL = SERVER_BASE;

// WebSocket default
let AUTO_WS_URL = 'wss://api.silentpwa.com/ws?room=test';

// Override via query string
const urlParams = new URLSearchParams(location.search);
const FORCED_WS = urlParams.get('ws') || AUTO_WS_URL;

// Install ID unificato
function getInstallId() {
  try {
    let id = localStorage.getItem('silent_install_id');
    if (!id) {
      id = crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      localStorage.setItem('silent_install_id', id);
    }
    return id;
  } catch (e) {
    console.warn('Install ID fallback (no localStorage):', e);
    return 'no-storage-' + Date.now().toString(36);
  }
}

const INSTALL_ID = getInstallId();

// ------------------------------------------------------
// DOM ELEMENTS
// ------------------------------------------------------

const els = {
  log: document.getElementById('log'),
  textInput: document.getElementById('textInput'),
  sendBtn: document.getElementById('sendBtn'),
  startBtn: document.getElementById('startBtn'),
  myPub: document.getElementById('myPub'),
  peerPub: document.getElementById('peerPub'),
  connState: document.getElementById('connState'),
  photoBtn: document.getElementById('photoBtn'),
  audioBtn: document.getElementById('audioBtn'),
  cameraInput: document.getElementById('cameraInput'),
  galleryInput: document.getElementById('galleryInput'),
  photoMenu: document.getElementById('photoMenu'),
  takePhotoBtn: document.getElementById('takePhotoBtn'),
  choosePhotoBtn: document.getElementById('choosePhotoBtn'),
  closePhotoMenu: document.getElementById('closePhotoMenu'),
  iosBanner: document.getElementById('iosInstallBanner'),
  iosClose: document.getElementById('iosInstallClose'),
  iosNever: document.getElementById('iosInstallNever'),
};

// ------------------------------------------------------
// STATE
// ------------------------------------------------------

let ws = null;
let isConnecting = false;
let shouldAutoReconnect = true;
let e2e = new E2E();

// session
let sessionStarted = false;
let pendingPeerKey = null;

// notifications & badges
let windowHasFocus = true;
let unreadCount = 0;

// license
let licenseStatus = 'unknown';
let licensePollTimer = null;
let lastLicensePayload = null;

// audio
let mediaRecorder = null;
let audioChunks = [];
let audioTimer = null;

// ------------------------------------------------------
// LANGUAGE
// ------------------------------------------------------

document.getElementById('langSel').value = localStorage.getItem('lang') || 'it';
applyLang(localStorage.getItem('lang') || 'it');

document.getElementById('langSel').addEventListener('change', e => {
  const lang = e.target.value;
  localStorage.setItem('lang', lang);
  applyLang(lang);
});

// ------------------------------------------------------
// WINDOW FOCUS (badge e titolo)
// ------------------------------------------------------

window.addEventListener('focus', () => {
  windowHasFocus = true;
  unreadCount = 0;
  document.title = "Silent";
  if (navigator.clearAppBadge) navigator.clearAppBadge();
});

window.addEventListener('blur', () => {
  windowHasFocus = false;
});

// ------------------------------------------------------
// CONNECTION STATUS UI
// ------------------------------------------------------

function setConnState(online) {
  els.connState.textContent = online ? "● online" : "● offline";
  els.connState.style.color = online ? "#0a0" : "#a00";
}

// ------------------------------------------------------
// INITIAL LICENSE CHECK
// ------------------------------------------------------

async function fetchLicenseStatus(showErrors = false) {
  try {
    const res = await fetch(
      `${API_BASE_URL}/license/status?install_id=${encodeURIComponent(INSTALL_ID)}`
    );
    const data = await res.json();

    const prev = licenseStatus;
    licenseStatus = data.status;
    lastLicensePayload = data;

    updateLicenseOverlay();

    if (prev !== 'pro' && data.status === 'pro') {
      console.info("Licenza PRO attivata");
    }

  } catch (e) {
    console.warn("Impossibile recuperare licenza:", e);
    if (showErrors) alert("Errore nel recupero licenza");
  }
}

// ------------------------------------------------------
// LICENSE UI
// ------------------------------------------------------

function updateLicenseOverlay() {
  const ov = document.getElementById('licenseOverlay');
  const title = document.getElementById('licenseTitle');
  const msg = document.getElementById('licenseMessage');
  const cd = document.getElementById('licenseCountdown');

  if (!ov) return;

  // PRO
  if (licenseStatus === 'pro') {
    ov.style.display = 'none';
    document.body.classList.remove('demo-mode');
    return;
  }

  // TRIAL
  if (licenseStatus === 'trial') {
    const hours = lastLicensePayload?.trial_hours_left || 0;
    title.textContent = "Licenza TRIAL attiva";
    msg.textContent = "Hai accesso completo all'app.";
    cd.textContent = "Tempo rimanente: " + hours.toFixed(1) + " ore";
    ov.style.display = 'flex';
    return;
  }

  // DEMO
  if (licenseStatus === 'demo') {
    title.textContent = "Modalità DEMO";
    msg.textContent = "Puoi inviare solo messaggi di testo.";
    cd.textContent = "";
    document.body.classList.add('demo-mode');
    ov.style.display = 'flex';
    return;
  }

  // UNKNOWN
  title.textContent = "Verifica licenza…";
  msg.textContent = "";
  cd.textContent = "";
  ov.style.display = 'flex';
}

// ------------------------------------------------------
// PRODUCT LIMITS
// ------------------------------------------------------

function isFeatureAllowed(feature) {
  if (licenseStatus === 'pro') return true;
  if (licenseStatus === 'trial') return true;
  if (feature === 'text') return true;
  return false;
}

// ------------------------------------------------------
// BITCOIN PAYMENT
// ------------------------------------------------------

async function startBitcoinPayment() {
  try {
    const res = await fetch(
      `${API_BASE_URL}/payment/start?install_id=${encodeURIComponent(INSTALL_ID)}`,
      { method: "POST" }
    );
    const data = await res.json();

    if (!data.btc_address || !data.amount_btc) {
      alert("Errore nella creazione della richiesta di pagamento.");
      return;
    }

    const btcAddr = data.btc_address;
    const amount = data.amount_btc;

    const ov = document.getElementById('licenseOverlay');
    ov.style.display = 'flex';

    document.getElementById("licenseQr").src =
      `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=bitcoin:${btcAddr}?amount=${amount}`;

    document.getElementById("licenseAddr").textContent = btcAddr;
    document.getElementById("licenseAmount").textContent = amount + " BTC";

    pollPaymentStatus();

  } catch (err) {
    console.error("Errore pagamento BTC:", err);
    alert("Errore durante il pagamento Bitcoin.");
  }
}

function pollPaymentStatus() {
  const timer = setInterval(async () => {
    try {
      const res = await fetch(
        `${API_BASE_URL}/payment/status?install_id=${encodeURIComponent(INSTALL_ID)}`
      );
      const data = await res.json();

      if (data.status === "pro") {
        clearInterval(timer);
        alert("Pagamento ricevuto! Licenza PRO attivata.");
        const ov = document.getElementById('licenseOverlay');
        if (ov) ov.style.display = 'none';
        fetchLicenseStatus();
      }

    } catch (err) {
      console.warn("Errore polling licenza:", err);
    }
  }, 5000);
}

document.getElementById('licenseBuyBtn').addEventListener('click', startBitcoinPayment);
document.getElementById('licenseDemoBtn').addEventListener('click', () => {
  document.getElementById('licenseOverlay').style.display = 'none';
});

// ------------------------------------------------------
// PHOTO MENU
// ------------------------------------------------------

function showPhotoMenu() {
  els.photoMenu.style.display = 'flex';
}

function hidePhotoMenu() {
  els.photoMenu.style.display = 'none';
}

els.photoBtn.addEventListener('click', () => {
  if (!isFeatureAllowed('image')) {
    alert("In DEMO puoi inviare solo testo.");
    updateLicenseOverlay();
    return;
  }
  showPhotoMenu();
});

els.closePhotoMenu.addEventListener('click', hidePhotoMenu);

els.takePhotoBtn.addEventListener('click', () => {
  hidePhotoMenu();
  els.cameraInput.click();
});

els.choosePhotoBtn.addEventListener('click', () => {
  hidePhotoMenu();
  els.galleryInput.click();
});

// ------------------------------------------------------
// IMAGE SENDING
// ------------------------------------------------------

function blobToBase64(blob) {
  return new Promise(resolve => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result.split(',')[1]);
    fr.readAsDataURL(blob);
  });
}

async function compressImage(img, {maxW = 1280, maxH = 1280, quality = 0.85} = {}) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const r = Math.min(maxW / w, maxH / h, 1);

  const nw = Math.round(w * r);
  const nh = Math.round(h * r);

  const canvas = document.createElement('canvas');
  canvas.width = nw;
  canvas.height = nh;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, nw, nh);

  return new Promise(resolve => {
    canvas.toBlob(b => resolve({ blob: b, width: nw, height: nh }), 'image/jpeg', quality);
  });
}

// (continua nella PARTE 2…)
//----------------------------------------------------
// Silent PWA - app.js (PARTE 2/2)
// Riparato, senza placeholder, identico alla logica originale
//----------------------------------------------------

// ------------------------------------------------------
// HANDLE IMAGE INPUTS
// ------------------------------------------------------

els.cameraInput.addEventListener('change', async e => {
  if (!e.target.files?.[0]) return;

  const file = e.target.files[0];
  const img = new Image();

  img.onload = async () => {
    const { blob } = await compressImage(img);
    const base64 = await blobToBase64(blob);

    const enc = await e2e.encrypt(base64);
    ws.send(JSON.stringify({ type: "image", ...enc, mime: "image/jpeg" }));

    addImage(base64, 'me', "image/jpeg");
  };

  img.src = URL.createObjectURL(file);
});

els.galleryInput.addEventListener('change', async e => {
  if (!e.target.files?.[0]) return;

  const file = e.target.files[0];
  const img = new Image();

  img.onload = async () => {
    const { blob } = await compressImage(img);
    const base64 = await blobToBase64(blob);

    const enc = await e2e.encrypt(base64);
    ws.send(JSON.stringify({ type: "image", ...enc, mime: "image/jpeg" }));

    addImage(base64, 'me', "image/jpeg");
  };

  img.src = URL.createObjectURL(file);
});

// ------------------------------------------------------
// ADD IMAGE TO CHAT
// ------------------------------------------------------

function addImage(base64, who = 'me', mime = 'image/jpeg') {
  const li = document.createElement('li');
  li.className = who;
  const img = document.createElement('img');
  img.src = `data:${mime};base64,${base64}`;
  li.appendChild(img);
  els.log.appendChild(li);
  els.log.scrollTop = els.log.scrollHeight;

  if (who === 'peer') onIncoming('image');

  setTimeout(() => li.remove(), 5 * 60 * 1000);
}

// ------------------------------------------------------
// AUDIO RECORDING
// ------------------------------------------------------

els.audioBtn.addEventListener('click', async () => {
  if (!isFeatureAllowed('audio')) {
    alert("In DEMO puoi inviare solo testo.");
    updateLicenseOverlay();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    showRecBadge(60);

    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);

    mediaRecorder.onstop = async () => {
      clearRecBadge();
      clearTimeout(audioTimer);

      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
      const base64 = await blobToBase64(blob);

      addAudio(URL.createObjectURL(blob), 'me', mediaRecorder.mimeType);

      const enc = await e2e.encrypt(base64);
      ws.send(JSON.stringify({
        type: "audio",
        ...enc,
        mime: mediaRecorder.mimeType
      }));
    };

    mediaRecorder.start();

    audioTimer = setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
      }
    }, 60 * 1000);

  } catch (err) {
    alert("Microfono non accessibile.");
    console.error(err);
  }
});

// ------------------------------------------------------
// AUDIO UI BADGE
// ------------------------------------------------------

let recBadge = null;
let recTimerInt = null;

function ensureRecBadge() {
  if (!recBadge) {
    recBadge = document.createElement('div');
    recBadge.style.position = 'fixed';
    recBadge.style.top = '10px';
    recBadge.style.right = '10px';
    recBadge.style.background = '#b81c1c';
    recBadge.style.color = '#fff';
    recBadge.style.padding = '10px 14px';
    recBadge.style.borderRadius = '8px';
    recBadge.style.zIndex = '9999';
    recBadge.style.fontWeight = 'bold';
    document.body.appendChild(recBadge);
  }
  return recBadge;
}

function showRecBadge(maxSec = 60) {
  let secLeft = maxSec;
  const badge = ensureRecBadge();
  badge.textContent = `Registrazione… ${secLeft}s`;
  badge.style.display = 'block';

  recTimerInt = setInterval(() => {
    secLeft -= 1;
    badge.textContent = `Registrazione… ${secLeft}s`;
    if (secLeft <= 0) {
      clearInterval(recTimerInt);
    }
  }, 1000);
}

function clearRecBadge() {
  if (recTimerInt) clearInterval(recTimerInt);
  if (recBadge) recBadge.style.display = 'none';
}

// ------------------------------------------------------
// ADD AUDIO TO CHAT
// ------------------------------------------------------

function addAudio(url, who = 'me', mime = 'audio/webm') {
  const li = document.createElement('li');
  li.className = who;
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.src = url;
  li.appendChild(audio);
  els.log.appendChild(li);
  els.log.scrollTop = els.log.scrollHeight;

  if (who === 'peer') onIncoming('audio');

  setTimeout(() => li.remove(), 5 * 60 * 1000);
}

// ------------------------------------------------------
// INCOMING NOTIFICATIONS
// ------------------------------------------------------

function onIncoming(type) {
  if (windowHasFocus) return;

  unreadCount++;
  document.title = `(${unreadCount}) Silent`;

  if (navigator.setAppBadge) navigator.setAppBadge(unreadCount);

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
  } catch (err) {
    console.warn("Beep fallback:", err);
  }

  if (Notification.permission === "granted") {
    new Notification("Nuovo messaggio");
  }
}

// ------------------------------------------------------
// E2E CHAT MESSAGING
// ------------------------------------------------------

els.sendBtn.addEventListener('click', sendText);
els.textInput.addEventListener('keydown', e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendText();
  }
});

async function sendText() {
  const t = els.textInput.value.trim();
  if (!t) return;

  if (!isFeatureAllowed('text')) {
    alert("In DEMO puoi inviare solo testo.");
    updateLicenseOverlay();
    return;
  }

  addMsg(t, 'me');
  els.textInput.value = "";

  if (!sessionStarted) {
    alert("Sessione non avviata.");
    return;
  }

  const enc = await e2e.encrypt(t);
  ws.send(JSON.stringify({ type: "msg", ...enc }));
}

// ------------------------------------------------------
// ADD TEXT TO CHAT
// ------------------------------------------------------

function addMsg(text, who = 'me') {
  const li = document.createElement('li');
  li.className = who;
  li.textContent = text;
  els.log.appendChild(li);
  els.log.scrollTop = els.log.scrollHeight;

  if (who === 'peer') onIncoming('text');

  setTimeout(() => li.remove(), 5 * 60 * 1000);
}

// ------------------------------------------------------
// E2E SESSION START
// ------------------------------------------------------

document.getElementById('copyMyKey').addEventListener('click', () => {
  navigator.clipboard.writeText(els.myPub.value);
  alert("Chiave copiata.");
});

els.startBtn.addEventListener('click', async () => {
  try {
    const peerRaw = els.peerPub.value.trim();
    if (!peerRaw) {
      alert("Incolla la chiave del partner.");
      return;
    }

    if (!e2e.ready) {
      await e2e.ensureKeys();
      els.myPub.value = e2e.rawPub;
    }

    pendingPeerKey = peerRaw;

    if (ws?.readyState === WebSocket.OPEN) {
      startSessionNow();
    } else {
      alert("Connessione WebSocket non pronta.");
    }

  } catch (err) {
    console.error(err);
    alert("Errore avvio sessione.");
  }
});

async function startSessionNow() {
  try {
    await e2e.initPeer(pendingPeerKey);

    const fp = fingerprintFromRawBase64(e2e.rawPub);
    console.log("Fingerprint locale:", fp);

    ws.send(JSON.stringify({ type: "key", raw: e2e.rawPub }));

    sessionStarted = true;
    alert("Sessione avviata!");

  } catch (err) {
    console.error("Errore sessione:", err);
    alert("Errore durante l’avvio della sessione.");
  }
}

// ------------------------------------------------------
// WEBSOCKET SETUP
// ------------------------------------------------------

async function connect() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    let wsUrl = FORCED_WS;
    const sep = wsUrl.includes('?') ? '&' : '?';
    wsUrl = `${wsUrl}${sep}install_id=${encodeURIComponent(INSTALL_ID)}`;

    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      isConnecting = false;
      setConnState(true);
      console.log("WS open:", wsUrl);
    });

    ws.addEventListener('close', () => {
      setConnState(false);
      sessionStarted = false;
      pendingPeerKey = null;

      if (shouldAutoReconnect) {
        setTimeout(connect, 2000);
      }
    });

    ws.addEventListener('message', async ev => {
      let msg;
      try { msg = JSON.parse(ev.data); }
      catch { return; }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (msg.type === 'presence') {
        return;
      }

      if (msg.type === 'key') {
        pendingPeerKey = msg.raw;
        await startSessionNow();
        return;
      }

      if (!e2e.ready) return;

      if (msg.type === 'msg') {
        const plain = await e2e.decrypt(msg.iv, msg.ct);
        addMsg(plain, 'peer');
        return;
      }

      if (msg.type === 'image') {
        const plain = await e2e.decrypt(msg.iv, msg.ct);
        addImage(plain, 'peer', msg.mime);
        return;
      }

      if (msg.type === 'audio') {
        const plain = await e2e.decrypt(msg.iv, msg.ct);
        const blob = await fetch(`data:${msg.mime};base64,${plain}`).then(r => r.blob());
        addAudio(URL.createObjectURL(blob), 'peer', msg.mime);
        return;
      }
    });

  } catch (err) {
    console.error("WS error:", err);
  }
}

connect();

// ------------------------------------------------------
// iOS INSTALL BANNER
// ------------------------------------------------------

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isInStandalone() {
  return window.navigator.standalone === true;
}

function maybeShowIOSInstallBanner() {
  if (!isIOS()) return;
  if (isInStandalone()) return;

  if (localStorage.getItem("iosBannerNever") === "1") return;

  els.iosBanner.style.display = 'block';
}

els.iosClose.addEventListener('click', () => {
  els.iosBanner.style.display = 'none';
});

els.iosNever.addEventListener('click', () => {
  localStorage.setItem("iosBannerNever", "1");
  els.iosBanner.style.display = 'none';
});

maybeShowIOSInstallBanner();

// ------------------------------------------------------
// SERVICE WORKER
// ------------------------------------------------------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .then(() => console.log("SW registered"))
    .catch(err => console.warn("SW failed:", err));
}

// ------------------------------------------------------
// INITIAL STEPS
// ------------------------------------------------------

(async () => {
  await e2e.ensureKeys();
  els.myPub.value = e2e.rawPub;

  await fetchLicenseStatus();
})();
