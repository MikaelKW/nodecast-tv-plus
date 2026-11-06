const crypto = require('node:crypto');

// Minimal CBOR encoder covering what "none" attestation objects and COSE
// keys need: unsigned/negative integers, byte strings, text, arrays and maps.
function cborHead(major, length) {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
    if (length < 0x10000) {
        const buffer = Buffer.alloc(3);
        buffer[0] = (major << 5) | 25;
        buffer.writeUInt16BE(length, 1);
        return buffer;
    }
    const buffer = Buffer.alloc(5);
    buffer[0] = (major << 5) | 26;
    buffer.writeUInt32BE(length, 1);
    return buffer;
}

function cbor(value) {
    if (Number.isInteger(value)) {
        return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);
    }
    if (typeof value === 'string') {
        const bytes = Buffer.from(value, 'utf8');
        return Buffer.concat([cborHead(3, bytes.length), bytes]);
    }
    if (Array.isArray(value)) {
        return Buffer.concat([cborHead(4, value.length), ...value.map(cbor)]);
    }
    if (value instanceof Map) {
        const parts = [cborHead(5, value.size)];
        for (const [key, item] of value) parts.push(cbor(key), cbor(item));
        return Buffer.concat(parts);
    }
    if (value && typeof value === 'object') return cbor(new Map(Object.entries(value)));
    throw new Error(`Unsupported CBOR value: ${value}`);
}

const FLAGS = {
    userPresent: 0x01,
    userVerified: 0x04,
    backupEligible: 0x08,
    backedUp: 0x10,
    attestedCredentialData: 0x40
};

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest();
}

function clientData(type, challenge, origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
}

/**
 * An in-process WebAuthn authenticator for API tests. `synced` models a
 * backed-up passkey that always reports a zero signature counter; otherwise
 * the counter increases with every assertion.
 */
class SoftwareAuthenticator {
    constructor({ rpId, origin, synced = false, initialCounter = 0 }) {
        this.rpId = rpId;
        this.origin = origin;
        this.synced = synced;
        this.counter = synced ? 0 : initialCounter;
        this.credentialId = crypto.randomBytes(32);
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
        this.privateKey = privateKey;
        this.publicJwk = publicKey.export({ format: 'jwk' });
        this.userHandle = null;
    }

    get id() {
        return this.credentialId.toString('base64url');
    }

    authenticatorData({ rpId = this.rpId, userVerified = true, attested = false, counter = this.counter }) {
        let flags = FLAGS.userPresent;
        if (userVerified) flags |= FLAGS.userVerified;
        if (this.synced) flags |= FLAGS.backupEligible | FLAGS.backedUp;
        if (attested) flags |= FLAGS.attestedCredentialData;
        const signCount = Buffer.alloc(4);
        signCount.writeUInt32BE(counter >>> 0);
        const parts = [sha256(Buffer.from(rpId, 'utf8')), Buffer.from([flags]), signCount];
        if (attested) {
            const idLength = Buffer.alloc(2);
            idLength.writeUInt16BE(this.credentialId.length);
            const coseKey = new Map([
                [1, 2],
                [3, -7],
                [-1, 1],
                [-2, Buffer.from(this.publicJwk.x, 'base64url')],
                [-3, Buffer.from(this.publicJwk.y, 'base64url')]
            ]);
            parts.push(Buffer.alloc(16), idLength, this.credentialId, cbor(coseKey));
        }
        return Buffer.concat(parts);
    }

    /** Build a registration response for server-issued creation options. */
    register(options, { origin = this.origin, rpId = this.rpId, userVerified = true } = {}) {
        this.userHandle = options.user.id;
        const data = clientData('webauthn.create', options.challenge, origin);
        const attestationObject = cbor(new Map([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', this.authenticatorData({ rpId, userVerified, attested: true })]
        ]));
        return {
            id: this.id,
            rawId: this.id,
            type: 'public-key',
            authenticatorAttachment: 'platform',
            clientExtensionResults: {},
            response: {
                clientDataJSON: data.toString('base64url'),
                attestationObject: attestationObject.toString('base64url'),
                transports: ['internal', 'hybrid']
            }
        };
    }

    /** Build an assertion for server-issued request options. */
    assert(options, {
        origin = this.origin,
        rpId = this.rpId,
        userVerified = true,
        counter = null,
        userHandle = this.userHandle
    } = {}) {
        if (counter !== null) this.counter = counter;
        else if (!this.synced) this.counter += 1;
        const authData = this.authenticatorData({ rpId, userVerified, counter: this.counter });
        const data = clientData('webauthn.get', options.challenge, origin);
        const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(data)]), this.privateKey);
        return {
            id: this.id,
            rawId: this.id,
            type: 'public-key',
            authenticatorAttachment: 'platform',
            clientExtensionResults: {},
            response: {
                clientDataJSON: data.toString('base64url'),
                authenticatorData: authData.toString('base64url'),
                signature: signature.toString('base64url'),
                userHandle: userHandle || undefined
            }
        };
    }
}

module.exports = { SoftwareAuthenticator, cbor };
