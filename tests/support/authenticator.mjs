// Software passkey for local contract tests. It produces the same JSON shapes
// that @simplewebauthn/browser hands to the Worker, using ES256 keys and
// "none" attestation. It never talks to a real authenticator or production.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

export const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (data) => createHash("sha256").update(data).digest();

// Minimal CBOR encoder: maps, byte strings, text strings and integers.
function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

function cbor(value) {
  if (Number.isInteger(value)) {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const s = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, s.length), s]);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);
  }
  if (value instanceof Map) {
    const parts = [cborHead(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new Error("cbor: unsupported value");
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export class SoftPasskey {
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.x = Buffer.from(jwk.x, "base64url");
    this.y = Buffer.from(jwk.y, "base64url");
    this.credentialId = randomBytes(16);
    this.id = b64url(this.credentialId);
    this.counter = 0;
    this.userHandle = null;
  }

  coseKey() {
    return cbor(
      new Map([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, this.x],
        [-3, this.y],
      ])
    );
  }

  clientData(type, challenge, origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
  }

  /** Answer registration options. Overrides let tests forge bad origins/RP IDs. */
  register(options, { origin, rpId = options.rp.id, type = "webauthn.create" } = {}) {
    this.userHandle = options.user.id;
    const counter = Buffer.alloc(4);
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([FLAG_UP | FLAG_UV | FLAG_AT]),
      counter,
      Buffer.alloc(16), // AAGUID
      credLen,
      this.credentialId,
      this.coseKey(),
    ]);
    const attestationObject = cbor(
      new Map([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ])
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(this.clientData(type, options.challenge, origin)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** Answer authentication options with a signed assertion. */
  assert(options, { origin, rpId = options.rpId, tamper = false } = {}) {
    this.counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([FLAG_UP | FLAG_UV]), counter]);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, origin);
    let signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
    if (tamper) signature = Buffer.from(signature.map((b, i) => (i === signature.length - 1 ? b ^ 1 : b)));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: this.userHandle ?? undefined,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
