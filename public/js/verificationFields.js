/**
 * Shared "current verification method" fields for sensitive account changes.
 * A passkey choice runs a WebAuthn ceremony against a re-authentication
 * challenge instead of reading a typed code.
 */
(function () {
    const LABELS = {
        passkey: 'Passkey',
        totp: 'Authenticator code',
        recovery: 'Recovery code'
    };

    function methodsFor({ passkeyCount = 0, totpEnabled = false, secondFactorEnabled = false } = {}, { passkeyUsable = true } = {}) {
        const methods = [];
        if (passkeyCount > 0 && passkeyUsable && window.NodeCastPasskeys?.isSupported()) methods.push('passkey');
        if (totpEnabled) methods.push('totp');
        if (secondFactorEnabled || totpEnabled || passkeyCount > 0) methods.push('recovery');
        return methods;
    }

    function html(methods, { prefix, groupClass = 'form-group' }) {
        if (!methods.length) return '';
        const options = methods.map(method => `<option value="${method}">${LABELS[method]}</option>`).join('');
        return `
            <div class="${groupClass}">
              <label for="${prefix}-factor-type">Current verification method</label>
              <select id="${prefix}-factor-type" class="form-input">${options}</select>
            </div>
            <div class="${groupClass}" data-factor-code-group>
              <label for="${prefix}-factor">Current verification code</label>
              <input id="${prefix}-factor" class="form-input" type="text" inputmode="numeric" autocomplete="one-time-code" required>
            </div>
            <p class="hint hidden" data-factor-passkey-hint>You will be asked to use one of your passkeys when you continue.</p>`;
    }

    function bind(container, prefix) {
        const type = container.querySelector(`#${prefix}-factor-type`);
        const credential = container.querySelector(`#${prefix}-factor`);
        if (!type || !credential) return;
        const codeGroup = container.querySelector('[data-factor-code-group]');
        const passkeyHint = container.querySelector('[data-factor-passkey-hint]');
        const update = () => {
            const passkey = type.value === 'passkey';
            const recovery = type.value === 'recovery';
            credential.value = '';
            credential.required = !passkey;
            credential.inputMode = recovery ? 'text' : 'numeric';
            credential.placeholder = recovery ? 'XXXXXX-XXXXXX-XXXXXX-XXXXXX' : '000000';
            codeGroup?.classList.toggle('hidden', passkey);
            passkeyHint?.classList.toggle('hidden', !passkey);
        };
        type.addEventListener('change', update);
        update();
    }

    async function payload(container, prefix) {
        const type = container.querySelector(`#${prefix}-factor-type`);
        if (!type) return {};
        if (type.value === 'passkey') {
            const { options } = await API.twoFactor.reauthPasskeyOptions();
            let credential;
            try {
                credential = await window.NodeCastPasskeys.authenticate(options);
            } catch (error) {
                throw new Error(window.NodeCastPasskeys.errorMessage(error));
            }
            return { credentialType: 'passkey', credential };
        }
        return {
            credentialType: type.value,
            credential: container.querySelector(`#${prefix}-factor`)?.value || ''
        };
    }

    window.NodeCastVerificationFields = { bind, html, methodsFor, payload };
})();
