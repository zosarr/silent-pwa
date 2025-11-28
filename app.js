//----------------------------------------------------
// Silent PWA - app.js (NUOVA VERSIONE PULITA) — PARTE 1
//----------------------------------------------------

import { E2E, fingerprintFromRawBase64 } from './crypto.js';
import { applyLang } from './i18n.js';

// ------------------------------------------------------
// CONFIG
// ------------------------------------------------------

const SERVER_BASE =
    location.hostname === 'localhost'
        ? 'http://localhost:8000'
        : 'https://api.silentpwa.com';

const qs = new URLSearchParams(location.search);
const AUTO_WS_URL = 'wss://api.silentpwa.com/ws?room=test';
const FORCED_WS = qs.get('ws') || AUTO_WS_URL;

function getInstallId() {
    try {
        let id = localStorage.getItem('install_id');
        if (!id) {
            id = crypto.randomUUID();
            localStorage.setItem('install_id', id);
        }
        return id;
    } catch (e) {
        return 'nostorage-' + Date.now();
    }
}
const INSTALL_ID = getInstallId();

const API = (path, opts = {}) =>
    fetch(`${SERVER_BASE}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
    }).then((r) => r.json());

// ------------------------------------------------------
// LANGUAGE
// ------------------------------------------------------

const langSel = document.getElementById('langSelect');
langSel.value = localStorage.getItem('lang') || 'it';
applyLang(langSel.value);
langSel.onchange = () => {
    localStorage.setItem('lang', langSel.value);
    applyLang(langSel.value);
};

// ------------------------------------------------------
// ELEMENTS
// ------------------------------------------------------

const $ = (s) => document.querySelector(s);
const els = {
    myPub: $('#myPub'),
    peerPub: $('#peerPub'),
    startBtn: $('#startSessionBtn'),
    sendBtn: $('#sendBtn'),
    input: $('#msgInput'),
    log: $('#log'),
    connStatus: $('#connStatus'),
    installBtn: $('#installBtn'),
    copyMyBtn: $('#copyMyPubBtn'),
};

// ------------------------------------------------------
// STATE
// ------------------------------------------------------

let ws = null;
let isConnected = false;
let isConnecting = false;

let e2e = new E2E();
let myPubExpected = null;
let pendingPeerKey = null;
let sessionStarted = false;

let unreadCount = 0;
let initialTitle = document.title;

// ------------------------------------------------------
// BADGE + AUDIO BEEP
// ------------------------------------------------------

let beepEnabled = false;
let audioCtx = null;

try {
    if (localStorage.getItem('beepEnabled') === '1') {
        beepEnabled = true;
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
} catch (e) {}

function playBeep() {
    if (!beepEnabled) return;
    try {
        const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 1000;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
        osc.stop(ctx.currentTime + 0.2);
    } catch (e) {}
}

function setBadge(n) {
    try {
        if ('setAppBadge' in navigator) navigator.setAppBadge(n);
    } catch {}
    document.title = n ? `(${n}) ${initialTitle}` : initialTitle;
}

function clearBadge() {
    unreadCount = 0;
    setBadge(0);
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) clearBadge();
});
window.addEventListener('focus', clearBadge);

// ------------------------------------------------------
// LICENSE SYSTEM
// ------------------------------------------------------

async function bootstrapLicense() {
    await API('/license/register', {
        method: 'POST',
        body: JSON.stringify({ install_id: INSTALL_ID }),
    });
    return API(`/license/status?install_id=${INSTALL_ID}`);
}

function updateLicenseUI(lic) {
    const ov = document.getElementById('licenseOverlay');
    const badge = document.getElementById('demo-badge');
    const isPro = lic.status === 'pro';

    window.__LICENSE_STATUS__ = lic.status;
    window.__LICENSE_LIMITS__ = lic.limits || {};

    if (badge) badge.hidden = isPro;
    if (ov) ov.hidden = isPro;
}

async function initLicense() {
    const lic = await bootstrapLicense();
    updateLicenseUI(lic);

    setInterval(async () => {
        try {
            const x = await API(`/license/status?install_id=${INSTALL_ID}`);
            updateLicenseUI(x);
        } catch (e) {}
    }, 30000);
}

async function startBitcoinPayment() {
    try {
        const res = await fetch(
            `https://api.silentpwa.com/payment/start?install_id=${INSTALL_ID}`,
            { method: 'POST' }
        );
        const data = await res.json();

        const btcAddr = data.btc_address;
        const amount = data.amount_btc;

        const ov = document.getElementById('licenseOverlay');
        ov.style.display = 'flex';

        document.getElementById('licenseQr').src =
            `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=bitcoin:${btcAddr}?amount=${amount}`;
        document.getElementById('licenseAddr').textContent = btcAddr;
        document.getElementById('licenseAmount').textContent = amount + ' BTC';

        pollPaymentStatus();
    } catch (e) {
        alert('Errore rete durante pagamento Bitcoin.');
    }
}

