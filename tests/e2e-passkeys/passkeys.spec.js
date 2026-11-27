const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');

// Chromium's virtual WebAuthn authenticator stands in for Windows Hello,
// Touch ID or a phone, with automatic user presence and verification.
async function addVirtualAuthenticator(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true
        }
    });
    return { cdp, authenticatorId };
}

async function signOut(page) {
    // Let the application's logout action own navigation rather than racing
    // its redirect with a second, test-initiated visit to the login page.
    await page.locator('#account-menu-trigger').click();
    await page.locator('#logout-btn').click();
    await page.waitForURL(/\/nodecast\/login\.html(?:[?#].*)?$/);
}

async function openAccountSecurity(page) {
    await page.goto('./');
    await page.locator('#account-menu-trigger').click();
    await page.locator('#account-security-link').click();
    await expect(page.locator('#page-account')).toHaveClass(/active/);
}

test('passkeys can be added, used for sign-in and removed', async ({ page }) => {
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));

    const password = crypto.randomBytes(24).toString('base64url');
    const setup = await page.request.post('api/auth/setup', {
        data: { username: 'passkey-admin', password, passwordConfirmation: password }
    });
    expect(setup.status()).toBe(201);

    const { cdp, authenticatorId } = await addVirtualAuthenticator(page);

    // Enroll the first passkey; recovery codes are issued with the first factor.
    await openAccountSecurity(page);
    await expect(page.locator('#passkeys-status-badge')).toHaveText('None');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page.locator('#passkeys-flow')).toContainText('also requires a second step');
    await page.locator('#account-passkey-name').fill('Test laptop');
    await page.locator('#account-password').fill(password);
    await page.locator('#account-passkey-add-form').getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('#account-recovery-codes')).toBeVisible();
    await expect(page.locator('#account-recovery-codes')).toContainText('-');
    await page.getByRole('button', { name: 'I have saved them' }).click();
    await expect(page.locator('#passkeys-status-badge')).toHaveText('1 passkey');
    await expect(page.locator('.passkey-item')).toContainText('Test laptop');
    await expect(page.locator('.passkey-item')).toContainText('Not used yet');
    await expect(page.locator('#recovery-codes-card')).toBeVisible();
    await expect(page.locator('#recovery-codes-message')).toContainText('10 recovery codes remain');

    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    expect(credentials).toHaveLength(1);
    expect(credentials[0].isResidentCredential).toBe(true);
    expect(credentials[0].rpId).toBe('localhost');

    // Passwordless sign-in.
    await signOut(page);
    await expect(page.locator('#passkey-login-section')).toBeVisible();
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page).toHaveURL(/\/nodecast\/(?:#.*)?$/);
    await expect.poll(() => page.evaluate(() => window.app?.currentUser?.username)).toBe('passkey-admin');

    // From an address other than APP_ORIGIN the passkey cannot be verified, so
    // the second-factor step must not offer it, let alone default to it.
    await signOut(page);
    const { port } = new URL(page.url());
    await page.goto(`http://127.0.0.1:${port}/nodecast/login.html`);
    await page.locator('#username').fill('passkey-admin');
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page.locator('#two-factor-form')).toBeVisible();
    await expect(page.locator('#two-factor-code-panel')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use your passkey' })).toHaveCount(0);
    await expect(page.locator('#two-factor-alternatives')).not.toContainText('passkey');

    // The passkey as second factor after the password, at APP_ORIGIN.
    await page.goto('login.html');
    await page.locator('#username').fill('passkey-admin');
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page.locator('#two-factor-form')).toBeVisible();
    await expect(page.locator('#two-factor-alternatives')).toContainText('Use a recovery code');
    await expect(page.locator('#two-factor-code-panel')).toBeHidden();
    await page.getByRole('button', { name: 'Use your passkey' }).click();
    await expect(page).toHaveURL(/\/nodecast\/(?:#.*)?$/);
    await expect.poll(() => page.evaluate(() => window.app?.currentUser?.passkeyCount)).toBe(1);

    // The administrator's Reset 2FA verification offers the passkey only where
    // the server reports it usable for this page's origin.
    const resetMethods = async passkeyOrigin => page.evaluate(async origin => {
        const settings = window.app.pages.settings;
        const realList = API.passkeys.list;
        if (origin) API.passkeys.list = async () => ({ ...await realList(), origin });
        settings.users = [{ id: 999, username: 'reset-target', twoFactorEnabled: true }];
        try {
            await settings.openResetTwoFactorModal(999);
            return [...document.querySelectorAll('#reset-two-factor-factor-type option')].map(option => option.value);
        } finally {
            API.passkeys.list = realList;
            document.querySelector('#reset-two-factor-modal [data-close]')?.click();
        }
    }, passkeyOrigin);
    expect(await resetMethods(null)).toEqual(['passkey', 'recovery']);
    expect(await resetMethods('https://other.example')).toEqual(['recovery']);

    // Rename, then remove the last factor with the passkey as verification.
    await openAccountSecurity(page);
    await expect(page.locator('.passkey-item')).not.toContainText('Not used yet');
    await page.locator('.passkey-item').getByRole('button', { name: 'Rename' }).click();
    // A blank name passes the browser's required check but is rejected by the
    // server; the error must be shown and the form must stay usable.
    await page.locator('#account-passkey-new-name').fill('   ');
    await page.locator('#account-passkey-rename-form').getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#account-passkey-rename-form .account-flow-error')).toHaveText('Enter a name for the passkey.');
    await expect(page.locator('#account-passkey-rename-form').getByRole('button', { name: 'Save' })).toBeEnabled();
    await page.locator('#account-passkey-new-name').fill('Work laptop');
    await page.locator('#account-passkey-rename-form').getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.passkey-item')).toContainText('Work laptop');

    await page.locator('.passkey-item').getByRole('button', { name: 'Remove' }).click();
    await expect(page.locator('#passkeys-flow')).toContainText('signing in with only your password is possible again');
    await expect(page.locator('#account-factor-type')).toHaveValue('passkey');
    await expect(page.locator('#account-factor')).toBeHidden();
    await page.locator('#account-password').fill(password);
    await page.getByRole('button', { name: 'Remove passkey' }).click();
    await expect(page.locator('#passkeys-status-badge')).toHaveText('None');
    await expect(page.locator('#recovery-codes-card')).toBeHidden();

    await signOut(page);
    await page.locator('#username').fill('passkey-admin');
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page).toHaveURL(/\/nodecast\/(?:#.*)?$/);

    expect(browserErrors).toEqual([]);
});
