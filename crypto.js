// crypto.js — E2E using ECDH (P-256) -> AES-GCM
export const CryptoE2E = (() => {
  const subtle = crypto.subtle;

  async function generateKeyPair(){
    const kp = await subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits","deriveKey"]
    );
    const pubJwk = await subtle.exportKey("jwk", kp.publicKey);
    return { kp, pubJwk };
  }

  async function importPeerPublic(jwk){
    return subtle.importKey("jwk", jwk, { name:"ECDH", namedCurve:"P-256" }, false, []);
  }

  async function deriveAesGcmKey(privateKey, peerPublicKey){
    const key = await subtle.deriveKey(
      { name: "ECDH", public: peerPublicKey },
      privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt","decrypt"]
    );
    return key;
  }

  function utf8ToBytes(str){ return new TextEncoder().encode(str); }
  function bytesToUtf8(buf){ return new TextDecoder().decode(buf); }
  function toB64(bytes){ return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
  function fromB64(b64){ return Uint8Array.from(atob(b64), c => c.charCodeAt(0)); }

  async function encryptText(aesKey, plaintext){
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = utf8ToBytes(plaintext);
    const ct = await subtle.encrypt({ name:"AES-GCM", iv }, aesKey, data);
    return { iv: Array.from(iv), ct: toB64(ct) };
  }

  async function decryptText(aesKey, payload){
    const iv = new Uint8Array(payload.iv);
    const ctBytes = fromB64(payload.ct);
    const pt = await subtle.decrypt({ name:"AES-GCM", iv }, aesKey, ctBytes);
    return bytesToUtf8(pt);
  }

  async function encryptBytes(aesKey, bytes){
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name:"AES-GCM", iv }, aesKey, bytes);
    // simple format: [ 'SBLK'(4) | 'BIN'(3) | ivLen(1) | iv | ct ]
    const header = new TextEncoder().encode("SBLK");
    const kind = new TextEncoder().encode("BIN");
    const ivLen = new Uint8Array([iv.byteLength]);
    const blob = new Uint8Array(header.byteLength + kind.byteLength + ivLen.byteLength + iv.byteLength + ct.byteLength);
    let o = 0;
    blob.set(header, o); o += header.byteLength;
    blob.set(kind, o); o += kind.byteLength;
    blob.set(ivLen, o); o += ivLen.byteLength;
    blob.set(iv, o); o += iv.byteLength;
    blob.set(new Uint8Array(ct), o);
    return blob.buffer;
  }

  async function decryptBytes(aesKey, buffer){
    const u = new Uint8Array(buffer);
    const header = new TextDecoder().decode(u.slice(0,4));
    if(header !== "SBLK") throw new Error("Bad header");
    const ivLen = u[7];
    const iv = u.slice(8, 8+ivLen);
    const ct = u.slice(8+ivLen);
    const pt = await subtle.decrypt({ name:"AES-GCM", iv }, aesKey, ct);
    return new Uint8Array(pt).buffer;
  }

  return {
    generateKeyPair,
    importPeerPublic,
    deriveAesGcmKey,
    encryptText,
    decryptText,
    encryptBytes,
    decryptBytes,
  };
})();