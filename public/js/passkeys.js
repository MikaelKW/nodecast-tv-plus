/**
 * Minimal WebAuthn helper: converts the server's JSON options for
 * navigator.credentials and serializes the resulting credentials back to JSON.
 */
(function () {
    function base64UrlToBuffer(value) {
        const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes.buffer;
    }

    function bufferToBase64Url(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function descriptors(list) {
        return (list || []).map(item => ({ ...item, id: base64UrlToBuffer(item.id) }));
    }

    function isSupported() {
        return Boolean(
            window.isSecureContext
            && window.PublicKeyCredential
            && navigator.credentials
            && typeof navigator.credentials.create === 'function'
            && typeof navigator.credentials.get === 'function'
        );
    }

    /**
     * Explain why passkeys cannot be used on this page, or return '' when
     * they can. `availability` is the server's availability response.
     */
    function unavailableReason(availability) {
        if (!availability?.available) {
            return availability?.message || 'Passkeys are not available on this server.';
        }
        if (availability.origin && window.location.origin.toLowerCase() !== availability.origin) {
            return `Passkeys are registered for ${availability.origin}. Open NodeCast TV Plus at that address to use them.`;
        }
        if (!isSupported()) {
            return window.isSecureContext
                ? 'This browser does not support passkeys.'
                : 'Passkeys require a secure (HTTPS) connection.';
        }
        return '';
    }

    function optionalBuffer(response, method) {
        try {
            const value = typeof response[method] === 'function' ? response[method]() : null;
            return value ? bufferToBase64Url(value) : undefined;
        } catch {
            return undefined;
        }
    }

    async function register(options) {
        const publicKey = {
            ...options,
            challenge: base64UrlToBuffer(options.challenge),
            user: { ...options.user, id: base64UrlToBuffer(options.user.id) },
            excludeCredentials: descriptors(options.excludeCredentials)
        };
        const credential = await navigator.credentials.create({ publicKey });
        const response = credential.response;
        let transports = [];
        try {
            transports = typeof response.getTransports === 'function' ? response.getTransports() : [];
        } catch {
            transports = [];
        }
        const algorithm = typeof response.getPublicKeyAlgorithm === 'function' ? response.getPublicKeyAlgorithm() : undefined;
        return {
            id: credential.id,
            rawId: bufferToBase64Url(credential.rawId),
            type: credential.type,
            authenticatorAttachment: credential.authenticatorAttachment || undefined,
            clientExtensionResults: credential.getClientExtensionResults(),
            response: {
                clientDataJSON: bufferToBase64Url(response.clientDataJSON),
                attestationObject: bufferToBase64Url(response.attestationObject),
                authenticatorData: optionalBuffer(response, 'getAuthenticatorData'),
                publicKey: optionalBuffer(response, 'getPublicKey'),
                publicKeyAlgorithm: algorithm,
                transports
            }
        };
    }

    async function authenticate(options) {
        const publicKey = {
            ...options,
            challenge: base64UrlToBuffer(options.challenge),
            allowCredentials: descriptors(options.allowCredentials)
        };
        const credential = await navigator.credentials.get({ publicKey });
        const response = credential.response;
        return {
            id: credential.id,
            rawId: bufferToBase64Url(credential.rawId),
            type: credential.type,
            authenticatorAttachment: credential.authenticatorAttachment || undefined,
            clientExtensionResults: credential.getClientExtensionResults(),
            response: {
                clientDataJSON: bufferToBase64Url(response.clientDataJSON),
                authenticatorData: bufferToBase64Url(response.authenticatorData),
                signature: bufferToBase64Url(response.signature),
                userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : undefined
            }
        };
    }

    function errorMessage(error) {
        switch (error?.name) {
            case 'NotAllowedError':
            case 'AbortError':
                return 'The passkey request was cancelled or timed out.';
            case 'InvalidStateError':
                return 'This passkey is already registered for this account.';
            case 'SecurityError':
                return 'Passkeys cannot be used at this address.';
            case 'NotSupportedError':
                return 'This device does not support the requested passkey.';
            default:
                return error?.message || 'The passkey request failed.';
        }
    }

    window.NodeCastPasskeys = {
        authenticate,
        errorMessage,
        isSupported,
        register,
        unavailableReason
    };
})();
