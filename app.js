// app.js — Silent PWA (testo, foto, audio E2E)

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

  // ===== Presenza peer =====
  let myId = null;
  let peerOnline = false;
  let lastPeerSeenAt = 0;
  let members = new Map(); // id -> { joinedAt }

  function humanAgo(ms){
    const s = Math.floor(ms/1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s/60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m/60);
    return `${h}h`;
  }
  function setPeerPresence(online){
    peerOnline = !!online;
    if (els.connStatus) {
      const base = isConnected ? 'WS: connesso' : 'WS: disconnesso';
      const peer = peerOnline ? ` | Peer: online (ultimo visto ${humanAgo(Date.now()-lastPeerSeenAt)})`
                              : ` | Peer: offline`;
      els.connStatus.textContent = base + peer;
    }
  }
  function touchPeerSeen(){
    lastPeerSeenAt = Date.now();
    if (!peerOnline) setPeerPresence(true);
  }
  function updatePeerFromMembers(){
    const others = Array.from(members.keys()).filter(id => id !== myId);
    const online = others.length > 0;
    setPeerPresence(online);
    if (online) touchPeerSeen();
  }

  // ===== DOM =====
  const $ = (s) => document.querySelector(s);
  const els = {
    langSel:     $('#langSelect'),
    installBtn:  $('#installBtn'),
    clearBtn:    $('#clearBtn'),
    connTitle:   document.querySelector('[data-i18n="connection"]'),
    connStatus:  $('#connStatus'),
    myPub:       $('#myPub'),
    peerPub:     $('#peerPub'),
    startBtn:    $('#startSession'),
    log:         $('#log'),
    input:       $('#msgInput'),
    sendBtn:     $('#sendBtn'),
    photoBtn:    $('#photoBtn'),
    audioBtns:   $('#audioControls'),
    recBtn:      $('#recBtn'),
    stopBtn:     $('#stopBtn'),
    timerBadge:  $('#timerBadge'),
    video:       $('#video'),
    canvas:      $('#canvas'),
    snapBtn:     $('#snapBtn'),
    clearPhoto:  $('#clearPhoto')
  };

  applyLang(els.langSel);

  // ===== Install PWA =====
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (els.installBtn) els.installBtn.style.display = 'inline-flex';
  });
  els.installBtn?.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') els.installBtn.style.display = 'none';
    deferredPrompt = null;
  });

  // ===== Utility UI =====
  function setConnState(ok){
    isConnected = !!ok;
    if (els.connTitle) {
      els.connTitle.textContent = ok ? ': connesso' : ': disconnesso';
      els.connTitle.style.color = ok ? '#16a34a' : '#ef4444';
      setTimeout(() => {
        els.connTitle.style.color = '#16a34a';
        setTimeout(() => setConnState(isConnected), 1200);
      }, 120);
    }
    // aggiorna anche presenza
    setPeerPresence(peerOnline && ok);
  }

  function addMsg(text, who='me'){
    if (!els.log) return;
    const li = document.createElement('li');
    li.className = who;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    li.appendChild(bubble);
    els.log.appendChild(li);
    els.log.scrollTop = els.log.scrollHeight;
  }

  function addImage(url, who='me'){
    if (!els.log) return;
    const li = document.createElement('li');
    li.className = who;
    const img = document.createElement('img');
    img.src = url;
    img.style.maxWidth = '70%';
    img.style.borderRadius = '12px';
    img.onload = () => URL.revokeObjectURL(url);
    li.appendChild(img);
    els.log.appendChild(li);
    els.log.scrollTop = els.log.scrollHeight;
  }

  function addAudio(url, who='me', mime='audio/webm'){
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
    return new Promise((res, rej)=>{
      const img = new Image();
      img.onload = ()=> res(img);
      img.onerror = rej;
      img.src = URL.createObjectURL(blob);
    });
  }

  // ===== Crypto / E2E =====
  async function ensureKeys(){
    if (keysGenerated) return;
    await e2e.init();
    const { pubRawB64 } = await e2e.generateKeyPair();
    keysGenerated = true;
    if (els.myPub) els.myPub.value = pubRawB64;
  }

  // Scambio chiavi (manuale + aggancio automatico quando riceviamo "key")
  els.startBtn?.addEventListener('click', async () => {
    try {
      await ensureKeys();
      const peerRaw = (els.peerPub?.value || '').trim();
      if (!peerRaw) return alert('Inserisci la chiave pubblica del peer');
      if (!sessionStarted){
        pendingPeerKey = peerRaw;
        // avvia sessione
        await startSessionIfReady();
      } else {
        await e2e.setPeerPublicKey(peerRaw); // aggiorna peer
        e2e.peerPubRawB64 = peerRaw;
      }
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type:'key', raw: myPubExpected || (els.myPub?.value || '') }));
      }
      addMsg('🔐 Chiave inviata. In attesa del peer…', 'me');
    } catch (err) {
      console.error('Errore start session:', err);
      alert('Errore nell’avvio della sessione');
    }
  });

  async function startSessionIfReady(){
    if (sessionStarted) return;
    await ensureKeys();
    const myRaw = (els.myPub?.value || '').trim();
    const peerRaw = (pendingPeerKey || els.peerPub?.value || '').trim();
    if (!myRaw || !peerRaw) return;

    await e2e.setPeerPublicKey(peerRaw);         // E2E pronto
    e2e.peerPubRawB64=peerRaw;

    if (ws&&ws.readyState===1){
      ws.send(JSON.stringify({type:'key',raw:myPubExpected||(els.myPub?.value||'')}));
    }

    if (els.connTitle) els.connTitle.textContent=': connesso (E2E attiva)';

    // chiudi la tendina "Scambio di chiavi"
    const details = document.querySelector('details');
    if (details) details.open = false;
    sessionStarted = true;
  }

  // ===== Invio messaggi =====
  els.sendBtn?.addEventListener('click', async ()=>{
    try{
      const text = els.input?.value || '';
      if (!text.trim()) return;
      if (!e2e.ready) return alert('Sessione E2E non attiva');

      const { iv, ct } = await e2e.encrypt(text);
      ws?.readyState===1 && ws.send(JSON.stringify({ type:'msg', iv, ct }));
      addMsg(text, 'me');
      els.input.value = '';
    }catch(e){ console.error(e); }
  });

  els.clearBtn?.addEventListener('click', ()=>{
    els.log.innerHTML = '';
  });

  // ===== Foto =====
  function ensurePhotoControls(){
    if (!els.video || !els.canvas || !els.snapBtn || !els.clearPhoto || !els.photoBtn) return;

    els.photoBtn.addEventListener('click', async ()=>{
      try{
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        els.video.srcObject = stream;
        els.video.play();
      }catch(e){ alert('Errore video: '+e.message); }
    });

    els.snapBtn.addEventListener('click', async ()=>{
      try{
        const ctx = els.canvas.getContext('2d');
        els.canvas.width = els.video.videoWidth;
        els.canvas.height = els.video.videoHeight;
        ctx.drawImage(els.video, 0, 0);
        els.video.srcObject && els.video.srcObject.getTracks().forEach(t=>t.stop());

        const blob = await new Promise(res => els.canvas.toBlob(res, 'image/jpeg', 0.85));
        const { iv, ct } = await e2e.encryptBytes(await blob.arrayBuffer());
        ws?.readyState===1 && ws.send(JSON.stringify({ type:'image', iv, ct, mime:'image/jpeg' }));
        addImage(URL.createObjectURL(blob), 'me');
      }catch(e){ console.error(e); }
    });

    els.clearPhoto.addEventListener('click', ()=>{
      els.canvas.width = 0;
      els.canvas.height = 0;
      if (els.video.srcObject) {
        els.video.srcObject.getTracks().forEach(t=>t.stop());
        els.video.srcObject = null;
      }
    });
  }

  // ===== Audio =====
  let mediaRecorder = null;
  let audioTimer = null;

  function showRecBadge(sec){
    if (!els.timerBadge) return;
    els.timerBadge.textContent = `${sec}s`;
    els.timerBadge.style.display = sec > 0 ? 'inline-flex' : 'none';
  }

  function ensureAudioControls(){
    if (!els.recBtn || !els.stopBtn) return;
    const recBtn = els.recBtn;
    const stopBtn = els.stopBtn;

    recBtn.addEventListener('click', async ()=>{
      try{
        const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

        const chunks = [];
        mediaRecorder.ondataavailable = e => { if (e.data && e.data.size>0) chunks.push(e.data); };

        mediaRecorder.onstop = async () => {
          try{
            const blob = new Blob(chunks, { type:'audio/webm' });
            const ab = await blob.arrayBuffer();
            const { iv, ct } = await e2e.encryptBytes(ab);
            ws?.readyState===1 && ws.send(JSON.stringify({ type:'audio', iv, ct, mime:'audio/webm' }));
            addAudio(URL.createObjectURL(blob), 'me', 'audio/webm');
          }catch(err){ console.error(err); }
          finally{
            stream.getTracks().forEach(t=>t.stop());
            mediaRecorder = null;
            clearInterval(audioTimer);
            showRecBadge(0);
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
          }
        }, 60_000);

      }catch(e){
        console.error(e);
        alert('Errore microfono: '+e.message);
      }
    });

    stopBtn.addEventListener('click',()=>{
      if(mediaRecorder&&mediaRecorder.state!=='inactive'){
        mediaRecorder.stop();
      }
    });
  }

  // ===== WebSocket + Presenza =====
  function connect(){
    if (isConnecting||isConnected) return;
    isConnecting=true; setConnState(false);
    try{ ws=new WebSocket(FORCED_WS);}catch(e){ isConnecting=false; return;}
    ws.addEventListener('error', ()=> { setConnState(false); setPeerPresence(false); });
    ws.addEventListener('open',async ()=>{
      isConnecting=false;
      setConnState(true);
      setPeerPresence(false);
      backoffMs=2000;
      await ensureKeys();
    });
    ws.addEventListener('close',()=>{
      isConnecting=false;
      setConnState(false);
      setPeerPresence(false);
      const jitter = Math.floor(Math.random()*500);
      backoffMs=Math.min(backoffMs*2,15000);
      setTimeout(connect, backoffMs + jitter);
    });
    ws.addEventListener('message',async ev=>{
      try{
        const msg=JSON.parse(ev.data);

        // --- PRESENCE / HEARTBEAT dal backend ---
        if (msg.type === 'joined') { myId = msg.id; return; }
        if (msg.type === 'presence' && Array.isArray(msg.members)) {
          members = new Map(msg.members.map(m => [m.id, m]));
          updatePeerFromMembers();
          return;
        }
        if (msg.type === 'join' && msg.id) {
          members.set(msg.id, { joinedAt: Date.now() });
          updatePeerFromMembers();
          return;
        }
        if (msg.type === 'leave' && msg.id) {
          members.delete(msg.id);
          updatePeerFromMembers();
          return;
        }
        if (msg.type === 'ping') {
          ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          return;
        }
        if (msg.type === 'pong') { touchPeerSeen(); return; }

        if (msg.type==='key'){
          await ensureKeys();
          const peerRaw=(msg.raw||'').trim();
          if (!peerRaw||peerRaw===(myPubExpected||els.myPub?.value||'').trim()) return;
          if (!sessionStarted){ pendingPeerKey=peerRaw; await startSessionIfReady(); return; }
          await e2e.setPeerPublicKey(peerRaw); e2e.peerPubRawB64=peerRaw;
          if (els.connTitle) els.connTitle.textContent=': connesso (E2E attiva)';
          return;
        }
        if (!e2e.ready) return;
        if (msg.type==='msg'){ touchPeerSeen(); addMsg(await e2e.decrypt(msg.iv,msg.ct),'peer'); return;}
        if (msg.type==='image'){
          touchPeerSeen();
          const ab=await e2e.decryptToArrayBuffer(msg.iv,msg.ct);
          addImage(URL.createObjectURL(new Blob([ab],{type:(msg.mime||'image/jpeg')})),'peer');
          return;
        }
        if (msg.type==='audio'){
          touchPeerSeen();
          const ab=await e2e.decryptToArrayBuffer(msg.iv,msg.ct);
          addAudio(URL.createObjectURL(new Blob([ab],{type:(msg.mime||'audio/webm')})),'peer',msg.mime||'audio/webm');
          return;
        }
      }catch(e){ console.error(e); }
    });
  }

  // ===== Clipboard helpers =====
  els.myPub?.addEventListener('focus', (e)=> e.target.select());
  els.myPub?.addEventListener('click', (e)=> e.target.select());
  els.peerPub?.addEventListener('focus', (e)=> e.target.select());

  // Copia chiave nei campi
  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-copy]');
    if (!btn) return;
    const srcSel = btn.getAttribute('data-copy');
    const src = document.querySelector(srcSel);
    if (!src) return;

    try {
      await navigator.clipboard.writeText(src.value || src.textContent || '');
      if (els.connTitle) {
        els.connTitle.style.color = '#16a34a';
        setTimeout(() => setConnState(isConnected), 1200);
      }
    } catch (e) {
      alert('Impossibile copiare: ' + e.message);
    }
  });

  // ===== AutoStart =====
  (async function autoStart(){
    await ensureKeys();
    connect();
    ensurePhotoControls();
    ensureAudioControls();
  })();
});
