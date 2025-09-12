function b64(arr){ return btoa(String.fromCharCode(...new Uint8Array(arr))); }
function ub64(str){ return Uint8Array.from(atob(str), c=>c.charCodeAt(0)); }
export class E2E {
  constructor(){ this.ecKeyPair=null; this.sharedKey=null; this.peerPubRaw=null; this.ready=false; }
  async init(){
    this.ecKeyPair = await crypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"}, true, ["deriveKey","deriveBits"]);
    const rawPub = await crypto.subtle.exportKey("raw", this.ecKeyPair.publicKey);
    return b64(rawPub);
  }
  async setPeerPublicKey(base64raw){
    this.peerPubRaw = ub64(base64raw).buffer;
    const peerPubKey = await crypto.subtle.importKey("raw", this.peerPubRaw, {name:"ECDH",namedCurve:"P-256"}, true, []);
    this.sharedKey = await crypto.subtle.deriveKey({name:"ECDH", public: peerPubKey}, this.ecKeyPair.privateKey,
                      {name:"AES-GCM", length:256}, false, ["encrypt","decrypt"]);
    this.ready = true; return true;
  }
  async encrypt(plainText){
    if(!this.sharedKey) throw new Error("No shared key");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder().encode(plainText);
    const ct = await crypto.subtle.encrypt({name:"AES-GCM", iv}, this.sharedKey, enc);
    return {iv:b64(iv), ct:b64(ct)};
  }
  async decrypt(ivB64, ctB64){
    if(!this.sharedKey) throw new Error("No shared key");
    const iv = ub64(ivB64); const ct = ub64(ctB64);
    const pt = await crypto.subtle.decrypt({name:"AES-GCM", iv}, this.sharedKey, ct);
    return new TextDecoder().decode(pt);
  }
    async encryptBytes(buffer){ // buffer: ArrayBuffer
    if(!this.sharedKey) throw new Error("No shared key");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({name:"AES-GCM", iv}, this.sharedKey, buffer);
    return { iv, ct }; // Uint8Array/ArrayBuffer
  }

  async decryptBytes(iv, ct){ // iv: Uint8Array / ArrayBuffer, ct: ArrayBuffer
    if(!this.sharedKey) throw new Error("No shared key");
    const ivU8 = iv instanceof Uint8Array ? iv : new Uint8Array(iv);
    const pt = await crypto.subtle.decrypt({name:"AES-GCM", iv: ivU8}, this.sharedKey, ct);
    return pt; // ArrayBuffer
  }

}
