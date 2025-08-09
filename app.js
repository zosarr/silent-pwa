import {E2E} from './crypto.js';
import {STRINGS, applyLang} from './i18n.js';

let ws=null; let e2e=new E2E();
const els={wsUrl:document.getElementById('wsUrl'),connectBtn:document.getElementById('connectBtn'),
disconnectBtn:document.getElementById('disconnectBtn'),log:document.getElementById('log'),
input:document.getElementById('msgInput'),sendBtn:document.getElementById('sendBtn'),
myPub:document.getElementById('myPub'),peerPub:document.getElementById('peerPub'),
startSessionBtn:document.getElementById('startSessionBtn'),clearBtn:document.getElementById('clearBtn'),
installBtn:document.getElementById('installBtn'),langSelect:document.getElementById('langSelect'),
aboutLink:document.getElementById('aboutLink'),aboutDialog:document.getElementById('aboutDialog'),
closeAbout:document.getElementById('closeAbout')};

const preferred=(navigator.language||'it').startsWith('it')?'it':'en'; els.langSelect.value=preferred; applyLang(preferred);
els.langSelect.addEventListener('change',e=>applyLang(e.target.value));

let deferredPrompt=null; window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;els.installBtn.style.display='inline-block';});
els.installBtn.addEventListener('click',async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice;els.installBtn.style.display='none';});
if('serviceWorker' in navigator){navigator.serviceWorker.register('./sw.js');}

els.aboutLink.addEventListener('click',e=>{e.preventDefault();els.aboutDialog.showModal();});
els.closeAbout.addEventListener('click',()=>els.aboutDialog.close());

function addMsg(text,kind='server'){
  const li=document.createElement('li'); li.className='msg '+(kind==='me'?'me':'other');
  li.innerHTML=`<div>${escapeHtml(text)}</div><div class="meta">${new Date().toLocaleTimeString()}</div>`;
  els.log.appendChild(li); els.log.scrollTop=els.log.scrollHeight;
  setTimeout(()=>li.remove(), 5*60*1000); // autodistruzione 5 min
}
function escapeHtml(s){return s.replace(/[&<>\"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]));}
function setStatus(s){const map=STRINGS[els.langSelect.value]; addMsg(map[`status_${s}`]||s,'server');}

(async()=>{ const myPubB64=await e2e.init(); els.myPub.value=myPubB64; })();
// === QR Code Generation ===
document.getElementById('showQrBtn').addEventListener('click', () => {
  const key = els.myPub.value.trim();
  if (!key) return alert("Chiave pubblica mancante");
  const qrDiv = document.getElementById('qrContainer');
  qrDiv.innerHTML = "";
  new QRCode(qrDiv, { text: key, width: 200, height: 200 });
  qrDiv.style.display = "block";
});

// === QR Code Scanning ===
document.getElementById('scanQrBtn').addEventListener('click', async () => {
  const video = document.getElementById('qrVideo');
  video.style.display = "block";
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  video.srcObject = stream;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  function scanFrame() {
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imgData.data, imgData.width, imgData.height);
      if (code) {
        els.peerPub.value = code.data;
        stream.getTracks().forEach(track => track.stop());
        video.style.display = "none";
        alert("Chiave pubblica importata dal QR!");
        return;
      }
    }
    requestAnimationFrame(scanFrame);
  }
  requestAnimationFrame(scanFrame);
});


els.startSessionBtn.addEventListener('click',async()=>{
  const base64=els.peerPub.value.trim(); if(!base64) return alert('Incolla la chiave pubblica del peer');
  try{ await e2e.setPeerPublicKey(base64); setStatus('ready'); sendJson({type:'pubkey', pub: els.myPub.value}); }
  catch(err){ alert('Errore sessione: '+err.message); }
});

els.connectBtn.addEventListener('click',()=>{
  const url=els.wsUrl.value.trim(); if(!url) return;
  ws=new WebSocket(url);
  ws.onopen=()=>{ setStatus('connected'); sendJson({type:'pubkey', pub: els.myPub.value}); };
  ws.onmessage=async ev=>{
    try{
      const data=JSON.parse(ev.data);
      if(data.type==='pubkey' && data.pub){
        if(!e2e.ready){ try{ await e2e.setPeerPublicKey(data.pub); setStatus('ready'); }catch(ex){ console.warn('Peer pubkey error',ex);} }
      } else if(data.type==='msg' && data.iv && data.ct){
        if(!e2e.ready){ addMsg('[Encrypted] '+(els.langSelect.value==='it'?'In attesa chiave…':'Waiting for key…')); return; }
        const plain=await e2e.decrypt(data.iv,data.ct); addMsg(plain,'other');
      } else if(typeof data==='string'){ addMsg(data,'other'); }
    } catch { addMsg(ev.data,'other'); }
  };
  ws.onclose=()=>setStatus('disconnected');
  ws.onerror=()=>setStatus('disconnected');
});

els.disconnectBtn.addEventListener('click',()=>{ if(ws){ ws.close(); ws=null; setStatus('disconnected'); }});

els.sendBtn.addEventListener('click',async()=>{
  const text=els.input.value.trim(); if(!text) return;
  if(!ws || ws.readyState!==1) return alert('Non connesso');
  if(!e2e.ready) return alert('Sessione non pronta: scambia le chiavi pubbliche');
  try{ const {iv,ct}=await e2e.encrypt(text); sendJson({type:'msg',iv,ct}); addMsg(text,'me'); els.input.value=''; }
  catch(err){ alert('Errore invio: '+err.message); }
});

function sendJson(obj){ if(ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }
els.clearBtn.addEventListener('click',()=>{ els.log.innerHTML=''; });
