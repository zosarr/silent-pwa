//----------------------------------------------------
// Silent PWA - crypto.js
// Riparato e completo, nessun placeholder
//----------------------------------------------------

// Convert array buffer <-> base64 ----------------------------------------

function b64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function ub64(b64str) {
    const bin = atob(b64str);
    const len = bin.length;
    const arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return arr;
}

// SHA-256 helpers ---------------------------------------------------------

async function sha256(buf) {
    return crypto.subtle.digest("SHA-256", buf);
}

async function sha256Hex(input) {
    const data = (input instanceof Uint8Array || input instanceof ArrayBuffer)
        ? input
        : new TextEncoder().encode(input);

    const hash = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(hash)]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// Fingerprint -------------------------------------------------------------

function b64ToBytes(b64str) {
    return ub64(b64str);
}

export async function fingerprintFromRawBase64(rawB64, bits = 80) {
    const bytes = b64ToBytes(rawB64);
    const hash = new Uint8Array(await sha256(bytes));

    const neededBytes = Math.ceil(bits / 8);
    const slice = hash.slice(0, neededBytes);

    const hex = [...slice]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();

    const groupSize = 4;
    const groups = [];
    for (let i = 0; i < hex.length; i += groupSize) {
        groups.push(hex.slice(i, i + groupSize));
    }
    return groups.join('-');
}

// ------------------------------------------------------------------------
// E2E CLASS (ECDH + AES-GCM)
// ------------------------------------------------------------------------

export class E2E {
    constructor() {
        this.keyPair = null;
        this.pub = null;
        this.rawPub = null;
        this.sharedKey = null;
        this.ready = false;
    }

    async ensureKeys() {
        if (this.keyPair) return;
        this.keyPair = await crypto.subtle.generateKey(
            {
                name: "ECDH",
                namedCurve: "P-256",
            },
            true,
            ["deriveKey"]
        );

        this.pub = await crypto.subtle.exportKey("raw", this.keyPair.publicKey);
        this.rawPub = b64(this.pub);
    }

    async initPeer(peerRawB64) {
        await this.ensureKeys();

        const peerRaw = ub64(peerRawB64);

        const peerKey = await crypto.subtle.importKey(
            "raw",
            peerRaw,
            { name: "ECDH", namedCurve: "P-256" },
            false,
            []
        );

        this.sharedKey = await crypto.subtle.deriveKey(
            { name: "ECDH", public: peerKey },
            this.keyPair.privateKey,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );

        this.ready = true;
    }

    async encrypt(plainText) {
        if (!this.ready) throw new Error("Chiave condivisa non pronta.");

        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = new TextEncoder().encode(plainText);

        const ctBuf = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            this.sharedKey,
            data
        );

        return {
            iv: b64(iv),
            ct: b64(ctBuf),
        };
    }

    async decrypt(ivB64, ctB64) {
        if (!this.ready) throw new Error("Chiave condivisa non pronta.");

        const iv = ub64(ivB64);
        const ct = ub64(ctB64);

        const plainBuf = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            this.sharedKey,
            ct
        );

        return new TextDecoder().decode(plainBuf);
    }
}
