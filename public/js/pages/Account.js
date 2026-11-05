const ACCOUNT_FLOW_IDS = ['passkeys-flow', 'two-factor-flow', 'recovery-codes-flow'];

class AccountPage {
    constructor(app) {
        this.app = app;
        this.status = null;
        this.passkeys = null;
        this.recoveryCodes = [];
        this.enrollOnNextShow = false;
    }

    async show() {
        await this.loadStatus();
        if (this.enrollOnNextShow) {
            this.enrollOnNextShow = false;
            if (!this.status?.enabled && this.status?.canEnroll) this.openEnrollment();
        }
    }

    requestEnrollmentOnNextShow() {
        this.enrollOnNextShow = true;
    }

    hide() {
        this.clearSensitiveView();
    }

    clearSensitiveView() {
        this.recoveryCodes = [];
        for (const id of ACCOUNT_FLOW_IDS) {
            const flow = document.getElementById(id);
            if (!flow) continue;
            flow.replaceChildren();
            flow.classList.add('hidden');
        }
    }

    async loadStatus() {
        const [status, passkeys] = await Promise.allSettled([
            API.twoFactor.status(),
            API.passkeys.list()
        ]);
        this.status = status.status === 'fulfilled' ? status.value : null;
        this.passkeys = passkeys.status === 'fulfilled' ? passkeys.value : null;
        this.renderTwoFactor(status.status === 'rejected' ? status.reason : null);
        this.renderPasskeys(passkeys.status === 'rejected' ? passkeys.reason : null);
        this.renderRecoveryCodes();
    }

    passkeyUnavailableReason() {
        return window.NodeCastPasskeys ? NodeCastPasskeys.unavailableReason(this.passkeys) : 'Passkeys are unavailable.';
    }

    setBadge(badge, text, state) {
        badge.textContent = text;
        badge.className = 'security-status-badge';
        if (state) badge.classList.add(state);
    }

    renderTwoFactor(error) {
        const badge = document.getElementById('two-factor-status-badge');
        const message = document.getElementById('two-factor-status-message');
        const actions = document.getElementById('two-factor-actions');
        if (!badge || !message || !actions) return;
        actions.replaceChildren();
        message.textContent = '';

        if (error || !this.status) {
            this.setBadge(badge, 'Unavailable', 'disabled');
            message.textContent = error?.message || 'Could not load two-factor status.';
            return;
        }

        if (this.status.enabled) {
            this.setBadge(badge, 'Enabled', 'enabled');
            message.textContent = 'An authenticator-app code is accepted after your password.';
            actions.append(
                this.actionButton('Disable two-factor authentication', () => this.openProtectedAction('disable'), 'btn-error')
            );
            return;
        }

        this.setBadge(badge, 'Not enabled', 'disabled');
        if (this.status.accountType === 'sso') {
            message.textContent = 'This account signs in through the configured SSO provider.';
            return;
        }
        if (!this.status.canEnroll) {
            message.textContent = 'Two-factor authentication is not configured on this server.';
            return;
        }

        message.textContent = 'Add an authenticator app code after your password.';
        actions.append(this.actionButton('Enable two-factor authentication', () => this.openEnrollment(), 'btn-primary'));
    }

    renderPasskeys(error) {
        const badge = document.getElementById('passkeys-status-badge');
        const message = document.getElementById('passkeys-status-message');
        const list = document.getElementById('passkeys-list');
        const actions = document.getElementById('passkeys-actions');
        if (!badge || !message || !list || !actions) return;
        list.replaceChildren();
        actions.replaceChildren();
        message.textContent = '';

        if (error || !this.passkeys) {
            this.setBadge(badge, 'Unavailable', 'disabled');
            message.textContent = error?.message || 'Could not load passkeys.';
            return;
        }

        const passkeys = this.passkeys.passkeys || [];
        this.setBadge(
            badge,
            passkeys.length === 0 ? 'None' : `${passkeys.length} ${passkeys.length === 1 ? 'passkey' : 'passkeys'}`,
            passkeys.length === 0 ? 'disabled' : 'enabled'
        );

        if (this.passkeys.accountType === 'sso') {
            message.textContent = 'This account signs in through the configured SSO provider.';
            return;
        }

        for (const passkey of passkeys) list.append(this.passkeyItem(passkey));

        const unavailable = this.passkeyUnavailableReason();
        if (unavailable) {
            message.textContent = unavailable;
            return;
        }

        message.textContent = passkeys.length === 0
            ? 'Sign in with your fingerprint, face, or device screen lock instead of typing your password.'
            : 'Use a passkey to sign in without a password, or as the second step after your password.';
        if (passkeys.length < (this.passkeys.maxPasskeys || 20)) {
            actions.append(this.actionButton('Add a passkey', () => this.openAddPasskey(), 'btn-primary'));
        }
    }