function pollPaymentStatus() {
    const timer = setInterval(async () => {
        try {
            const r = await fetch(
                `https://api.silentpwa.com/payment/status?install_id=${INSTALL_ID}`
            );
            const data = await r.json();

            if (data.status === 'pro') {
                clearInterval(timer);
                alert('Licenza PRO attivata.');
                document.getElementById('licenseOverlay').style.display = 'none';
                location.reload();
            }
        } catch {}
    }, 5000);
}

document.getElementById('licenseBuyBtn').onclick = startBitcoinPayment;
document.getElementById('licenseDemoBtn').onclick = () => {
    document.getElementById('licenseOverlay').style.display = 'none';
};

// ------------------------------------------------------
// NOTIFICATION INCOMING
// ------------------------------------------------------

async function notifyIncoming(kind) {
    if (!document.hidden) return;

    unreadCount++;
    setBadge(unreadCount);
    playBeep();

    if ('Notification' in window && Notification.permission === 'granted') {
        const reg = await navigator.serviceWorker.getRegistration();
        reg?.showNotification('Silent', {
            body:
                kind === 'text'
                    ? 'Nuovo messaggio'
                    : kind === 'image'
                    ? 'Nuova foto'
                    : 'Nuovo audio',
            icon: './icons/notify.png',
            badge: './icons/notify.png',
        });
    }
}

// ------------------------------------------------------
// CHAT UI
// ------------------------------------------------------

function escapeHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function addMsg(text, who = 'peer') {
    const li = document.createElement('li');
    li.className = who;
    li.textContent = text;
    els.log.appendChild(li);
    els.log.scrollTop = els.log.scrollHeight;

    if (who === 'peer') notifyIncoming('text');

    setTimeout(() => li.remove(), 5 * 60 * 1000);
}

// ------------------------------------------------------
// KEY MANAGEMENT + RESTORE CACHE (30 giorni)
// ------------------------------------------------------

const KEYCACHE_KEY = 'e2e_keycache_v1';
const KEYCACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function loadKeyCache() {
    try {
        const raw = localStorage.getItem(KEYCACHE_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (Date.now() > obj.expiresAt) {
            localStorage.removeItem(KEYCACHE_KEY);
            return null;
        }
        return obj;
    } catch {
        return null;
    }
}

async function saveKeyCache({ priv, pub, peer }) {
    const payload = {
        myPrivJwk: priv,
        myPubRawB64: pub,
        peerPubRawB64: peer,
        expiresAt: Date.now() + KEYCACHE_TTL_MS,
    };
    localStorage.setItem(KEYCACHE_KEY, JSON.stringify(payload));
}

async function tryRestoreFromCache() {
    const c = loadKeyCache();
    if (!c) return false;

    try {
        await e2e.restoreFromCache(c);
        sessionStarted = true;
        return true;
    } catch {
        localStorage.removeItem(KEYCACHE_KEY);
        return false;
    }
}

// ------------------------------------------------------
// FOTO (compress + menu)
// ------------------------------------------------------

async function blobToBase64(blob) {
    return new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result.split(',')[1]);
        fr.readAsDataURL(blob);
    });
}

async function imageToJpeg(img, max = 1280, quality = 0.85) {
    const r = Math.min(max / img.naturalWidth, max / img.naturalHeight, 1);
    const w = Math.round(img.naturalWidth * r);
    const h = Math.round(img.naturalHeight * r);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);

    return new Promise((resolve) =>
        canvas.toBlob(
            (b) => resolve({ blob: b, w, h }),
            'image/jpeg',
            quality
        )
    );
}

async function handleFile(file) {
    if (window.__LICENSE_STATUS__ !== 'pro') {
        alert('Solo PRO può inviare foto.');
        return;
    }

    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();

    const { blob } = await imageToJpeg(img);
    const b64 = await blobToBase64(blob);

    const enc = await e2e.encrypt(b64);
    ws.send(
        JSON.stringify({
            type: 'image',
            iv: enc.iv,
            ct: enc.ct,
            mime: 'image/jpeg',
        })
    );

    const url = URL.createObjectURL(blob);
    const li = document.createElement('li');
    li.className = 'me';
    const im = document.createElement('img');
    im.src = url;
    im.style.maxWidth = '70%';
    li.appendChild(im);
    els.log.appendChild(li);
    els.log.scrollTop = els.log.scrollHeight;

    setTimeout(() => {
        URL.revokeObjectURL(url);
        li.remove();
    }, 5 * 60 * 1000);
}

