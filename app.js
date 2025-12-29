// app.js — Silent PWA (testo, foto, audio E2E) con cache chiavi 5 minuti

const SERVER_BASE = (location.hostname === 'localhost')
  ? 'http://localhost:8000'
  : 'https://api.silentpwa.com';


import { E2E, fingerprintFromRawBase64 } from './crypto.js';
import { applyLang } from './i18n.js';

window.addEventListener('DOMContentLoaded', () => {
  // ===== Config =====
   // ===== Config =====
  const AUTO_WS_URL = 'wss://api.silentpwa.com/ws?room=test';
  const qs = new URLSearchParams(location.search);
  const FORCED_WS = qs.get('ws') || AUTO_WS_URL;
  const API_BASE_URL = (qs.get('api') || 'https://api.silentpwa.com').replace(/\/$/, '');
  
  // -------------------------------
// INSTALLATION ID (unico per ogni dispositivo)
// -------------------------------
let install_id = localStorage.getItem("install_id");

if (!install_id) {
    install_id = crypto.randomUUID();
    localStorage.setItem("install_id", install_id);
}

console.log("INSTALL ID:", install_id);


    // ===== Licenza / BTCPay =====
  function getInstallId() {
    try {
      let id = localStorage.getItem('silent_install_id');
      if (!id) {
        if (crypto.randomUUID) {
          id = crypto.randomUUID();
        } else {
          id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
        }
        localStorage.setItem('silent_install_id', id);
      }
      return id;
    } catch (e) {
      console.warn('Impossibile usare localStorage per install_id', e);
      return 'no-storage-' + Date.now().toString(36);
    }
  }

  const INSTALL_ID = getInstallId();
  let licenseStatus = 'unknown';
  let licensePollTimer = null;
  let lastLicensePayload = null;

  async function fetchLicenseStatus(showErrors) {
    try {
      const res = await fetch(`${API_BASE_URL}/license/status?install_id=${encodeURIComponent(INSTALL_ID)}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const prevStatus = licenseStatus;
      licenseStatus = data.status;
      lastLicensePayload = data;
      updateLicenseOverlay();
      if (prevStatus !== 'pro' && licenseStatus === 'pro') {
        console.info('Licenza PRO attivata');
      }
    } catch (err) {
      if (showErrors) {
        console.error('Errore fetch /license/status', err);
      }
    }
  }

  function isFeatureAllowed(feature) {
    if (licenseStatus === 'pro') return true;
    if (licenseStatus === 'trial') return true; // trial = tutto sbloccato
    // demo
    if (feature === 'text') return true; // in demo permettiamo solo testo
    return false;
  }

  function updateLicenseOverlay() {
    const overlay = document.getElementById('licenseOverlay');
    const titleEl = document.getElementById('licenseTitle');
    const msgEl = document.getElementById('licenseMessage');
    const extraEl = document.getElementById('licenseCountdown');
    if (!overlay || !titleEl || !msgEl || !extraEl) return;

    if (licenseStatus === 'pro') {
      overlay.style.display = 'none';
      document.body.classList.remove('demo-mode');
      return;
    }

    document.body.classList.add('demo-mode');

    let title = '';
    let msg = '';
    let extra = '';

    if (licenseStatus === 'trial') {
      title = 'Trial attivo';
      msg = 'Hai 24 ore di prova completa prima che l’app passi in modalità DEMO limitata.';
      if (lastLicensePayload && typeof lastLicensePayload.trial_hours_left === 'number') {
        const h = Math.max(0, lastLicensePayload.trial_hours_left);
        extra = `Ore rimanenti: ${h.toFixed(1)}`;
      }
      overlay.style.display = 'none'; // niente overlay bloccante durante il trial
    } else if (licenseStatus === 'demo') {
      title = 'Modalità DEMO';
      msg = 'Il periodo di prova è terminato. Alcune funzioni (foto, audio, ecc.) sono limitate finché non attivi la licenza PRO.';
      overlay.style.display = 'flex';
    }

    titleEl.textContent = title;
    msgEl.textContent = msg;
    extraEl.textContent = extra;
  }


function pollPaymentStatus() {
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`https://api.silentpwa.com/license/status?install_id=${install_id}`);
      const data = await res.json();

      if (data.status === "pro") {
        clearInterval(timer);
        alert("Pagamento ricevuto! Licenza PRO attivata.");
        const ov = document.getElementById('licenseOverlay');
        ov && ov.setAttribute('hidden','');
        updateLicenseOverlay();
      }

    } catch (e) { }
  }, 5000);
}


  function initLicenseUI() {
    const buyBtn = document.getElementById('licenseBuyBtn');
    const demoBtn = document.getElementById('licenseDemoBtn');
  if (buyBtn) buyBtn.onclick = showBitcoinQrOnly;
    if (demoBtn) demoBtn.addEventListener('click', () => {
      const overlay = document.getElementById('licenseOverlay');
      if (overlay) overlay.style.display = 'none';
    });

    fetchLicenseStatus(true).then(() => {
      if (licenseStatus === 'demo') {
        const overlay = document.getElementById('licenseOverlay');
        if (overlay) overlay.style.display = 'flex';
      }
    });
    licensePollTimer = setInterval(() => fetchLicenseStatus(false), 15000);
  }

  initLicenseUI();



  // ===== Notifiche, Badge & Bip =====
  let beepEnabled = false;
  let audioCtx = null;
  let htmlAudio = null;
  let unreadCount = 0;
  const initialTitle = document.title;

  function setupBeep(){
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) { console.warn('AudioContext non disponibile', e); }
    }
    if (!htmlAudio) {
      try {
        const wavB64 = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABYAAAACAAACAAAAPwAAAP8AAP//AAD//wAA//8AAP//AAD//wAAAP8AAAA/AAAAPwAAAP8AAP//AAD//wAA//8AAP//AAD//wAAAP8AAAA/AAAAPwAA";
        htmlAudio = new Audio("data:audio/wav;base64," + wavB64);
      } catch(e){}
    }
  }

  function playBeep(){
    try {
      if (audioCtx) {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = 1000;
        g.gain.value = 0.0001;
        o.connect(g); g.connect(audioCtx.destination);
        o.start();
        g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18);
        o.stop(audioCtx.currentTime + 0.2);
      } else if (htmlAudio) {
        htmlAudio.currentTime = 0; htmlAudio.play().catch(()=>{});
      }
    } catch(e){ console.warn('beep failed', e); }
  }

  async function showNotif(title, body){
    try{
      if (!('Notification' in window)) return;
      if (Notification.permission === 'granted') {
        const reg = await navigator.serviceWorker?.getRegistration?.();
        const targetUrl = (reg && reg.scope) ? (reg.scope + '#chat') : (location.origin + location.pathname + '#chat');
        const opts = {
          body,
          icon: './icons/notify.png',
          badge: './icons/notify.png',
          tag: 'silent-new-msg',
          renotify: true,
          data: { url: targetUrl },
          vibrate: [80,40,80],
          requireInteraction: false,
          silent: false
        };
        if (reg && reg.showNotification) {
          await reg.showNotification(title, opts);
        } else {
          new Notification(title, opts);
        }
      }
    }catch(e){ console.warn('notify failed', e); }
  }

  function setBadge(n){
    try{ if ('setAppBadge' in navigator) navigator.setAppBadge(n); }catch(_){}
    document.title = n > 0 ? `(${n}) ${initialTitle}` : initialTitle;
  }
  function clearBadge(){
    try{ if ('clearAppBadge' in navigator) navigator.clearAppBadge(); }catch(_){}
    unreadCount = 0; document.title = initialTitle;
  }

  function onIncoming(kind){
    if (document.hidden) {
      unreadCount++; setBadge(unreadCount);
      try{ if (beepEnabled && audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); }catch(_){}
      if (beepEnabled) { try{ playBeep(); }catch(_){} }
      showNotif('Silent', kind==='text' ? 'Nuovo messaggio' : (kind==='image' ? 'Nuova foto' : 'Nuovo audio'));
    }
  }

  document.addEventListener('visibilitychange', ()=>{ if (!document.hidden) clearBadge(); });
  window.addEventListener('focus', clearBadge);

  function updateToggleBtnUI(){
    const btn = document.getElementById('toggleBeepBtn');
    if (!btn) return;
    btn.setAttribute('aria-pressed', beepEnabled ? 'true' : 'false');
    btn.textContent = beepEnabled ? ': ON' : ': OFF';
  }

  try {
    const saved = localStorage.getItem('beepEnabled');
    if (saved === '1') { beepEnabled = true; setupBeep(); try{ if (audioCtx?.state === 'suspended') audioCtx.resume(); }catch(_){ } }
  } catch(_) {}
  updateToggleBtnUI();

  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (t && t.id === 'toggleBeepBtn') {
      ev.preventDefault(); ev.stopPropagation();
      beepEnabled = !beepEnabled;
      try{ localStorage.setItem('beepEnabled', beepEnabled ? '1' : '0'); }catch(_){}
      setupBeep();
      try{ if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); }catch(_){}
      try{ if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume(); }catch(_){}
      if (beepEnabled) { try{ playBeep(); }catch(_){} }
      updateToggleBtnUI();
    }
  });

  // Sblocco audio generico al primo gesto utente
  function unlockAudioOnce(){
    try{
      setupBeep();
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(()=>{});
      }
      try { playBeep(); } catch(_){}
    }catch(_){}
    document.removeEventListener('pointerdown', unlockAudioOnce);
    document.removeEventListener('touchstart', unlockAudioOnce);
    document.removeEventListener('keydown', unlockAudioOnce);
    document.removeEventListener('click', unlockAudioOnce);
  }
  document.addEventListener('pointerdown', unlockAudioOnce, { passive:true });
  document.addEventListener('touchstart', unlockAudioOnce, { passive:true });
  document.addEventListener('keydown', unlockAudioOnce);
  document.addEventListener('click', unlockAudioOnce);

  // ===== WS/E2E stato =====
  let ws = null;
  let e2e = new E2E();
  let isConnecting = false;
  let isConnected = false;
  let backoffMs = 2000;
  let shouldAutoReconnect = true;

  let deferredPrompt = null;

  let keysGenerated = false;
  let myPubExpected = null;

  let sessionStarted = false;
  let pendingPeerKey = null;

  // ===== Key cache (TTL 30 gg) =====
  const KEYCACHE_KEY = 'e2e_keycache_v1';
  const KEYCACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  function nowMs(){ return Date.now(); }

  function loadKeyCache(){
    try{
      const raw = localStorage.getItem(KEYCACHE_KEY);
      if(!raw) return null;
      const obj = JSON.parse(raw);
      if(!obj || !obj.expiresAt || nowMs() > obj.expiresAt){ localStorage.removeItem(KEYCACHE_KEY); return null; }
      return obj;
    }catch{ return null; }
  }

  function clearKeyCache(){ localStorage.removeItem(KEYCACHE_KEY); }

  async function saveKeyCache({ myPrivJwk, myPubRawB64, peerPubRawB64 }){
    const payload = {
      myPrivJwk,
      myPubRawB64,
      peerPubRawB64,
      expiresAt: nowMs() + KEYCACHE_TTL_MS
    };
    localStorage.setItem(KEYCACHE_KEY, JSON.stringify(payload));
  }

  function importEcdhPrivateFromJwk(jwk){
    return crypto.subtle.importKey(
      'jwk',
      jwk,
      { name:'ECDH', namedCurve:'P-256' },
      true,
      ['deriveKey','deriveBits']
    );
  }

  function importEcdhPublicRawB64(b64){
    const bin = Uint8Array.from(atob(b64), c=>c.charCodeAt(0));
    return crypto.subtle.importKey('raw', bin, {name:'ECDH', namedCurve:'P-256'}, true, []);
  }

  async function tryRestoreFromCache(){
    const c = loadKeyCache();
    if(!c) return false;

    try{
      const priv = await importEcdhPrivateFromJwk(c.myPrivJwk);
      const pub  = await importEcdhPublicRawB64(c.myPubRawB64);
      e2e.ecKeyPair = { privateKey: priv, publicKey: pub };

      if (c.peerPubRawB64){
        await e2e.setPeerPublicKey(c.peerPubRawB64);
        e2e.peerPubRawB64 = c.peerPubRawB64;
        sessionStarted = true;
      }

      if (els.connTitle) { els.connTitle.textContent=': utente connesso (E2E attiva)'; }
      if (els.myPub && !els.myPub.value) { els.myPub.value = c.myPubRawB64 || ''; }
      myPubExpected = c.myPubRawB64 || myPubExpected;

      return true;
    }catch(err){
      console.warn('Ripristino cache chiavi fallito:', err);
      clearKeyCache();
      return false;
    }
  }

  // ===== DEMO / LIMITI LICENZA (client) =====
  function canSendMessageNow(){
    const limits = window.__LICENSE_LIMITS__ || {};
    const minGap = limits.min_send_interval_sec || 0;
    const now = Date.now();
    const last = (window.__LAST_SEND_TS__ || 0);
    if (now - last < minGap*1000) return false;
    window.__LAST_SEND_TS__ = now;
    return true;
  }
  function sanitizeOutgoingText(text){
    const limits = window.__LICENSE_LIMITS__ || {};
    const max = limits.max_text_chars || Infinity;
    if (text.length > max) return text.slice(0, max);
    return text;
  }

  // ===== DOM =====
  const $ = (s) => document.querySelector(s);
  const els = {
    langSel:     $('#langSelect'),
    installBtn:  $('#installBtn'),
    clearBtn:    $('#clearBtn'),
    connTitle:   document.querySelector('[data-i18n="connection"]'),
    disconnectBtn: document.getElementById('disconnectBtn'),
    connStatus:  $('#connStatus'),
    fpStatus:    document.getElementById('fp-status'),
    myPub:       $('#myPub'),
    copyMyBtn:   $('#copyMyPubBtn'),
    peerPub:     $('#peerPub'),
    startBtn:    $('#startSessionBtn'),
    log:         $('#log'),
    input:       $('#msgInput'),
    sendBtn:     $('#sendBtn'),
    composer:    document.querySelector('.composer'),
  };

  // ===== iOS Install Detect =====
  function isIOS(){ return /iphone|ipad|ipod/i.test(navigator.userAgent); }
  function isStandalone(){ return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone; }
  function maybeShowIOSInstallBanner(){
    try{
      if (!isIOS()) return;
      if (isStandalone()) return;
      if (localStorage.getItem('hideIOSInstallBanner') === '1') return;
      const el = document.getElementById('iosInstallBanner');
      if (el) el.style.display = 'block';
      const btnClose = document.getElementById('iosInstallDismiss');
      const btnHide  = document.getElementById('iosInstallHide');
      btnClose && btnClose.addEventListener('click', ()=>{ el.style.display='none'; });
      btnHide  && btnHide.addEventListener('click', ()=>{ localStorage.setItem('hideIOSInstallBanner','1'); el.style.display='none'; });
    }catch(_){}
  }

  // ===== Manual Disconnect =====
  function manualDisconnect(){
    try { shouldAutoReconnect = false; } catch(_){}
    try { if (ws && (ws.readyState === 0 || ws.readyState === 1)) ws.close(); } catch(_) {}
    try { localStorage.removeItem('sessionVerified'); } catch(_) {}
    try { clearKeyCache && clearKeyCache(); } catch(_) {}
    SESSION_VERIFIED = false;
    pendingPeerKey = null;
    e2e = new E2E();
    setConnState(false);
    maybeShowIOSInstallBanner && maybeShowIOSInstallBanner();
    updateFpStatus && updateFpStatus();
    alert('Connessione interrotta. Puoi reinserire chiave e fingerprint.');
  }
  if (els.disconnectBtn){ els.disconnectBtn.addEventListener('click', manualDisconnect); }

  // === Fingerprint UI ===
  let SESSION_VERIFIED = localStorage.getItem('sessionVerified') === '1';
  const FP_BOX   = document.getElementById('fp-box');
  const MY_FP    = document.getElementById('my-fp');
  const PEER_FP  = document.getElementById('peer-fp');
  const COPY_MY_FP = document.getElementById('copy-my-fp');
  const CONFIRM_FP  = document.getElementById('confirm-fp');

  function updateFpStatus() {
    if (!els.fpStatus) return;

    const hasMy   = !!((MY_FP?.textContent || '').trim().length);
    const hasPeer = !!((PEER_FP?.textContent || '').trim().length);
    const hasFp   = hasMy && hasPeer;

    if (FP_BOX) { FP_BOX.classList.toggle('hidden', !hasFp); }

    if (!hasFp) {
      els.fpStatus.style.display = 'none';
      els.fpStatus.textContent = '';
      els.fpStatus.classList.remove('fp-ok','fp-warn');
      return;
    }

    els.fpStatus.style.display = 'block';
    if (SESSION_VERIFIED) {
      els.fpStatus.textContent = '✅ Codice verificato';
      els.fpStatus.classList.remove('fp-warn');
      els.fpStatus.classList.add('fp-ok');
    } else {
      els.fpStatus.textContent = '⚠️ codice non verificato';
      els.fpStatus.classList.remove('fp-ok');
      els.fpStatus.classList.add('fp-warn');
    }
  }

  function ensureVerifiedOrConfirm(){
    if (SESSION_VERIFIED) return true;
    return confirm('La chiave non è stata verificata. Vuoi inviare lo stesso?');
  }

  // === Presence Badge ===
  const presenceBadge = (() => {
    const badge = document.createElement('span');
    badge.id = 'peerPresence';
    badge.style.marginLeft = '8px';
    badge.style.padding = '2px 6px';
    badge.style.borderRadius = '12px';
    badge.style.fontSize = '12px';
    badge.style.background = '#eef2ff';
    badge.style.color = '#1e40af';
    badge.textContent = '';
    (els.connStatus?.parentElement || document.body).appendChild(badge);
    return badge;
  })();

  function updatePeerBadge(n){
    if (!presenceBadge) return;
    presenceBadge.textContent = (typeof n === 'number') ? `Peers: ${n}` : '';
    presenceBadge.style.display = (typeof n === 'number') ? 'inline-block' : 'none';
  }

  // ===== Utils =====
  const escapeHtml = (s) => (s ? s.replace(/[&<>\"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m])) : '');

  function addMsg(text, who = 'peer') {
    if (!els.log) return;
    const li = document.createElement('li');
    li.className = who;
    li.innerHTML = escapeHtml(text);
    els.log.appendChild(li);
    els.log.scrollTop = els.log.scrollHeight;
    if (who==='peer') onIncoming('text');
    setTimeout(() => li.remove(), 5*60*1000);
  }

  function addImage(url, who='peer'){
    if (!els.log) return;
    const li = document.createElement('li');
    li.className = who;
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'foto';
    img.style.maxWidth = '70%';
    img.style.borderRadius = '8px';
    li.appendChild(img);
    els.log.appendChild(li);
    els.log.scrollTop = els.log.scrollHeight;
    if (who==='peer') onIncoming('image');
    setTimeout(()=>{ URL.revokeObjectURL(url); li.remove(); }, 5*60*1000);
  }

  function addAudio(url, who='peer', mime='audio/webm'){
    if (!els.log) return;
    const li = document.createElement('li');
    li.className = who;
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = url;
    audio.type = mime;
    audio.style.maxWidth = '70%';
    audio.style.display = 'block';
    li.appendChild(audio);
    els.log.appendChild(li);
    els.log.scrollTop = els.log.scrollHeight;
    if (who==='peer') onIncoming('audio');
    setTimeout(()=>{ URL.revokeObjectURL(url); li.remove(); }, 5*60*1000);
  }

  function blobToImage(blob){
    return new Promise((resolve,reject)=>{
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = ()=>{ URL.revokeObjectURL(url); resolve(img); };
      img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('Immagine non valida')); };
      img.src = url;
    });
  }
  function imageToJpegBlob(img, {maxW=1280, maxH=1280, quality=0.85}={}){
    const w = img.naturalWidth, h = img.naturalHeight;
    const r = Math.min(maxW/w, maxH/h, 1);
    const nw = Math.round(w*r), nh = Math.round(h*r);
    const canvas = document.createElement('canvas');
    canvas.width = nw; canvas.height = nh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, nw, nh);
    return new Promise((resolve)=>{
      if (canvas.toBlob){
        canvas.toBlob(b => resolve({ blob: b, width: nw, height: nh }), 'image/jpeg', quality);
      } else {
        const dataURL = canvas.toDataURL('image/jpeg', quality);
        fetch(dataURL).then(r=>r.blob()).then(b=>resolve({ blob:b, width:nw, height:nh }));
      }
    });
  }
  function blobToBase64(blob){
    return new Promise((resolve,reject)=>{
      const reader = new FileReader();
      reader.onload = ()=> {
        const dataUrl = reader.result || '';
        resolve(String(dataUrl).split(',')[1] || '');
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  function b64ToAb(b64){
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
    return bytes.buffer;
  }

  async function adaptAndEncodeImage(originalImg){
    const targets = [
      {max:960,q:0.80},{max:720,q:0.76},{max:600,q:0.74},
      {max:480,q:0.72},{max:360,q:0.70},
    ];
    const SAFE_B64_LEN = 300_000; // ~225KB reali

    let lastBlob=null,lastW=null,lastH=null,lastB64=null;

    for (const t of targets){
      const {blob,width,height} = await imageToJpegBlob(originalImg,{maxW:t.max,maxH:t.max,quality:t.q});
      const b64 = await blobToBase64(blob);
      lastBlob=blob; lastW=width; lastH=height; lastB64=b64;
      if (b64.length <= SAFE_B64_LEN){
        return { b64, width, height, blob };
      }
    }
    return { b64:lastB64, width:lastW, height:lastH, blob:lastBlob };
  }

  // ===== I18N & SW =====
  els.langSel && els.langSel.addEventListener('change', ()=>{
    applyLang(els.langSel.value);
    try { const _c=document.getElementById('clearBtn'); if (_c) _c.textContent='Svuota chat'; } catch(_) {}
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');

  // ===== Stato Connessione =====
  function setConnState(connected){
    isConnected = !!connected;
    const txt = connected ? 'connesso al server' : 'non connesso al server';
    const color = connected ? '#16a34a' : '#dc2626';
    if (els.connTitle){
      els.connTitle.textContent = `: ${txt}`;
      els.connTitle.style.color=color; els.connTitle.style.fontWeight='700';
    }
    if (els.connStatus){
      els.connStatus.textContent = connected?'Connesso al server':'Non connesso al server';
      els.connStatus.classList.toggle('connected',connected);
      els.connStatus.classList.toggle('disconnected',!connected);
    }
    if (els.disconnectBtn) { els.disconnectBtn.style.display = connected ? '' : 'none'; }
  }
  setConnState(false);
  maybeShowIOSInstallBanner && maybeShowIOSInstallBanner();

  // ===== Install PWA =====
  window.addEventListener('beforeinstallprompt',(e)=>{e.preventDefault(); deferredPrompt=e;});
  els.installBtn && els.installBtn.addEventListener('click', async ()=>{
    if (deferredPrompt){ deferredPrompt.prompt(); try{await deferredPrompt.userChoice;}catch{} deferredPrompt=null; return;}
    const isIOS=/iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone=window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone;
    if (isStandalone) alert('L’app è già installata.');
    else if (isIOS) alert('iPhone/iPad: Condividi → Aggiungi alla schermata Home.');
    else alert('Menu browser → Installa app / Aggiungi alla schermata Home.');
  });

  // ===== E2E =====
  async function ensureKeys(){
    if (keysGenerated) return;
    if (!e2e.myPubRaw){
      const pub=await e2e.init();
      myPubExpected=pub;
      if (els.myPub) els.myPub.value=pub;
      if (els.myPub){
        els.myPub.readOnly=true;
        els.myPub.addEventListener('input',()=>{ if(myPubExpected&&els.myPub.value!==myPubExpected) els.myPub.value=myPubExpected; });
      }
    }
    keysGenerated=true;
  }

  // Copia chiave – feedback veloce
  els.copyMyBtn && els.copyMyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(els.myPub?.value || '');
      if (els.connTitle) {
        els.connTitle.textContent = ': chiave copiata ✔';
        els.connTitle.style.color = '#16a34a';
        setTimeout(() => setConnState(isConnected), 1200);
      }
    } catch (e) {
      alert('Impossibile copiare: ' + e.message);
    }
  });

  // ===== WebSocket =====
  async function connect(){
    if (isConnecting||isConnected) return;
    isConnecting=true; setConnState(false);
    maybeShowIOSInstallBanner && maybeShowIOSInstallBanner();

    // Passa install_id nella URL del WS
   let wsUrl = FORCED_WS;

// Aggiungi room=test se non c’è già
if (!wsUrl.includes("room=")) {
  const sep = wsUrl.includes("?") ? "&" : "?";
  wsUrl = `${wsUrl}${sep}room=test`;
}

try {
  const installId = await ensureInstallId();
  wsUrl = `${wsUrl}&install_id=${encodeURIComponent(installId)}`;
} catch (e) {
  isConnecting = false;
  return;
}

    try{ ws=new WebSocket(wsUrl);}catch(e){ isConnecting=false; return;}

    ws.addEventListener('open',async ()=>{
      isConnecting=false; setConnState(true); backoffMs=2000;
      await ensureKeys();

      // tenta ripristino chiavi
      if (await tryRestoreFromCache()){
        if (localStorage.getItem('sessionVerified') === '1') {
          SESSION_VERIFIED = true;
        }
        updateFpStatus();
        try{
          const myRaw = myPubExpected || (els.myPub?.value || '');
          if (myRaw && ws && ws.readyState === 1){
            ws.send(JSON.stringify({ type:'key', raw: myRaw }));
          }
        }catch(_){}
      }
    });

    ws.addEventListener('close',()=>{
      updatePeerBadge(null);
      isConnecting=false; setConnState(false);
      maybeShowIOSInstallBanner && maybeShowIOSInstallBanner();
      sessionStarted=false; pendingPeerKey=null;
      if (shouldAutoReconnect) setTimeout(connect, backoffMs = Math.min(backoffMs*2, 15000));
    });

    ws.addEventListener('message',async ev=>{
      try{
        const msg=JSON.parse(ev.data);
        if (msg.type==='ping'){ try{ ws?.send(JSON.stringify({type:'pong'})); }catch(e){} return; }
        if (msg.type==='presence'){ if (typeof msg.peers==='number') updatePeerBadge(msg.peers); return; }

        // === Gestione licenza via WS ===
        if (msg.type === 'license_expired') {
          const ov = document.getElementById('license-overlay');
          ov && ov.removeAttribute('hidden');
          return;
        }
        if (msg.type === 'license_update' && msg.status === 'pro') {
          window.__LICENSE_STATUS__ = 'pro';
          const ov = document.getElementById('license-overlay');
          const badge = document.getElementById('demo-badge');
          ov && ov.setAttribute('hidden','');
          badge && badge.setAttribute('hidden','');
          return;
        }

        // === E2E messaggi ===
        if (msg.type==='key'){
          await ensureKeys();
          const peerRaw=(msg.raw||'').trim();
          if (!peerRaw||peerRaw===(myPubExpected||els.myPub?.value||'').trim()) return;
          if (!sessionStarted){ pendingPeerKey=peerRaw; return;}
          await e2e.setPeerPublicKey(peerRaw); e2e.peerPubRawB64=peerRaw;
          if (els.connTitle) els.connTitle.textContent=': utente connesso (E2E attiva)';
          return;
        }
        if (!e2e.ready) return;
        if (msg.type==='msg'){ addMsg(await e2e.decrypt(msg.iv,msg.ct),'peer'); return;}
        if (msg.type==='image'){ const b64=await e2e.decrypt(msg.iv,msg.ct); const buf=b64ToAb(b64); const blob=new Blob([buf],{type:msg.mime||'image/jpeg'}); addImage(URL.createObjectURL(blob),'peer'); return;}
        if (msg.type==='audio'){ const b64=await e2e.decrypt(msg.iv,msg.ct); const buf=b64ToAb(b64); const blob=new Blob([buf],{type:msg.mime||'audio/webm'}); addAudio(URL.createObjectURL(blob),'peer',msg.mime); return;}
      }catch(e){console.error(e);} 
    });
  }

  // ===== Avvia sessione =====
  els.startBtn && els.startBtn.addEventListener('click',async ()=>{
    await ensureKeys();
    sessionStarted=true;
    let peerRaw=(els.peerPub?.value||'').trim();
    if (!peerRaw&&pendingPeerKey) peerRaw=pendingPeerKey;
    if (!peerRaw) return alert('Incolla la chiave del peer o attendi.');

    try {
      await e2e.setPeerPublicKey(peerRaw);
      e2e.peerPubRawB64=peerRaw;

      // === Fingerprint: calcola e mostra ===
      try {
        const myRaw = myPubExpected || (els.myPub?.value || '');
        if (myRaw)  MY_FP   && (MY_FP.textContent   = await fingerprintFromRawBase64(myRaw));
        if (peerRaw)PEER_FP && (PEER_FP.textContent = await fingerprintFromRawBase64(peerRaw));

        SESSION_VERIFIED = false;
        localStorage.removeItem('sessionVerified');
        updateFpStatus();

        COPY_MY_FP?.addEventListener('click', () => { navigator.clipboard?.writeText(MY_FP?.textContent||''); }, { once: true });

        CONFIRM_FP?.addEventListener('click', () => {
          SESSION_VERIFIED = true;
          localStorage.setItem('sessionVerified','1');
          updateFpStatus();
          try{ addSystemMsg && addSystemMsg('Codice verificato: fingerprint coincidenti'); }catch{}
          setTimeout(() => {
            const details = document.querySelector('details');
            if (details) details.open = false;
          }, 2000);
        }, { once: true });

      } catch(_){/* ignore */}
      if (ws&&ws.readyState===1){
        ws.send(JSON.stringify({type:'key',raw:myPubExpected||(els.myPub?.value||'')}));
      }

      // salva cache
      try{
        const myPrivJwk = await crypto.subtle.exportKey('jwk', e2e.ecKeyPair.privateKey);
        const myPubRawB64 = myPubExpected || (els.myPub?.value || '');
        await saveKeyCache({ myPrivJwk, myPubRawB64, peerPubRawB64: peerRaw });
      }catch(err){
        console.warn('Cache chiavi non salvata:', err);
      }

      if (els.connTitle) els.connTitle.textContent=': utente connesso (E2E attiva)';

    } catch (err) {
      console.error('Errore Avvia sessione:', err);
      alert('Errore avvio sessione: ' + (err?.message || err));
    }
  });

  // ===== Invia testo =====
  els.sendBtn && els.sendBtn.addEventListener('click',async ()=>{
    if (!ensureVerifiedOrConfirm()) return;

    // enforcement demo (rate limit + truncate)
    if ((window.__LICENSE_STATUS__ || 'trial') !== 'pro') {
      if (!canSendMessageNow()) { alert('Limite di invio in modalità demo.'); return; }
    }

    if (!isConnected||!e2e.ready) return alert('Non connesso o E2E non pronto');
    let text=(els.input?.value||'').trim(); if (!text) return;
    text = sanitizeOutgoingText(text);
    const {iv,ct}=await e2e.encrypt(text);
    if (ws&&ws.readyState===1) ws.send(JSON.stringify({type:'msg',iv,ct}));
    addMsg(text,'me'); if (els.input) els.input.value='';
  });
  els.input && els.input.addEventListener('keydown',(e)=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); els.sendBtn.click(); }});
  els.clearBtn && els.clearBtn.addEventListener('click',()=>{ if(els.log) els.log.innerHTML=''; });

  // ===== Foto: mini-menu =====
  function ensurePhotoControls(){
    if (!els.composer || document.getElementById('photoBtn')) return;

    const photoBtn = document.createElement('button');
    photoBtn.id = 'photoBtn';
    photoBtn.textContent = 'Foto';
    photoBtn.title = 'Scatta o scegli dalla galleria';
    photoBtn.style.marginLeft = '6px';
    els.composer.appendChild(photoBtn);

    const cameraInput  = document.createElement('input');
    cameraInput.type = 'file';
    cameraInput.accept = 'image/*';
    cameraInput.capture = 'environment';
    cameraInput.style.display = 'none';

    const galleryInput = document.createElement('input');
    galleryInput.type = 'file';
    galleryInput.accept = 'image/*';
    galleryInput.style.display = 'none';

    document.body.appendChild(cameraInput);
    document.body.appendChild(galleryInput);

    if (getComputedStyle(els.composer).position === 'static') {
      els.composer.style.position = 'relative';
    }

    const menu = document.createElement('div');
    menu.id = 'photoMenu';
    menu.style.position = 'absolute';
    menu.style.left = '50%';
    menu.style.top = '50%';
    menu.style.transform = 'translate(-50%, -50%)';
    menu.style.background = '#ffffff';
    menu.style.border = '1px solid #e5e7eb';
    menu.style.boxShadow = '0 10px 15px rgba(0,0,0,0.1), 0 4px 6px rgba(0,0,0,0.05)';
    menu.style.borderRadius = '10px';
    menu.style.padding = '8px';
    menu.style.display = 'none';
    menu.style.zIndex = '9999';
    menu.innerHTML = `
      <button type="button" data-act="camera" style="display:block;width:160px;padding:8px;border-radius:8px;border:1px solid #e5e7eb;margin:4px 0;background:#f9fafb;">📷 Scatta</button>
      <button type="button" data-act="gallery" style="display:block;width:160px;padding:8px;border-radius:8px;border:1px solid #e5e7eb;margin:4px 0;background:#f9fafb;">🖼️ Galleria</button>
      <button type="button" data-act="close" style="display:block;width:160px;padding:6px;border:none;margin:2px 0;background:transparent;color:#6b7280;">Annulla</button>
    `;
    els.composer.appendChild(menu);

    const openMenu  = () => { menu.style.display = 'block'; };
    const closeMenu = () => { menu.style.display = 'none'; };

    photoBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (menu.style.display === 'block') closeMenu();
      else openMenu();
    });

    menu.addEventListener('click', (e) => {
      const act = e.target?.getAttribute('data-act');
      if (act === 'camera') {
        closeMenu();
        cameraInput.click();
      } else if (act === 'gallery') {
        closeMenu();
        galleryInput.click();
      } else if (act === 'close') {
        closeMenu();
      }
    });

    document.addEventListener('click', (e) => {
      const clickedInside = menu.contains(e.target) || e.target === photoBtn;
      if (!clickedInside) closeMenu();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });

    cameraInput.addEventListener('change', () => {
      if (cameraInput.files && cameraInput.files[0]) {
        closeMenu();
        handleFile(cameraInput.files[0]);
        cameraInput.value = '';
      }
    });
    galleryInput.addEventListener('change', () => {
      if (galleryInput.files && galleryInput.files[0]) {
        closeMenu();
        handleFile(galleryInput.files[0]);
        galleryInput.value = '';
      }
    });
  }

  const IMG_MAX_B64_SAFE = 300_000; // ~225KB effettivi

    async function handleFile(file){
    if (!isFeatureAllowed('image')) {
      alert('In modalità DEMO puoi inviare solo messaggi di testo. Passa a PRO per inviare foto.');
      const overlay = document.getElementById('licenseOverlay');
      if (overlay && licenseStatus === 'demo') overlay.style.display = 'flex';
      return;
    }
    if (!file||!isConnected||!e2e.ready) return;


    // In demo blocca invio immagini
    if ((window.__LICENSE_STATUS__ || 'trial') !== 'pro') {
      alert('La condivisione di immagini è disponibile solo nella versione PRO.');
      return;
    }

    try{
      const img = await blobToImage(file);

      // Prima passata con profili progressivi
      let { b64, width, height, blob } = await adaptAndEncodeImage(img);

      // Se ancora troppo grande, compressione aggressiva 320px
      if (b64.length > IMG_MAX_B64_SAFE) {
        const tiny = await imageToJpegBlob(img, { maxW: 320, maxH: 320, quality: 0.68 });
        const tinyB64 = await blobToBase64(tiny.blob);

        if (tinyB64.length > IMG_MAX_B64_SAFE) {
          addMsg('⚠️ Immagine troppo grande anche dopo compressione. Riprova con una foto più piccola.', 'me');
          return;
        }
        b64 = tinyB64; width = tiny.width; height = tiny.height; blob = tiny.blob;
      }

      // Cifratura + invio (con fallback estremo se la cifratura dovesse fallire)
      try {
        if (!ensureVerifiedOrConfirm()) return;
        const { iv, ct } = await e2e.encrypt(b64);
        if (ws && ws.readyState === 1){
          ws.send(JSON.stringify({ type:'image', iv, ct, mime:'image/jpeg', w:width, h:height }));
        }
        addImage(URL.createObjectURL(blob), 'me');
      } catch (encErr) {
        console.warn('Encrypt immagine fallita, riprovo a 320px:', encErr);
        const tiny2 = await imageToJpegBlob(img, { maxW: 320, maxH: 320, quality: 0.68 });
        const tinyB64_2 = await blobToBase64(tiny2.blob);
        if (tinyB64_2.length > IMG_MAX_B64_SAFE) {
          addMsg('⚠️ Immagine troppo grande per invio sicuro.', 'me');
          return;
        }
        const { iv, ct } = await e2e.encrypt(tinyB64_2);
        if (ws && ws.readyState === 1){
          ws.send(JSON.stringify({ type:'image', iv, ct, mime:'image/jpeg', w:tiny2.width, h:tiny2.height }));
        }
        addImage(URL.createObjectURL(tiny2.blob), 'me');
      }

    }catch(err){
      console.error('Errore invio foto:', err);
      alert('Errore invio foto: ' + (err && err.message ? err.message : err));
    }
  }

  // ===== AUDIO =====
  let mediaStream=null, mediaRecorder=null, audioChunks=[], audioMime='audio/webm;codecs=opus', audioTimer=null;
  const MAX_B64_SAFE=300_000;

  // --- Badge countdown accanto a "Chat"
  let recBadge = null;
  let countdownInterval = null;
  let remainingSec = 60;

  function findChatTitleElement() {
    return (
      document.querySelector('[data-i18n="chat"]') ||
      document.querySelector('#chatTitle') ||
      Array.from(document.querySelectorAll('h1,h2,h3,.title,.header'))
        .find(el => (el.textContent || '').trim().toLowerCase().includes('chat'))
    );
  }

  function ensureRecBadge() {
    const target = findChatTitleElement();
    if (!target) return null;
    if (!recBadge) {
      recBadge = document.createElement('span');
      recBadge.id = 'recBadge';
      recBadge.style.marginLeft = '8px';
      recBadge.style.padding = '2px 8px';
      recBadge.style.borderRadius = '999px';
      recBadge.style.background = '#ef4444';
      recBadge.style.color = '#fff';
      recBadge.style.fontSize = '0.85rem';
      recBadge.style.fontWeight = '600';
      recBadge.style.display = 'none';
    }
    if (!recBadge.parentElement) target.appendChild(recBadge);
    return recBadge;
  }

  function showRecBadge(maxSec = 60) {
    const badge = ensureRecBadge();
    if (!badge) return;
    clearInterval(countdownInterval);
    remainingSec = maxSec;
    badge.textContent = `🎙️ max rec ${maxSec} sec · ${remainingSec}`;
    badge.style.display = 'inline-block';
    countdownInterval = setInterval(() => {
      remainingSec -= 1;
      if (remainingSec <= 0) {
        badge.textContent = `🎙️ max rec ${maxSec} sec · 0`;
        clearInterval(countdownInterval);
        countdownInterval = null;
      } else {
        badge.textContent = `🎙️ max rec ${maxSec} sec · ${remainingSec}`;
      }
    }, 1000);
  }

  function hideRecBadge() {
    clearInterval(countdownInterval);
    countdownInterval = null;
    if (recBadge) recBadge.style.display = 'none';
  }

  function pickBestAudioMime(){
    const c=['audio/webm;codecs=opus','audio/webm','audio/mp4'];
    for (const m of c){ try{ if(MediaRecorder.isTypeSupported(m)) return m;}catch{} }
    return 'audio/webm;codecs=opus';
  }

  async function ensureAudioControls(){
    if (!els.composer||document.getElementById('recBtn')) return;

    const recBtn=document.createElement('button');
    recBtn.id='recBtn'; recBtn.textContent='Rec'; recBtn.style.marginLeft='6px';

    const stopBtn=document.createElement('button');
    stopBtn.id='stopBtn'; stopBtn.textContent='Stop'; stopBtn.style.marginLeft='6px'; stopBtn.disabled=true;

    els.composer.appendChild(recBtn);
    els.composer.appendChild(stopBtn);

      recBtn.addEventListener('click',async ()=>{
      if (!isFeatureAllowed('audio')) {

    // popup con bottone
    const want = confirm(
      "In modalità DEMO puoi inviare solo messaggi di testo.\n\n" +
      "Vuoi acquistare la versione PRO?"
    );

    // se l’utente clicca su OK → apri il QR
    if (want) {
      showBitcoinQrOnly();

    } else {
      // se clicca Annulla → chiudi solo il popup
      const overlay = document.getElementById('licenseOverlay');
      if (overlay && licenseStatus === 'demo') overlay.style.display = 'flex';
    }

    return;
}

      if (!isConnected||!e2e.ready) return alert('Non connesso al server o E2E non pronto');

      try{
        mediaStream?.getTracks().forEach(t=>t.stop());
        mediaStream=await navigator.mediaDevices.getUserMedia({audio:true});
        audioChunks=[]; audioMime=pickBestAudioMime();

        try{
          mediaRecorder=new MediaRecorder(mediaStream,{mimeType:audioMime,audioBitsPerSecond:24000});
        }catch{
          mediaRecorder=new MediaRecorder(mediaStream);
        }

        mediaRecorder.ondataavailable=(ev)=>{ if(ev.data?.size) audioChunks.push(ev.data); };

        mediaRecorder.onstop=async ()=>{
          clearTimeout(audioTimer);
          hideRecBadge();
          try{
            const blob=new Blob(audioChunks,{type:audioMime.split(';')[0]});
            addAudio(URL.createObjectURL(blob),'me',audioMime);

            const b64=await blobToBase64(blob);
            if (b64.length>MAX_B64_SAFE){ addMsg('⚠️ Audio troppo lungo per invio sicuro.','me'); return; }

            if (!ensureVerifiedOrConfirm()) return;
            const {iv,ct}=await e2e.encrypt(b64);
            if (ws&&ws.readyState===1) ws.send(JSON.stringify({type:'audio',iv,ct,mime:audioMime}));
          } catch (err) {
            alert('Errore invio audio: '+(err?.message||err));
          } finally {
            mediaStream?.getTracks().forEach(t=>t.stop());
            mediaStream=null; mediaRecorder=null; audioChunks=[];
            recBtn.disabled=false; stopBtn.disabled=true;
            recBtn.style.backgroundColor = '';
            recBtn.style.color = '';
          }
        };

        try{ mediaRecorder.start(1000);}catch{ mediaRecorder.start(); }

        recBtn.style.backgroundColor = 'red';
        recBtn.style.color = 'white';
        showRecBadge(60);

        audioTimer=setTimeout(()=>{
          if(mediaRecorder&&mediaRecorder.state!=='inactive'){
            mediaRecorder.stop();
            addMsg('⏱️ Registrazione interrotta: 60s.','me');
          }
        },60*1000);

        recBtn.disabled=true; stopBtn.disabled=false;

      }catch(e){
        alert('Errore microfono: '+e.message);
      }
    });

    stopBtn.addEventListener('click',()=>{
      if(mediaRecorder&&mediaRecorder.state!=='inactive'){
        mediaRecorder.stop();
      }
    });
  }

  // ===== AutoStart =====
  (async function autoStart(){ await ensureKeys(); connect(); ensurePhotoControls(); ensureAudioControls(); })();
});