    passkeyItem(passkey) {
        const item = document.createElement('li');
        item.className = 'passkey-item';

        const details = document.createElement('div');
        details.className = 'passkey-details';
        const name = document.createElement('strong');
        name.className = 'passkey-name';
        name.textContent = passkey.name;
        const kind = document.createElement('span');
        kind.className = 'user-badge passkey-kind';
        kind.textContent = passkey.backedUp ? 'Synced' : 'This device only';
        kind.title = passkey.backedUp
            ? 'Backed up by your password manager and available on your other devices.'
            : 'Stored only on the device or security key that created it.';
        const meta = document.createElement('span');
        meta.className = 'hint passkey-meta';
        meta.textContent = `Added ${this.formatDate(passkey.createdAt)} · ${passkey.lastUsedAt ? `Last used ${this.formatDate(passkey.lastUsedAt)}` : 'Not used yet'}`;
        const heading = document.createElement('div');
        heading.className = 'passkey-heading';
        heading.append(name, kind);
        details.append(heading, meta);

        const buttons = document.createElement('div');
        buttons.className = 'passkey-buttons';
        buttons.append(
            this.actionButton('Rename', () => this.openRenamePasskey(passkey), 'btn-secondary btn-sm'),
            this.actionButton('Remove', () => this.openRemovePasskey(passkey), 'btn-error btn-sm')
        );
        item.append(details, buttons);
        return item;
    }

    renderRecoveryCodes() {
        const card = document.getElementById('recovery-codes-card');
        const message = document.getElementById('recovery-codes-message');
        const actions = document.getElementById('recovery-codes-actions');
        if (!card || !message || !actions) return;
        actions.replaceChildren();
        const enabled = Boolean(this.status?.secondFactorEnabled);
        card.classList.toggle('hidden', !enabled);
        if (!enabled) return;

        const remaining = this.status.recoveryCodesRemaining;
        message.textContent = remaining > 0
            ? `${remaining} recovery ${remaining === 1 ? 'code remains' : 'codes remain'}. Each code works once, in place of a passkey or authenticator code.`
            : 'No recovery codes remain. Generate new codes so you can still sign in if you lose your devices.';
        message.classList.toggle('warning', remaining <= 2);
        actions.append(this.actionButton('Generate new recovery codes', () => this.openProtectedAction('recovery'), remaining > 0 ? 'btn-secondary' : 'btn-primary'));
    }

