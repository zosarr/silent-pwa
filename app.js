// app.js — Silent PWA (testo, foto, audio, presenza peer E2E)

import { E2E } from './crypto.js';
import { applyLang } from './i18n.js';

window.addEventListener('DOMContentLoaded', () => {
  // ===== Config =====
  const AUTO_WS_URL = 'wss://silent-backend.onrender.com/ws?room=test';
  const qs = new URLSearchParams(location.search);
  const FORCED_WS = qs.get('ws') || AUTO_WS_URL;

  // ===== Stato =====
  let ws = null;
  let e2e = new E2E();
  let isConnecting = false;
  let isConnected = false;
  let backoffMs = 2000;

  let deferredPrompt = null;

  let keysGenerated = false;
  let myPubExpected = null;

  let sessionStarted = false;
  let pendingPeerKey = null;

  // ===== Presenza (peer) =====
  let peerLastSeen = 0;           // ms epoch dell’ultimo segno di vita dal peer
  let peerOnline = false;
  let presenceSendInterval = null; // timer che invia presence
  let peerCheckInterval = null;    // timer che valuta online/offline

  // ===== DOM =====
  const $ = (s) => document.querySelector(s);
  const els = {
    langSel:     $('#langSelect'),
    installBtn:  $('#installBtn'),
    clearBtn:    $('#clearBtn'),
    connTitle:   document.querySelector('[data-i18n="connection"]'),
    connStatus:  $('#connStatus'),
    myPub:       $('#myPub'),
    copyMyBtn:   $('#copyMyPubBtn'),
    peerPub:     $('#peerPub'),
    startBtn:    $('#startSessionBtn'),
    log:         $('#log'),
    input:       $('#msgInput'),
    sendBtn:     $('#sendBtn'),
    composer:    document.querySelector('.composer'),
  };

  // ===== Utils =====
  const escapeHtml = (s) => (s ? s.replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m])) : '');

  function addMsg(text, who = 'peer') {
    if (!els.log) return;
    const li = document.createElement('li');
    li.className = who;
    li.innerHTML = escapeHtml(text);
    els.log.appendChild(li);
    els.log.scrollTop = els.log.scrollHeight;
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
    const SAFE_B64_LEN = 300_000;
    let lastBlob=null,lastW=null,lastH=null,lastB64=null;
    for (const t of targets){
      const {blob,width,height} = await imageToJpegBlob(originalImg,{maxW:t.max,maxH:t.max,quality:t.q});
      const b64 = await blobToBase64(blob);
      lastBlob=blob;lastW=width;lastH=height;lastB64=b64;
      if (b64.length <= SAFE_B64_LEN) return {b64,width,height,blob};
    }
    return { b64:lastB64, width:lastW, height:lastH, blob:lastBlob };
  }

  // ===== I18N & SW =====
  els.langSel && els.langSel.addEventListener('change', ()=>applyLang(els.langSel.value));
  applyLang('it');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');

  // ===== Stato Connessione (server) =====
  function setConnState(connected){
    isConnected = !!connected;
    const txt = connected ? 'connesso' : 'non connesso';
    const color = connected ? '#16a34a' : '#dc2626';
    if (els.connTitle){
      els.connTitle.textContent = `: ${txt}`;
      els.connTitle.style.color=color; els.connTitle.style.fontWeight='700';
    }
    if (els.connStatus){
      els.connStatus.textContent = connected?'Connesso':'Non connesso';
      els.connStatus.classList.toggle('connected',connected);
      els.connStatus.classList.toggle('disconnected',!connected);
    }
    // se perdiamo il server, il peer è certamente "offline" per noi
    if (!connected) setPeerState(false);
  }
  setConnState(false);

  // ===== Badge stato peer =====
  let peerBadge = null;
  function ensurePeerBadge(){
    if (peerBadge && peerBadge.parentElement) return peerBadge;
    const container = els.connStatus || document.querySelector('[data-i18n="connection"]') || document.body;
    peerBadge = document.createElement('span');
    peerBadge.id = 'peerStatus';
    peerBadge.style.marginLeft = '10px';
    peerBadge.style.padding = '2px 8px';
    peerBadge.style.borderRadius = '999px';
    peerBadge.style.fontSize = '0.85rem';
    peerBadge.style.fontWeight = '600';
    container.parentElement ? container.parentElement.appendChild(peerBadge) : container.appendChild(peerBadge);
    return peerBadge;
  }
  function setPeerState(online){
    peerOnline = !!online;
    const el = ensurePeerBadge();
    if (!el) return;
    el.textContent = `Peer: ${peerOnline ? 'Online' : 'Offline'}`;
    el.style.background = peerOnline ? '#16a34a' : '#dc2626';
    el.style.color = '#fff';
  }
  setPeerState(false);

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

  // Copia chiave – mostra ✔ e poi ripristina stato
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

  // ===== PRESENCE: invio/monitor =====
  async function sendPresence(){
    if (!ws || ws.readyState !== 1) return;
    try{
      // messaggio leggerissimo, cifrato se E2E pronta
      if (e2e.ready) {
        const { iv, ct } = await e2e.encrypt('alive');
        ws.send(JSON.stringify({ type:'presence', iv, ct }));
      } else {
        ws.send(JSON.stringify({ type:'presence' }));
      }
    }catch(e){ /* ignora */ }
  }
  function startPresenceLoops(){
    stopPresenceLoops(); // evita doppioni
    // invia presence ogni 10s
    presenceSendInterval = setInterval(sendPresence, 10_000);
    // controlla se il peer è “vivo” ogni 3s (timeout 15s)
    peerCheckInterval = setInterval(()=>{
      const alive = (Date.now() - peerLastSeen) < 15_000;
      setPeerState(alive);
    }, 3000);
    // invia subito un primo presence
    sendPresence();
  }
  function stopPresenceLoops(){
    try{ clearInterval(presenceSendInterval); }catch{}
    try{ clearInterval(peerCheckInterval); }catch{}
    presenceSendInterval = null;
    peerCheckInterval = null;
  }

  // ===== WebSocket =====
  function connect(){
    if (isConnecting||isConnected) return;
    isConnecting=true; setConnState(false);
    try{ ws=new WebSocket(FORCED_WS);}catch(e){ isConnecting=false; return;}
    ws.addEventListener('open',async ()=>{isConnecting=false; setConnState(true); backoffMs=2000; await ensureKeys();});
    ws.addEventListener('close',()=>{isConnecting=false; setConnState(false); sessionStarted=false; pendingPeerKey=null; stopPresenceLoops(); setPeerState(false); setTimeout(connect,backoffMs=Math.min(backoffMs*2,15000));});
    ws.addEventListener('message',async ev=>{
      try{
        const msg=JSON.parse(ev.data);
        if (msg.type==='key'){
          await ensureKeys();
          const peerRaw=(msg.raw||'').trim();
          if (!peerRaw||peerRaw===(myPubExpected||els.myPub?.value||'').trim()) return;
          if (!sessionStarted){ pendingPeerKey=peerRaw; return;}
          await e2e.setPeerPublicKey(peerRaw); e2e.peerPubRawB64=peerRaw;
          if (els.connTitle) els.connTitle.textContent=': connesso (E2E attiva)';
          return;
        }

        // Presenza (può essere cifrata o plain)
        if (msg.type==='presence'){
          // se cifrata e E2E pronta, decripta (contenuto non usato)
          try{ if (e2e.ready && msg.iv && msg.ct) await e2e.decrypt(msg.iv, msg.ct); }catch{}
          peerLastSeen = Date.now();
          setPeerState(true);
          return;
        }

        if (!e2e.ready) return;

        if (msg.type==='msg'){
          const plain = await e2e.decrypt(msg.iv,msg.ct);
          peerLastSeen = Date.now();
          setPeerState(true);
          addMsg(plain,'peer'); 
          return;
        }

        if (msg.type==='image'){
          const b64=await e2e.decrypt(msg.iv,msg.ct);
          const buf=b64ToAb(b64);
          const blob=new Blob([buf],{type:msg.mime||'image/jpeg'});
          peerLastSeen = Date.now();
          setPeerState(true);
          addImage(URL.createObjectURL(blob),'peer'); 
          return;
        }

        if (msg.type==='audio'){
          const b64=await e2e.decrypt(msg.iv,msg.ct);
          const buf=b64ToAb(b64);
          const blob=new Blob([buf],{type:msg.mime||'audio/webm'});
          peerLastSeen = Date.now();
          setPeerState(true);
          addAudio(URL.createObjectURL(blob),'peer',msg.mime); 
          return;
        }
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
      await e2e.setPeerPublicKey(peerRaw);         // E2E pronto
      e2e.peerPubRawB64=peerRaw;

      if (ws&&ws.readyState===1){
        ws.send(JSON.stringify({type:'key',raw:myPubExpected||(els.myPub?.value||'')}));
      }

      if (els.connTitle) els.connTitle.textContent=': connesso (E2E attiva)';

      // chiudi la tendina "Scambio di chiavi"
      const details = document.querySelector('details');
      if (details) details.open = false;

      // avvia heartbeat presenza
      startPresenceLoops();

    } catch (err) {
      console.error('Errore Avvia sessione:', err);
      alert('Errore avvio sessione: ' + (err?.message || err));
    }
  });

  // ===== Invia testo =====
  els.sendBtn && els.sendBtn.addEventListener('click',async ()=>{
    if (!isConnected||!e2e.ready) return alert('Non connesso o E2E non pronto');
    const text=(els.input?.value||'').trim(); if (!text) return;
    const {iv,ct}=await e2e.encrypt(text);
    if (ws&&ws.readyState===1) ws.send(JSON.stringify({type:'msg',iv,ct}));
    addMsg(text,'me'); 
  });
  els.input && els.input.addEventListener('keydown',(e)=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); els.sendBtn.click(); }});
  els.clearBtn && els.clearBtn.addEventListener('click',()=>{ if(els.log) els.log.innerHTML=''; });

  // ===== Foto: mini-menu Scatta / Galleria =====
  function ensurePhotoControls(){
    if (!els.composer || document.getElementById('photoBtn')) return;

    // Bottone "Foto"
    const photoBtn = document.createElement('button');
    photoBtn.id = 'photoBtn';
    photoBtn.textContent = 'Foto';
    photoBtn.title = 'Scatta o scegli dalla galleria';
    photoBtn.style.marginLeft = '6px';
    els.composer.appendChild(photoBtn);

    // Input nascosti: camera & galleria
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

    // Contenitore per posizionamento del menu
    if (getComputedStyle(els.composer).position === 'static') {
      els.composer.style.position = 'relative';
    }

    // Mini-menu sovrapposto
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

    // Apertura menu
    photoBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (menu.style.display === 'block') closeMenu();
      else openMenu();
    });

    // Scelte nel menu
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

    // Chiudi cliccando fuori
    document.addEventListener('click', (e) => {
      const clickedInside = menu.contains(e.target) || e.target === photoBtn;
      if (!clickedInside) closeMenu();
    });

    // Chiudi con ESC
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });

    // Selezione file → invio
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
    if (!file||!isConnected||!e2e.ready) return;
    try{
      const img=await blobToImage(file);
      let {b64,width,height,blob}=await adaptAndEncodeImage(img);
      if (b64.length > IMG_MAX_B64_SAFE) {
        const tiny = await imageToJpegBlob(img, { maxW: 320, maxH: 320, quality: 0.68 });
        const tinyB64 = await blobToBase64(tiny.blob);
        if (tinyB64.length > IMG_MAX_B64_SAFE) { addMsg('⚠️ Immagine troppo grande per invio sicuro.','me'); return; }
        b64=tinyB64; width=tiny.width; height=tiny.height; blob=tiny.blob;
      }
      const {iv,ct}=await e2e.encrypt(b64);
      if (ws&&ws.readyState===1) ws.send(JSON.stringify({type:'image',iv,ct,mime:'image/jpeg',w:width,h:height}));
      addImage(URL.createObjectURL(blob),'me');
    }catch(err){
      alert('Errore invio foto: '+(err?.message||err));
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
      if (!isConnected||!e2e.ready) return alert('Non connesso o E2E non pronto');
      try{
        // reset/stream
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

            const {iv,ct}=await e2e.encrypt(b64);
            if (ws&&ws.readyState===1) ws.send(JSON.stringify({type:'audio',iv,ct,mime:audioMime}));
          } catch (err) {
            alert('Errore invio audio: '+(err?.message||err));
          } finally {
            // ripristina UI e risorse
            mediaStream?.getTracks().forEach(t=>t.stop());
            mediaStream=null; mediaRecorder=null; audioChunks=[];
            recBtn.disabled=false; stopBtn.disabled=true;
            // reset stile Rec
            recBtn.style.backgroundColor = '';
            recBtn.style.color = '';
          }
        };

        // start + timeslice 1s
        try{ mediaRecorder.start(1000);}catch{ mediaRecorder.start(); }

        // Rec in rosso durante la registrazione + badge countdown
        recBtn.style.backgroundColor = 'red';
        recBtn.style.color = 'white';
        showRecBadge(60);

        // limite 60s
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
