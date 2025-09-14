// Helpers base64 sicuri anche per payload grandi (no spread)
function b64(input){
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let binary = '';
  const chunk = 0x8000; // 32KB
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, sub);
  }
  return btoa(binary);
}
function ub64(str){
  const bin = atob(str);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class E2E {
  constructor(){ this.ecKeyPair=null; this.sharedKey=null; this.peerPubRaw=null; this.ready=false; this.myPubRaw=null; }

  async init(){
    this.ecKeyPair = await crypto.subtle.generateKey({name:"ECDH",namedCurve:"P-256"}, true, ["deriveKey","deriveBits"]);
    this.myPubRaw = await crypto.subtle.exportKey("raw", this.ecKeyPair.publicKey);
    return b64(this.myPubRaw);
  }

  async myFingerprintHex(){
    if(!this.myPubRaw) return '';
    const d = await crypto.subtle.digest("SHA-256", this.myPubRaw);
    return Array.from(new Uint8Array(d)).map(b=>b.toString(16).padStart(2,'0')).join('');
  }

  async setPeerPublicKey(base64raw){
    this.peerPubRaw = ub64(base64raw).buffer;
    const peerPubKey = await crypto.subtle.importKey("raw", this.peerPubRaw, {name:"ECDH",namedCurve:"P-256"}, true, []);
    this.sharedKey = await crypto.subtle.deriveKey(
      {name:"ECDH", public: peerPubKey},
      this.ecKeyPair.privateKey,
      {name:"AES-GCM", length:256},
      false,
      ["encrypt","decrypt"]
    );
    this.ready = true;
    return true;
  }

  // ---- Testo ----
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

  // ---- Bytes (audio/foto) ----
  async encryptBytes(buffer){
    if(!this.sharedKey) throw new Error("No shared key");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const u8 = buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const ct = await crypto.subtle.encrypt({name:"AES-GCM", iv}, this.sharedKey, u8);
    return {iv:b64(iv), ct:b64(ct)};
  }
  async decryptBytes(ivB64, ctB64){
    if(!this.sharedKey) throw new Error("No shared key");
    const iv = ub64(ivB64); const ct = ub64(ctB64);
    const pt = await crypto.subtle.decrypt({name:"AES-GCM", iv}, this.sharedKey, ct);
    return pt; // ArrayBuffer
  }
}