// === Settings Gear (minimal, no HTML changes) ===
(function setupSettingsMenuMinimal(){
  try {
    const actions = document.querySelector('.actions') || document.querySelector('header .actions');
    if (!actions) return;

    if (getComputedStyle(actions).position === 'static') {
      actions.style.position = 'relative';
    }

    let gearBtn = document.getElementById('settingsBtn');
    if (!gearBtn) {
      gearBtn = document.createElement('button');
      gearBtn.id = 'settingsBtn';
      gearBtn.className = 'ghost';
      gearBtn.type = 'button';
      gearBtn.title = 'Impostazioni';
      gearBtn.setAttribute('aria-expanded', 'false');
      gearBtn.textContent = '⚙️';
      gearBtn.style.fontSize = '24px';
      gearBtn.style.lineHeight = '1';
      gearBtn.style.padding = '6px 10px';
    }

    const clearBtn = document.getElementById('clearBtn');

    if (clearBtn) actions.insertBefore(gearBtn, clearBtn);
    else actions.appendChild(gearBtn);

    let menu = document.getElementById('settingsMenu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'settingsMenu';
      menu.setAttribute('role', 'menu');
      menu.style.display = 'none';
      menu.style.position = 'absolute';
      menu.style.top = '100%';
      menu.style.right = '0';
      menu.style.background = 'rgba(200,200,200,0.95)';
      menu.style.color = '#000';
      menu.style.padding = '10px';
      menu.style.borderRadius = '12px';
      menu.style.boxShadow = '0 10px 30px rgba(0,0,0,0.15)';
      menu.style.minWidth = '240px';
      menu.style.backdropFilter = 'blur(6px)';
      actions.appendChild(menu);

      const styleButtons = () => {
        menu.querySelectorAll('button').forEach(btn => {
          if (btn.id === 'settingsBtn') return;
          btn.style.background = '#e6e6e6';
          btn.style.color = '#000';
          btn.style.border = '1px solid #c7c7c7';
          btn.style.borderRadius = '10px';
          btn.style.padding = '6px 10px';
        });

        menu.querySelectorAll('select').forEach(sel => {
          sel.style.background = '#f2f2f2';
          sel.style.color = '#000';
          sel.style.border = '1px solid #c7c7c7';
          sel.style.borderRadius = '8px';
          sel.style.padding = '4px 6px';
        });
      };

      styleButtons();
      new MutationObserver(styleButtons).observe(menu, { childList: true, subtree: true });
    }

    const makeRow = (labelText, node) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.justifyContent = 'space-between';
      row.style.gap = '8px';
      row.style.margin = '6px 0';
      if (labelText) {
        const lab = document.createElement('label');
        lab.textContent = labelText;
        lab.style.fontSize = '0.9rem';
        lab.style.opacity = '0.9';
        row.appendChild(lab);
      }
      row.appendChild(node);
      return row;
    };

    const langSel = document.getElementById('langSelect');
    let bipBtn = document.getElementById('toggleBeepBtn');
    const installBtn = document.getElementById('installBtn');

    if (!bipBtn) {
      bipBtn = document.createElement('button');
      bipBtn.id = 'toggleBeepBtn';
      bipBtn.className = 'ghost';
      try {
        const be = (localStorage.getItem('beepEnabled') === '1');
        bipBtn.textContent = be ? ': ON' : ': OFF';
        bipBtn.setAttribute('aria-pressed', be ? 'true' : 'false');
      } catch(_) {
        bipBtn.textContent = ': OFF';
        bipBtn.setAttribute('aria-pressed', 'false');
      }
    }

    menu.innerHTML = '';

    if (langSel) {
      langSel.style.maxWidth = '120px';
      menu.appendChild(makeRow('Lingua', langSel));
    }

    menu.appendChild((()=>{
      const hr = document.createElement('div');
      hr.style.height = '1px'; hr.style.background = 'rgba(255,255,255,.15)'; hr.style.margin = '6px 0';
      return hr;
    })());

    if (bipBtn) {
      menu.appendChild(makeRow('Notifiche', bipBtn));
    }

    if (installBtn) {
      menu.appendChild((()=>{
        const hr = document.createElement('div');
        hr.style.height = '1px'; hr.style.background = 'rgba(255,255,255,.15)'; hr.style.margin = '6px 0';
        return hr;
      })());
      menu.appendChild(makeRow('App', installBtn));
    }

    (function(){
      const clearInside = document.getElementById('clearBtn');
      if (clearInside) {
        try { clearInside.textContent = 'Svuota chat'; } catch(_) {}
        menu.appendChild((()=>{ const hr = document.createElement('div'); hr.style.height='1px'; hr.style.background='rgba(0,0,0,.15)'; hr.style.margin='6px 0'; return hr; })());
        menu.appendChild(makeRow('', clearInside));
      }
    })();

    function closeMenu(){ menu.style.display='none'; gearBtn.setAttribute('aria-expanded','false'); }
    function openMenu(){ menu.style.display='block'; gearBtn.setAttribute('aria-expanded','true'); }

    gearBtn.addEventListener('click', (e)=>{
      e.preventDefault(); e.stopPropagation();
      const open = menu.style.display !== 'none';
      if (open) closeMenu(); else openMenu();
    });

    document.addEventListener('click', (e)=>{
      if (!menu.contains(e.target) && e.target !== gearBtn) closeMenu();
    });
    document.addEventListener('keydown', (e)=>{
      if (e.key === 'Escape') closeMenu();
    });
  } catch (e) {
    console.warn('Settings menu error:', e);
  }
})(); // end settings gear

