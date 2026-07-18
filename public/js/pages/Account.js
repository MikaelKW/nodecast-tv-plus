class AccountPage {
    constructor(app) {
        this.app = app;
        this.status = null;
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
        const flow = document.getElementById('two-factor-flow');
        if (flow) {
            flow.replaceChildren();
            flow.classList.add('hidden');
        }
    }

    async loadStatus() {
        const badge = document.getElementById('two-factor-status-badge');
        const message = document.getElementById('two-factor-status-message');
        const actions = document.getElementById('two-factor-actions');
        if (!badge || !message || !actions) return;

        badge.textContent = 'Loading…';
        badge.className = 'security-status-badge';
        actions.replaceChildren();
        message.textContent = '';

        try {
            this.status = await API.twoFactor.status();
            if (this.status.enabled) {
                badge.textContent = 'Enabled';
                badge.classList.add('enabled');
                message.textContent = `${this.status.recoveryCodesRemaining} recovery codes remain.`;
                actions.append(
                    this.actionButton('Generate new recovery codes', () => this.openProtectedAction('recovery')),
                    this.actionButton('Disable two-factor authentication', () => this.openProtectedAction('disable'), 'btn-error')
                );
                return;
            }

            badge.textContent = 'Not enabled';
            badge.classList.add('disabled');
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
        } catch (error) {
            badge.textContent = 'Unavailable';
            badge.classList.add('disabled');
            message.textContent = error.message;
        }
    }

    actionButton(label, handler, extraClass = 'btn-secondary') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `btn ${extraClass}`;
        button.textContent = label;
        button.addEventListener('click', handler);
        return button;
    }

    showFlow(html) {
        const flow = document.getElementById('two-factor-flow');
        flow.innerHTML = html;
        flow.classList.remove('hidden');
        flow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return flow;
    }

    factorFields() {
        if (!this.status?.enabled) return '';
        return `
            <div class="form-group">
              <label for="account-factor-type">Current verification method</label>
              <select id="account-factor-type" class="form-input">
                <option value="totp">Authenticator code</option>
                <option value="recovery">Recovery code</option>
              </select>
            </div>
            <div class="form-group">
              <label for="account-factor">Current verification code</label>
              <input id="account-factor" class="form-input" type="text" inputmode="numeric" autocomplete="one-time-code" required>
            </div>`;
    }

    credentialPayload() {
        return {
            password: document.getElementById('account-password')?.value || '',
            credentialType: document.getElementById('account-factor-type')?.value || 'totp',
            credential: document.getElementById('account-factor')?.value || ''
        };
    }

    bindFactorType(container) {
        const type = container.querySelector('#account-factor-type');
        const credential = container.querySelector('#account-factor');
        if (!type || !credential) return;
        const update = () => {
            const recovery = type.value === 'recovery';
            credential.value = '';
            credential.inputMode = recovery ? 'text' : 'numeric';
            credential.placeholder = recovery ? 'XXXXXX-XXXXXX-XXXXXX-XXXXXX' : '000000';
        };
        type.addEventListener('change', update);
        update();
    }

    openEnrollment() {
        const flow = this.showFlow(`
            <h4>${this.status.enabled ? 'Replace authenticator app' : 'Verify your password'}</h4>
            <p class="hint">Sensitive account changes require your current password${this.status.enabled ? ' and current two-factor code' : ''}.</p>
            <form id="account-enroll-start-form" class="account-form">
              <div class="form-group">
                <label for="account-password">Current password</label>
                <input id="account-password" class="form-input" type="password" autocomplete="current-password" required>
              </div>
              ${this.factorFields()}
              <div class="account-flow-error" role="alert"></div>
              <div class="account-actions">
                <button type="button" class="btn btn-secondary" data-cancel>Cancel</button>
                <button type="submit" class="btn btn-primary">Continue</button>
              </div>
            </form>`);
        flow.querySelector('[data-cancel]').addEventListener('click', () => this.clearSensitiveView());
        this.bindFactorType(flow);
        flow.querySelector('form').addEventListener('submit', event => this.startEnrollment(event));
    }

    async startEnrollment(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const submit = form.querySelector('[type="submit"]');
        this.setBusy(submit, true);
        try {
            const enrollment = await API.twoFactor.enroll(this.credentialPayload());
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
              <div class="account-flow-error" role="alert"></div>
              <div class="account-actions">
                <button type="button" class="btn btn-secondary" data-cancel>Cancel</button>
                <button type="submit" class="btn btn-primary">Enable</button>
              </div>
            </form>`);
        flow.querySelector('#totp-qr-image').src = enrollment.qrDataUrl;
        flow.querySelector('#totp-manual-secret').textContent = enrollment.manualSecret;
        flow.querySelector('[data-cancel]').addEventListener('click', () => this.clearSensitiveView());
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
            this.showRecoveryCodes(result.recoveryCodes, 'Two-factor authentication is enabled');
        } catch (error) {
            this.showFlowError(form, error.message);
            this.setBusy(submit, false);
        }
    }

    openProtectedAction(action) {
        const isRecovery = action === 'recovery';
        const flow = this.showFlow(`
            <h4>${isRecovery ? 'Generate new recovery codes' : 'Disable two-factor authentication'}</h4>
            <p class="hint">Enter your password and current two-factor code to continue.</p>
            <form id="account-protected-action-form" class="account-form">
              <div class="form-group">
                <label for="account-password">Current password</label>
                <input id="account-password" class="form-input" type="password" autocomplete="current-password" required>
              </div>
              ${this.factorFields()}
              <div class="account-flow-error" role="alert"></div>
              <div class="account-actions">
                <button type="button" class="btn btn-secondary" data-cancel>Cancel</button>
                <button type="submit" class="btn ${isRecovery ? 'btn-primary' : 'btn-error'}">${isRecovery ? 'Generate codes' : 'Disable'}</button>
              </div>
            </form>`);
        flow.querySelector('[data-cancel]').addEventListener('click', () => this.clearSensitiveView());
        this.bindFactorType(flow);
        flow.querySelector('form').addEventListener('submit', event => this.submitProtectedAction(event, action));
    }

    async submitProtectedAction(event, action) {
        event.preventDefault();
        const form = event.currentTarget;
        const submit = form.querySelector('[type="submit"]');
        this.setBusy(submit, true);
        try {
            if (action === 'recovery') {
                const result = await API.twoFactor.regenerateRecoveryCodes(this.credentialPayload());
                this.showRecoveryCodes(result.recoveryCodes, 'New recovery codes generated');
            } else {
                await API.twoFactor.disable(this.credentialPayload());
                this.clearSensitiveView();
                await this.loadStatus();
            }
        } catch (error) {
            this.showFlowError(form, error.message);
            this.setBusy(submit, false);
        }
    }

    showRecoveryCodes(codes, heading) {
        this.recoveryCodes = [...codes];
        const flow = this.showFlow(`
            <h4>${heading}</h4>
            <div class="account-message warning">Save these recovery codes now. Each code works once, and they will not be shown again.</div>
            <pre id="account-recovery-codes" class="recovery-code-list"></pre>
            <div class="account-actions">
              <button type="button" class="btn btn-secondary" data-copy>Copy codes</button>
              <button type="button" class="btn btn-secondary" data-download>Download text file</button>
              <button type="button" class="btn btn-primary" data-finish>I have saved them</button>
            </div>`);
        flow.querySelector('#account-recovery-codes').textContent = codes.join('\n');
        flow.querySelector('[data-copy]').addEventListener('click', async event => {
            const copied = await this.copyText(this.recoveryCodes.join('\n'));
            event.currentTarget.textContent = copied ? 'Copied' : 'Select and copy the codes above';
        });
        flow.querySelector('[data-download]').addEventListener('click', () => this.downloadRecoveryCodes());
        flow.querySelector('[data-finish]').addEventListener('click', async () => {
            this.clearSensitiveView();
            await this.loadStatus();
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
