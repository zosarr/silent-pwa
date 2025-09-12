// i18n.js
export const I18N = (() => {
  const dict = {
    it: {
      keyExchange: "Scambio chiavi",
      yourPublicKey: "La tua chiave pubblica",
      peerPublicKey: "Chiave pubblica peer",
      copy: "Copia",
      set: "Imposta",
      roomId: "ID stanza",
      join: "Entra",
      sessionState: "Stato sessione:",
      send: "Invia",
      cancel: "Annulla",
      connected: "Connesso",
      notConnected: "Non connesso",
      ready: "Sessione pronta",
    },
    en: {
      keyExchange: "Key exchange",
      yourPublicKey: "Your public key",
      peerPublicKey: "Peer public key",
      copy: "Copy",
      set: "Set",
      roomId: "Room ID",
      join: "Join",
      sessionState: "Session state:",
      send: "Send",
      cancel: "Cancel",
      connected: "Connected",
      notConnected: "Not connected",
      ready: "Session ready",
    }
  };
  function apply(lang){
    const t = dict[lang] || dict.it;
    document.querySelectorAll("[data-i18n]").forEach(el => {
      const key = el.getAttribute("data-i18n");
      if(t[key]) el.textContent = t[key];
    });
  }
  return { apply };
})();