// ====== Licensing API helpers (global) ======
async function api(path, opts) {
  const res = await fetch(SERVER_BASE + path, { headers: {'Content-Type':'application/json'}, ...opts });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function ensureInstallId(){
  let id = localStorage.getItem('install_id');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || (Date.now().toString(36)+Math.random().toString(36).slice(2));
    localStorage.setItem('install_id', id);
  }
  return id;
}

async function bootstrapLicense(){
  const install_id = await ensureInstallId();
  try {
    await api('/license/register', { method:'POST', body: JSON.stringify({ install_id }) });
  } catch(e) { console.error('register failed', e); }
  return await api('/license/status?install_id='+install_id);
}

function updateLicenseUI(lic){
  const overlay = document.getElementById('license-overlay');
  const demoBadge = document.getElementById('demo-badge');
  const now = new Date(lic.now);
  const expired = (lic.status==='trial' && lic.trial_expires_at && new Date(lic.trial_expires_at) <= now);
  const notPro = (lic.status!=='pro');
  if (overlay) {
    if (expired && notPro) overlay.removeAttribute('hidden'); else overlay.setAttribute('hidden','');
  }
  if (demoBadge) {
    if (notPro) demoBadge.removeAttribute('hidden'); else demoBadge.setAttribute('hidden','');
  }
  window.__LICENSE_LIMITS__ = lic.limits || {};
  window.__LICENSE_STATUS__ = lic.status;
}