// CONTINUA IN PARTE 2…
// ------------------------------------------------------
// AUDIO – registrazione 60s
// ------------------------------------------------------

let mediaStream = null;
let mediaRecorder = null;
let audioChunks = [];
let audioMime = 'audio/webm;codecs=opus';
let audioTimer = null;

function pickBestAudioMime() {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    for (const t of types) {
        if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return 'audio/webm';
}

async function startRecording() {
    if (window.__LICENSE_STATUS__ !== 'pro') {
        alert('Solo PRO può inviare audio.');
        return;
    }
    if (!isConnected || !e2e.ready) {
        alert('Non connesso.');
        return;
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioMime = pickBestAudioMime();
    audioChunks = [];

    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: audioMime });
    mediaRecorder.ondataavailable = (ev) => audioChunks.push(ev.data);

    mediaRecorder.onstop = async () => {
        clearTimeout(audioTimer);
        mediaStream.getTracks().forEach((t) => t.stop());

        const blob = new Blob(audioChunks, { type: audioMime });
        const b64 = await blobToBase64(blob);

        if (b64.length > 300000) {
            addMsg('Audio troppo lungo.', 'me');
            return;
        }

        const enc = await e2e.encrypt(b64);

        ws.send(
            JSON.stringify({
                type: 'audio',
                iv: enc.iv,
                ct: enc.ct,
                mime: audioMime,
            })
        );

        const url = URL.createObjectURL(blob);
        const li = document.createElement('li');
        li.className = 'me';
        const player = document.createElement('audio');
        player.controls = true;
        player.src = url;
        li.appendChild(player);
        els.log.appendChild(li);
        els.log.scrollTop = els.log.scrollHeight;

        setTimeout(() => {
            URL.revokeObjectURL(url);
            li.remove();
        }, 5 * 60 * 1000);
    };

    mediaRecorder.start(1000);

    audioTimer = setTimeout(() => {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
            addMsg('⏱️ Fine registrazione (60s).', 'me');
        }
    }, 60000);
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

// ------------------------------------------------------
// PWA INSTALL
// ------------------------------------------------------

let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
});

els.installBtn.onclick = async () => {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
    } else {
        alert('Per installare: usa "Aggiungi alla schermata Home".');
    }
};

// ------------------------------------------------------
// WEBSOCKET
// ------------------------------------------------------

function setConnState(ok) {
    isConnected = ok;
    els.connStatus.textContent = ok ? 'Connesso' : 'Disconnesso';
}

