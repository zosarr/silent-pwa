export const STRINGS = {
  it: {connection:"Connessione",connect:"Connetti",disconnect:"Disconnetti",session:"Sessione crittografica",
       myPub:"Mia chiave pubblica (base64)",peerPub:"Chiave pubblica del peer (incolla)",startSession:"Avvia sessione",
       sessionHint:"Scambia la chiave pubblica con il tuo interlocutore. La chat si attiva quando entrambe le parti avviano la sessione.",
       chat:"Chat",send:"Invia",autodestruct:"I messaggi si autodistruggono 5 minuti dopo la lettura.",
       clear:"Pulisci",status_connected:"Connesso",status_disconnected:"Disconnesso",
       status_waiting_key:"Connesso: in attesa della chiave del peer",status_ready:"Sessione E2E attiva"},
  en: {connection:"Connection",connect:"Connect",disconnect:"Disconnect",session:"Crypto session",
       myPub:"My public key (base64)",peerPub:"Peer public key (paste)",startSession:"Start session",
       sessionHint:"Exchange the public key with your peer. Chat activates when both sides start the session.",
       chat:"Chat",send:"Send",autodestruct:"Messages self-destruct 5 minutes after being read.",
       clear:"Clear",status_connected:"Connected",status_disconnected:"Disconnected",
       status_waiting_key:"Connected: waiting for peer key",status_ready:"E2E session active"}
};
export function applyLang(lang){
  const dict = STRINGS[lang] || STRINGS.it;
  document.querySelectorAll("[data-i18n]").forEach(el=>{
    const key = el.getAttribute("data-i18n");
    if (dict[key]) el.textContent = dict[key];
  });
}