async function initLicense() {
  const lic = await bootstrapLicense();
  updateLicenseUI(lic);

  // Poll licenza ogni 30s
  setInterval(async () => {
    try {
      const x = await api('/license/status?install_id=' + localStorage.getItem('install_id'));
      updateLicenseUI(x);
    } catch (e) {
      console.warn('poll licenza fallito', e);
    }
  }, 30000);

  // === BOTTONI OVERLAY NUOVO ===
const buyBtn = document.getElementById("licenseBuyBtn");
if (buyBtn) buyBtn.onclick = showBitcoinQrOnly;


  if (demoBtn) {
    demoBtn.onclick = () => {
      document.getElementById("licenseOverlay").style.display = "none";
    };
  }

  // === FIX OVERLAY VECCHIO ===
  const oldBuy = document.getElementById("buy");
  if (oldBuy) oldBuy.onclick = (ev) => {
    ev.preventDefault();
    showBitcoinQrOnly();

  };

  const oldDemo = document.getElementById("demo");
  if (oldDemo) oldDemo.onclick = () => {
    const ov = document.getElementById("license-overlay");
    if (ov) ov.setAttribute("hidden", "");
  };
}


// ==============================
//      FUNZIONE CORRETTA
// ==============================
async function showBitcoinQrOnly() {
  try {
    const install_id = localStorage.getItem("install_id");

    const res = await fetch(
      `https://api.silentpwa.com/payment/start?install_id=${install_id}`,
      { method: "POST" }
    );

    const data = await res.json();
    const btcAddr = data.btc_address;
    const amount = data.amount_btc;

    // Mostra overlay pagamento
    const ov = document.getElementById("licenseOverlay");
    ov.style.display = "flex";

    // QR dinamico
    document.getElementById("licenseQr").src =
      `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=bitcoin:${btcAddr}?amount=${amount}`;

    // Mostra indirizzo e importo
    document.getElementById("licenseAddr").textContent = btcAddr;
    document.getElementById("licenseAmount").textContent = amount + " BTC";

    pollPaymentStatus();

  } catch (err) {
    console.error("Errore pagamento BTC", err);
    alert("Errore rete durante pagamento Bitcoin.");
  }
}


document.addEventListener('DOMContentLoaded', initLicense);



function pollPaymentStatus() {
  const install_id = localStorage.getItem("install_id");
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`https://api.silentpwa.com/payment/status?install_id=${install_id}`);
      const data = await res.json();

      if (data.status === "pro") {
        clearInterval(timer);
        alert("Pagamento ricevuto! Licenza PRO attivata.");
        const ov = document.getElementById('licenseOverlay');
        ov.style.display = "none";
        location.reload();
      }

    } catch (e) {}
  }, 5000);
}