    formatDate(value) {
        if (!value) return 'unknown';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric'
        });
    }

    actionButton(label, handler, extraClass = 'btn-secondary') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `btn ${extraClass}`;
        button.textContent = label;
        button.addEventListener('click', handler);
        return button;
    }

    showFlow(html, flowId = 'two-factor-flow') {
        this.clearSensitiveView();
        const flow = document.getElementById(flowId);
        flow.innerHTML = html;
        flow.classList.remove('hidden');
        flow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        flow.querySelector('[data-cancel]')?.addEventListener('click', () => this.clearSensitiveView());
        return flow;
    }

    verificationMethods() {
        return NodeCastVerificationFields.methodsFor({
            passkeyCount: this.status?.passkeyCount || 0,
            totpEnabled: this.status?.enabled,
            secondFactorEnabled: this.status?.secondFactorEnabled
        }, { passkeyUsable: !this.passkeyUnavailableReason() });
    }

    factorFields() {
        return NodeCastVerificationFields.html(this.verificationMethods(), { prefix: 'account' });
    }

    passwordField() {
        return `
            <div class="form-group">
              <label for="account-password">Current password</label>
              <input id="account-password" class="form-input" type="password" autocomplete="current-password" required>
            </div>`;
    }

    flowActions(submitLabel, submitClass = 'btn-primary') {
        return `
            <div class="account-flow-error" role="alert"></div>
            <div class="account-actions">
              <button type="button" class="btn btn-secondary" data-cancel>Cancel</button>
              <button type="submit" class="btn ${submitClass}">${submitLabel}</button>
            </div>`;
    }

    async credentialPayload(container) {
        return {
            password: container.querySelector('#account-password')?.value || '',
            ...await NodeCastVerificationFields.payload(container, 'account')
        };
    }

    reauthenticationHint() {
        return this.status?.secondFactorEnabled
            ? 'Sensitive account changes require your current password and one of your current verification methods.'
            : 'Sensitive account changes require your current password.';
    }

    escape(value) {
        const span = document.createElement('span');
        span.textContent = value;
        return span.innerHTML;
    }

    openEnrollment() {
        const flow = this.showFlow(`
            <h4>${this.status.enabled ? 'Replace authenticator app' : 'Verify your password'}</h4>
            <p class="hint">${this.reauthenticationHint()}</p>
            <form id="account-enroll-start-form" class="account-form">
              ${this.passwordField()}
              ${this.factorFields()}
              ${this.flowActions('Continue')}
            </form>`);
        NodeCastVerificationFields.bind(flow, 'account');
        flow.querySelector('form').addEventListener('submit', event => this.startEnrollment(event));
    }

    async startEnrollment(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const submit = form.querySelector('[type="submit"]');
        this.setBusy(submit, true);
        try {
            const enrollment = await API.twoFactor.enroll(await this.credentialPayload(form));
            this.showEnrollmentQr(enrollment);
        } catch (error) {
            this.showFlowError(form, error.message);
            this.setBusy(submit, false);
        }
    }

    showEnrollmentQr(enrollment) {
        const flow = this.showFlow(`
            <h4>Connect an authenticator app</h4>
            <ol class="account-steps">
              <li>Scan the QR code with a standard authenticator app.</li>
              <li>Enter the six-digit code shown by the app.</li>
            </ol>
            <div class="totp-qr-wrap"><img id="totp-qr-image" alt="Authenticator enrollment QR code"></div>
            <p class="hint">Cannot scan the code? Enter this setup key manually:</p>
            <code id="totp-manual-secret" class="totp-manual-secret"></code>
            <form id="account-enroll-confirm-form" class="account-form">
              <div class="form-group">
                <label for="account-confirm-code">Six-digit code</label>
                <input id="account-confirm-code" class="form-input" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>
              </div>
              ${this.flowActions('Enable')}
            </form>`);
        flow.querySelector('#totp-qr-image').src = enrollment.qrDataUrl;
        flow.querySelector('#totp-manual-secret').textContent = enrollment.manualSecret;
        flow.querySelector('form').addEventListener('submit', event => this.confirmEnrollment(event));
        flow.querySelector('#account-confirm-code').focus();
    }

    async confirmEnrollment(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const submit = form.querySelector('[type="submit"]');
        this.setBusy(submit, true);
        try {
            const result = await API.twoFactor.confirm(document.getElementById('account-confirm-code').value);
            if (result.recoveryCodes?.length) {
                this.showRecoveryCodes(result.recoveryCodes, 'Two-factor authentication is enabled');
            } else {
                this.showDone('Two-factor authentication is enabled', 'Your existing recovery codes remain valid.');
            }
        } catch (error) {
            this.showFlowError(form, error.message);
            this.setBusy(submit, false);
        }
    }

    openProtectedAction(action) {
        const isRecovery = action === 'recovery';
        let warning = '';
        if (!isRecovery) {
            warning = (this.status?.passkeyCount || 0) > 0
                ? '<div class="account-message">Your passkeys and recovery codes stay active for two-factor sign-in.</div>'
                : '<div class="account-message warning">This is your only second factor. After disabling it, signing in with only your password is possible again and your recovery codes are deleted.</div>';
        }
        const flow = this.showFlow(`
            <h4>${isRecovery ? 'Generate new recovery codes' : 'Disable two-factor authentication'}</h4>
            ${isRecovery ? '<p class="hint">Your current recovery codes stop working when new codes are generated.</p>' : warning}
            <p class="hint">${this.reauthenticationHint()}</p>
            <form id="account-protected-action-form" class="account-form">
              ${this.passwordField()}
              ${this.factorFields()}
              ${this.flowActions(isRecovery ? 'Generate codes' : 'Disable', isRecovery ? 'btn-primary' : 'btn-error')}
            </form>`, isRecovery ? 'recovery-codes-flow' : 'two-factor-flow');
        NodeCastVerificationFields.bind(flow, 'account');
        flow.querySelector('form').addEventListener('submit', event => this.submitProtectedAction(event, action));
    }

    async submitProtectedAction(event, action) {
        event.preventDefault();
        const form = event.currentTarget;
        const submit = form.querySelector('[type="submit"]');
        this.setBusy(submit, true);
        try {
            const payload = await this.credentialPayload(form);
            if (action === 'recovery') {
                const result = await API.twoFactor.regenerateRecoveryCodes(payload);
                this.showRecoveryCodes(result.recoveryCodes, 'New recovery codes generated', 'recovery-codes-flow');
            } else {
                await API.twoFactor.disable(payload);
                this.clearSensitiveView();
                await this.refreshAfterSecurityChange();
            }
        } catch (error) {
            this.showFlowError(form, error.message);
            this.setBusy(submit, false);
        }
    }

    suggestedPasskeyName() {
        const platform = navigator.userAgentData?.platform || '';
        const known = ['Windows', 'macOS', 'Android', 'iOS', 'Linux', 'Chrome OS'].find(name => platform.includes(name));
        if (known) return `${known} passkey`;
        if (/iPhone|iPad/.test(navigator.userAgent)) return 'iOS passkey';
        if (/Macintosh/.test(navigator.userAgent)) return 'macOS passkey';
        if (/Android/.test(navigator.userAgent)) return 'Android passkey';
        if (/Windows/.test(navigator.userAgent)) return 'Windows passkey';
        return 'Passkey';
    }

    openAddPasskey() {
        const first = !this.status?.secondFactorEnabled;
        const explanation = first
            ? `<div class="account-message warning">After you add a passkey, signing in with your password also requires a second step: a passkey${this.status?.enabled ? ', an authenticator code' : ''} or a recovery code. Recovery codes are created when you add it. You can also sign in with only the passkey.</div>`
            : '<p class="hint">The new passkey can be used to sign in without a password and as the second step after your password.</p>';
        const flow = this.showFlow(`
            <h4>Add a passkey</h4>
            ${explanation}
            <form id="account-passkey-add-form" class="account-form">
              <div class="form-group">
                <label for="account-passkey-name">Passkey name</label>
                <input id="account-passkey-name" class="form-input" type="text" maxlength="64" required>
              </div>
              <p class="hint">${this.reauthenticationHint()}</p>
              ${this.passwordField()}
              ${this.factorFields()}
              ${this.flowActions('Continue')}
            </form>`, 'passkeys-flow');
        flow.querySelector('#account-passkey-name').value = this.suggestedPasskeyName();
        NodeCastVerificationFields.bind(flow, 'account');
        flow.querySelector('form').addEventListener('submit', event => this.submitAddPasskey(event));
    }

    async submitAddPasskey(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const submit = form.querySelector('[type="submit"]');
        const name = form.querySelector('#account-passkey-name').value;
        this.setBusy(submit, true);
        try {
            const { options } = await API.passkeys.registrationOptions(await this.credentialPayload(form));
            let response;
            try {
                response = await NodeCastPasskeys.register(options);
            } catch (error) {
                throw new Error(NodeCastPasskeys.errorMessage(error));
            }
            const result = await API.passkeys.register({ response, name });
            if (result.recoveryCodes?.length) {
                this.showRecoveryCodes(result.recoveryCodes, 'Passkey added', 'passkeys-flow');
            } else {
                this.showDone('Passkey added', `“${result.passkey.name}” can now be used to sign in.`, 'passkeys-flow');
            }
            await this.refreshAfterSecurityChange({ keepFlow: true });
        } catch (error) {
            this.showFlowError(form, error.message);
            this.setBusy(submit, false);
        }
    }

    openRenamePasskey(passkey) {
        const flow = this.showFlow(`
            <h4>Rename passkey</h4>
            <form id="account-passkey-rename-form" class="account-form">
              <div class="form-group">
                <label for="account-passkey-new-name">Passkey name</label>
                <input id="account-passkey-new-name" class="form-input" type="text" maxlength="64" required>
              </div>
              ${this.flowActions('Save')}
            </form>`, 'passkeys-flow');
        const input = flow.querySelector('#account-passkey-new-name');
        input.value = passkey.name;
        input.select();
        flow.querySelector('form').addEventListener('submit', async event => {
            event.preventDefault();
            const submit = event.currentTarget.querySelector('[type="submit"]');
            this.setBusy(submit, true);
            try {
                await API.passkeys.rename(passkey.id, input.value);
                this.clearSensitiveView();
                await this.loadStatus();
            } catch (error) {
                this.showFlowError(event.currentTarget, error.message);
                this.setBusy(submit, false);
            }
        });
    }

    openRemovePasskey(passkey) {
        const last = (this.status?.passkeyCount || 0) <= 1;
        let warning = '';
        if (last && this.status?.enabled) {
            warning = '<div class="account-message">This is your last passkey. Your authenticator app stays enabled for two-factor sign-in.</div>';
        } else if (last) {
            warning = '<div class="account-message warning">This is your only second factor. After removing it, signing in with only your password is possible again and your recovery codes are deleted.</div>';
        }
        const flow = this.showFlow(`
            <h4>Remove passkey “${this.escape(passkey.name)}”</h4>
            ${warning}
            <p class="hint">Also remove the passkey from your device or password manager afterwards; it can no longer be used here.</p>
            <p class="hint">${this.reauthenticationHint()}</p>
            <form id="account-passkey-remove-form" class="account-form">
              ${this.passwordField()}
              ${this.factorFields()}
              ${this.flowActions('Remove passkey', 'btn-error')}
            </form>`, 'passkeys-flow');
        NodeCastVerificationFields.bind(flow, 'account');
        flow.querySelector('form').addEventListener('submit', async event => {
            event.preventDefault();
            const form = event.currentTarget;
            const submit = form.querySelector('[type="submit"]');
            this.setBusy(submit, true);
            try {
                await API.passkeys.remove(passkey.id, await this.credentialPayload(form));
                this.clearSensitiveView();
                await this.refreshAfterSecurityChange();
            } catch (error) {
                this.showFlowError(form, error.message);
                this.setBusy(submit, false);
            }
        });
    }

    async refreshAfterSecurityChange({ keepFlow = false } = {}) {
        if (keepFlow) {
            const [status, passkeys] = await Promise.allSettled([API.twoFactor.status(), API.passkeys.list()]);
            if (status.status === 'fulfilled') this.status = status.value;
            if (passkeys.status === 'fulfilled') this.passkeys = passkeys.value;
            this.renderTwoFactor(status.status === 'rejected' ? status.reason : null);
            this.renderPasskeys(passkeys.status === 'rejected' ? passkeys.reason : null);
            this.renderRecoveryCodes();
        } else {
            await this.loadStatus();
        }
        if (this.app?.currentUser && this.status) {
            this.app.currentUser.twoFactorEnabled = Boolean(this.status.secondFactorEnabled);
            this.app.currentUser.totpEnabled = Boolean(this.status.enabled);
            this.app.currentUser.passkeyCount = this.status.passkeyCount || 0;
        }
    }

    showDone(heading, text, flowId = 'two-factor-flow') {
        const flow = this.showFlow(`
            <h4>${this.escape(heading)}</h4>
            <div class="account-message"></div>
            <div class="account-actions">
              <button type="button" class="btn btn-primary" data-finish>Done</button>
            </div>`, flowId);
        flow.querySelector('.account-message').textContent = text;
        flow.querySelector('[data-finish]').addEventListener('click', async () => {
            this.clearSensitiveView();
            await this.refreshAfterSecurityChange();
        });
    }

    showRecoveryCodes(codes, heading, flowId = 'two-factor-flow') {
        const flow = this.showFlow(`
            <h4>${this.escape(heading)}</h4>
            <div class="account-message warning">Save these recovery codes now. Each code works once, and they will not be shown again.</div>
            <pre id="account-recovery-codes" class="recovery-code-list"></pre>
            <div class="account-actions">
              <button type="button" class="btn btn-secondary" data-copy>Copy codes</button>
              <button type="button" class="btn btn-secondary" data-download>Download text file</button>
              <button type="button" class="btn btn-primary" data-finish>I have saved them</button>
            </div>`, flowId);
        this.recoveryCodes = [...codes];
        flow.querySelector('#account-recovery-codes').textContent = codes.join('\n');
        flow.querySelector('[data-copy]').addEventListener('click', async event => {
            const copied = await this.copyText(this.recoveryCodes.join('\n'));
            event.currentTarget.textContent = copied ? 'Copied' : 'Select and copy the codes above';
        });
        flow.querySelector('[data-download]').addEventListener('click', () => this.downloadRecoveryCodes());
        flow.querySelector('[data-finish]').addEventListener('click', async () => {
            this.clearSensitiveView();
            await this.refreshAfterSecurityChange();
        });
    }

    downloadRecoveryCodes() {
        const blob = new Blob([
            'NodeCast TV Plus recovery codes\n',
            'Each code can be used once. Store this file securely.\n\n',
            this.recoveryCodes.join('\n'),
            '\n'
        ], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'nodecast-tv-plus-recovery-codes.txt';
        link.click();
        URL.revokeObjectURL(url);
    }

    async copyText(value) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(value);
                return true;
            }
            const textarea = document.createElement('textarea');
            textarea.value = value;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            const copied = document.execCommand('copy');
            textarea.remove();
            return copied;
        } catch {
            return false;
        }
    }

    setBusy(button, busy) {
        button.disabled = busy;
        if (!button.dataset.label) button.dataset.label = button.textContent;
        button.textContent = busy ? 'Please wait…' : button.dataset.label;
    }

    showFlowError(container, message) {
        const target = container.querySelector('.account-flow-error');
        target.textContent = message;
        target.classList.add('show');
    }
}

window.AccountPage = AccountPage;
