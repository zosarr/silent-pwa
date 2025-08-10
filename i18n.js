export const STRINGS = {
  it: {connection:"Connessione",connect:"Connetti",disconnect:"Disconnetti",session:"Scambio chiavi",
       myPub:"La mia chiave",peerPub:"Chiave utente (incolla)",startSession:"Avvia sessione",
       sessionHint:"Premi il pulsante per scambiare la chiave e attivare la chat",
       chat:"Chat",send:"Invia",autodestruct:"I messaggi si autodistruggono 5 minuti dopo la lettura.",
       clear:"Pulisci",status_connected:"Connesso",status_disconnected:"Disconnesso",
       status_waiting_key:"Connesso: in attesa della chiave del peer",status_ready:"Sessione E2E attiva"},
  en: {connection:"Connection",connect:"Connect",disconnect:"Disconnect",session:"Key exchange",
       myPub:"My key",peerPub:"User key (paste)",startSession:"Start session",
       sessionHint:"Press the button to exchange the key and activate the chat",
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