async function connectWS() {
    if (isConnecting || isConnected) return;
    isConnecting = true;

    let wsUrl = FORCED_WS;
    const sep = wsUrl.includes('?') ? '&' : '?';
    wsUrl += `${sep}install_id=${INSTALL_ID}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = async () => {
        isConnecting = false;
        setConnState(true);

        await e2e.init();
        myPubExpected = e2e.myPubRaw;

        els.myPub.value = myPubExpected;

        if (!(await tryRestoreFromCache())) {
            ws.send(JSON.stringify({ type: 'key', raw: myPubExpected }));
        }
    };

    ws.onclose = () => {
        isConnected = false;
        isConnecting = false;
        setConnState(false);
        setTimeout(connectWS, 2000);
    };

    ws.onmessage = async (ev) => {
        let msg;
        try {
            msg = JSON.parse(ev.data);
        } catch {
            return;
        }

        if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
        }

        if (msg.type === 'presence') return;

        if (msg.type === 'license_update' && msg.status === 'pro') {
            document.getElementById('demo-badge').hidden = true;
            document.getElementById('licenseOverlay').hidden = true;
            window.__LICENSE_STATUS__ = 'pro';
            return;
        }

        if (msg.type === 'key') {
            const peerRaw = msg.raw?.trim();
            if (!peerRaw) return;

            if (!sessionStarted) {
                pendingPeerKey = peerRaw;
                return;
            }

            await e2e.setPeerPublicKey(peerRaw);
            e2e.peerPubRawB64 = peerRaw;
            return;
        }

        if (!e2e.ready) return;

        if (msg.type === 'msg') {
            const t = await e2e.decrypt(msg.iv, msg.ct);
            addMsg(t, 'peer');
            return;
        }

        if (msg.type === 'image') {
            const b64 = await e2e.decrypt(msg.iv, msg.ct);
            const bin = atob(b64);
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);

            const blob = new Blob([buf], { type: msg.mime });
            const url = URL.createObjectURL(blob);

            const li = document.createElement('li');
            li.className = 'peer';
            const img = document.createElement('img');
            img.src = url;
            img.style.maxWidth = '70%';
            li.appendChild(img);
            els.log.appendChild(li);
            els.log.scrollTop = els.log.scrollHeight;

            setTimeout(() => {
                URL.revokeObjectURL(url);
                li.remove();
            }, 5 * 60 * 1000);

            notifyIncoming('image');
            return;
        }

        if (msg.type === 'audio') {
            const b64 = await e2e.decrypt(msg.iv, msg.ct);
            const bin = atob(b64);
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);

            const blob = new Blob([buf], { type: msg.mime });
            const url = URL.createObjectURL(blob);

            const li = document.createElement('li');
            li.className = 'peer';
            const audio = document.createElement('audio');
            audio.controls = true;
            audio.src = url;
            li.appendChild(audio);
            els.log.appendChild(li);
            els.log.scrollTop = els.log.scrollHeight;

            setTimeout(() => {
                URL.revokeObjectURL(url);
                li.remove();
            }, 5 * 60 * 1000);

            notifyIncoming('audio');
            return;
        }
    };
}

// ------------------------------------------------------
// SESSION START
// ------------------------------------------------------

els.startBtn.onclick = async () => {
    await e2e.init();
    sessionStarted = true;

    let peer = els.peerPub.value.trim();
    if (!peer && pendingPeerKey) peer = pendingPeerKey;
    if (!peer) {
        alert('Inserisci la chiave del peer.');
        return;
    }

    await e2e.setPeerPublicKey(peer);
    e2e.peerPubRawB64 = peer;

    ws.send(JSON.stringify({ type: 'key', raw: e2e.myPubRaw }));

    const priv = await crypto.subtle.exportKey('jwk', e2e.ecKeyPair.privateKey);
    await saveKeyCache({
        priv,
        pub: e2e.myPubRaw,
        peer,
    });
};

// ------------------------------------------------------
// SEND TEXT
// ------------------------------------------------------

els.sendBtn.onclick = async () => {
    if (window.__LICENSE_STATUS__ !== 'pro') {
        alert('Solo PRO può inviare messaggi.');
        return;
    }

    if (!isConnected || !e2e.ready) {
        alert('Non connesso.');
        return;
    }

    let t = els.input.value.trim();
    if (!t) return;

    const enc = await e2e.encrypt(t);

    ws.send(
        JSON.stringify({
            type: 'msg',
            iv: enc.iv,
            ct: enc.ct,
        })
    );

    addMsg(t, 'me');
    els.input.value = '';
};

els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        els.sendBtn.click();
    }
});

// ------------------------------------------------------
// UTILITY BUTTONS
// ------------------------------------------------------

document.getElementById('clearBtn').onclick = () => {
    els.log.innerHTML = '';
};

els.copyMyBtn.onclick = () => {
    navigator.clipboard.writeText(els.myPub.value);
};

// ------------------------------------------------------
// PHOTO MENU (NUOVO)
// ------------------------------------------------------

const photoBtn = document.getElementById('photoBtn');
const cameraInput = document.getElementById('cameraInput');
const galleryInput = document.getElementById('galleryInput');

photoBtn.onclick = () => {
    document.getElementById('photoMenu').style.display = 'block';
};

document.getElementById('pmCamera').onclick = () => {
    document.getElementById('photoMenu').style.display = 'none';
    cameraInput.click();
};

document.getElementById('pmGallery').onclick = () => {
    document.getElementById('photoMenu').style.display = 'none';
    galleryInput.click();
};

document.getElementById('pmClose').onclick = () => {
    document.getElementById('photoMenu').style.display = 'none';
};

cameraInput.onchange = () => {
    if (cameraInput.files[0]) handleFile(cameraInput.files[0]);
    cameraInput.value = '';
};

galleryInput.onchange = () => {
    if (galleryInput.files[0]) handleFile(galleryInput.files[0]);
    galleryInput.value = '';
};

// ------------------------------------------------------
// AUDIO BUTTONS
// ------------------------------------------------------

document.getElementById('recBtn').onclick = startRecording;
document.getElementById('stopBtn').onclick = stopRecording;

// ------------------------------------------------------
// AUTOBOOT
// ------------------------------------------------------

(async function () {
    await initLicense();
    await e2e.init();
    connectWS();
})();
