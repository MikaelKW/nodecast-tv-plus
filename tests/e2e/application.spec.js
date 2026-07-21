const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');
const OTPAuth = require('otpauth');

const fixtureBaseUrl = 'http://127.0.0.1:3211';

async function waitForSync(page, sourceId) {
    await expect.poll(async () => page.evaluate(async id => {
        const response = await fetch('/api/sources/status');
        if (!response.ok) return `http-${response.status}`;
        const statuses = await response.json();
        return statuses.find(status => status.source_id === id && status.type === 'all')?.status || 'pending';
    }, sourceId), { timeout: 30_000 }).toBe('success');
}

test('setup, source import, EPG, navigation, and playback work together', async ({ page }) => {
    test.setTimeout(120_000);
    const browserErrors = [];
    const qualityLogs = [];
    const qualitySessionSources = [];
    const subtitleRequests = [];
    let expectedRejectedResourceErrors = 0;
    let expectedAuthenticationErrors = 0;
    page.on('pageerror', error => browserErrors.push(`pageerror: ${error.message}`));
    page.on('console', message => {
        if (message.text().includes('[Player]') && /quality|restor/i.test(message.text())) {
            qualityLogs.push(message.text());
        }
        if (message.type() !== 'error') return;
        if (expectedRejectedResourceErrors > 0 && message.text().includes('Failed to load resource')) {
            expectedRejectedResourceErrors -= 1;
            return;
        }
        if (expectedAuthenticationErrors > 0 && message.text().includes('Failed to load resource')) {
            expectedAuthenticationErrors -= 1;
            return;
        }
        browserErrors.push(`console: ${message.text()}`);
    });
    page.on('request', request => {
        if (request.method() === 'GET' && request.url().includes('/api/subtitle?')) {
            subtitleRequests.push(request.url());
            return;
        }
        if (request.method() !== 'POST' || !request.url().endsWith('/api/transcode/session')) return;
        const sourceUrl = request.postDataJSON()?.url;
        if (!sourceUrl) return;
        const sourcePath = new URL(sourceUrl).pathname;
        qualitySessionSources.push(sourcePath);
        if (sourcePath === '/browser-only.mp4') expectedRejectedResourceErrors += 1;
    });

    const password = crypto.randomBytes(24).toString('base64url');
    await page.goto('/login.html');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'dark');
    await expect(page.locator('#setup-message')).toHaveClass(/show/);
    await expect(page.locator('#sso-login-section')).toBeHidden();
    await expect(page.locator('#confirm-password-group')).toBeVisible();
    await expect(page.locator('#confirm-password')).toBeEnabled();
    const setupPasswordToggle = page.locator('.password-visibility-toggle[aria-controls="password"]');
    await expect(setupPasswordToggle).toHaveAttribute('aria-label', 'Show password');
    await setupPasswordToggle.click();
    await expect(page.locator('#password')).toHaveAttribute('type', 'text');
    await expect(setupPasswordToggle).toHaveAttribute('aria-label', 'Hide password');
    await setupPasswordToggle.click();
    await expect(page.locator('#password')).toHaveAttribute('type', 'password');
    await expect(page.locator('.password-visibility-toggle[aria-controls="confirm-password"]')).toBeVisible();
    await page.locator('#username').fill('e2e-admin');
    await page.locator('#password').fill(password);
    await expect(page.locator('#confirm-password')).toBeVisible();
    await page.locator('#confirm-password').fill(`${password}-different`);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();
    await expect(page.locator('#error-message')).toHaveText('Passwords do not match');
    await expect(page).toHaveURL(/\/login\.html$/);
    await page.locator('#confirm-password').fill(password);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();
    await expect(page).toHaveURL(/\/#mfa-onboarding$/);
    await expect(page.getByText('NodeCast TV Plus', { exact: true }).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(
        window.app?.currentUser && window.app?.sourceManager && window.app?.channelList
    ))).toBe(true);
    await expect(page.locator('#page-mfa-onboarding')).toHaveClass(/active/);
    await expect(page.getByRole('heading', { name: 'Protect your account with MFA' })).toBeVisible();
    await expect(page.getByText('MFA is recommended but optional.')).toBeVisible();

    // An unfinished prompt survives refresh, but Continue replaces it in
    // history and opens the existing protected enrollment flow.
    await page.reload();
    await expect(page).toHaveURL(/\/#mfa-onboarding$/);
    await expect(page.locator('#page-mfa-onboarding')).toHaveClass(/active/);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page).toHaveURL(/\/#account$/);
    await expect(page.locator('#page-account')).toHaveClass(/active/);
    await expect(page.locator('#account-enroll-start-form')).toBeVisible();
    expect(await page.evaluate(() => NodeCastOnboarding.isMfaPending())).toBe(false);

    // Enroll through the same guided flow presented to local accounts, then
    // prove password sign-in stops at the server-side challenge until a fresh
    // authenticator code is supplied.
    await expect(page.locator('#account-menu-initial')).toHaveText('E');
    await expect(page.locator('#two-factor-status-badge')).toHaveText('Not enabled');
    await page.locator('#account-password').fill(password);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.locator('#totp-qr-image')).toBeVisible();
    const enrollmentSecret = await page.locator('#totp-manual-secret').textContent();
    const authenticator = new OTPAuth.TOTP({
        issuer: 'NodeCast TV Plus',
        label: 'e2e-admin',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(enrollmentSecret)
    });
    const initialAuthenticatorCode = authenticator.generate();
    const wrongAuthenticatorCode = `${initialAuthenticatorCode.slice(0, -1)}${(Number(initialAuthenticatorCode.at(-1)) + 1) % 10}`;
    await page.locator('#account-confirm-code').fill(wrongAuthenticatorCode);
    expectedAuthenticationErrors += 1;
    await page.getByRole('button', { name: 'Enable', exact: true }).click();
    await expect(page.locator('.account-flow-error')).toHaveText('Invalid authentication code.');
    await expect(page.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled();
    await page.locator('#account-confirm-code').fill(authenticator.generate());
    await page.getByRole('button', { name: 'Enable', exact: true }).click();
    await expect(page.locator('#account-recovery-codes')).toBeVisible();
    await expect(page.locator('#account-recovery-codes')).toContainText('-');
    await page.getByRole('button', { name: 'I have saved them' }).click();
    await expect(page.locator('#two-factor-status-badge')).toHaveText('Enabled');
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => /totp|factor|recovery/i.test(key)))).toEqual([]);
    await expect(page.locator('#totp-manual-secret')).toHaveCount(0);
    await expect(page.locator('#account-recovery-codes')).toHaveCount(0);

    await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
    await page.goto('/login.html');
    await expect(page.locator('#confirm-password-group')).toBeHidden();
    await expect(page.locator('#confirm-password')).toBeDisabled();
    await page.locator('#username').fill('e2e-admin');
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page.locator('#two-factor-form')).toBeVisible();
    await expect(page).toHaveURL(/\/login\.html$/);
    const nextAuthenticatorCode = authenticator.generate({ timestamp: Date.now() + 30_000 });
    await page.locator('#two-factor-code').fill(nextAuthenticatorCode);
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(page).toHaveURL(/\/(?:#home)?$/);
    await expect.poll(() => page.evaluate(() => window.app?.currentUser?.twoFactorEnabled)).toBe(true);
    await expect(page.locator('#page-mfa-onboarding')).not.toHaveClass(/active/);
    expect(await page.evaluate(() => NodeCastOnboarding.isMfaPending())).toBe(false);

    // An existing installation cannot reopen first-run onboarding by using
    // its internal hash directly.
    await page.goto('/?existing-installation-check=1#mfa-onboarding');
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#home');
    await expect(page.locator('#page-mfa-onboarding')).not.toHaveClass(/active/);

    await page.locator('.nav-link[data-page="settings"]').click();
    await expect(page.locator('#page-settings')).toHaveClass(/active/);
    await page.locator('#users-tab').click();
    await expect(page.locator('#tab-users')).toHaveClass(/active/);
    const newPassword = `${password}-viewer`;
    await page.locator('#new-username').fill('confirmed-viewer');
    await page.locator('#new-password').fill(newPassword);
    await page.locator('#new-password-confirmation').fill(`${newPassword}-different`);
    const newPasswordToggle = page.locator('.password-visibility-toggle[aria-controls="new-password"]');
    await newPasswordToggle.click();
    await expect(page.locator('#new-password')).toHaveAttribute('type', 'text');
    await expect(newPasswordToggle).toHaveAttribute('aria-label', 'Hide password');
    await page.getByRole('button', { name: 'Add User', exact: true }).click();
    await expect(page.locator('#new-password-error')).toBeVisible();
    await expect(page.locator('#new-password-error')).toHaveText('Passwords do not match.');
    await expect(page.locator('#user-list')).not.toContainText('confirmed-viewer');

    await page.locator('#new-password-confirmation').fill(newPassword);
    const createdDialog = page.waitForEvent('dialog');
    await page.getByRole('button', { name: 'Add User', exact: true }).click();
    const dialog = await createdDialog;
    expect(dialog.message()).toBe('User created successfully!');
    await dialog.accept();
    await expect(page.locator('#user-list')).toContainText('confirmed-viewer');
    await expect(page.locator('#new-password')).toHaveValue('');
    await expect(page.locator('#new-password-confirmation')).toHaveValue('');
    await expect(page.locator('#new-password')).toHaveAttribute('type', 'password');
    await expect(page.locator('#new-password-confirmation')).toHaveAttribute('type', 'password');
    await expect(newPasswordToggle).toHaveAttribute('aria-label', 'Show password');
    await expect(page.locator('.password-visibility-toggle[aria-controls="new-password-confirmation"]'))
        .toHaveAttribute('aria-label', 'Show password');

    await page.locator('.tab[data-tab="sources"]').click();
    await expect(page.locator('#tab-sources')).toHaveClass(/active/);
    await page.locator('#add-m3u').click();
    await page.locator('#source-name').fill('Controlled M3U');
    await page.locator('#source-url').fill(`${fixtureBaseUrl}/delayed-playlist.m3u`);
    await page.evaluate(() => {
        const addButton = document.getElementById('modal-save');
        addButton.click();
        addButton.click();
        addButton.click();
    });
    await expect(page.locator('#modal-save')).toBeDisabled();
    await expect(page.locator('#modal-save')).toContainText('Adding source');
    const m3uRow = page.locator('#m3u-list .source-item', { hasText: 'Controlled M3U' });
    await expect(m3uRow).toBeVisible();
    await expect(m3uRow.locator('.source-sync-status')).toContainText('Synchronizing source data');
    await expect(m3uRow.locator('.source-sync-status')).toHaveText('Initial sync completed', { timeout: 30_000 });

    const m3uSourceResult = await page.evaluate(async () => {
        const response = await fetch('/api/sources');
        const matches = (await response.json()).filter(source => source.name === 'Controlled M3U');
        return { count: matches.length, source: matches[0] };
    });
    expect(m3uSourceResult.count).toBe(1);
    expect(m3uSourceResult.source).toBeTruthy();
    const m3uSource = m3uSourceResult.source;
    await waitForSync(page, m3uSource.id);

    await page.locator('#add-epg').click();
    await page.locator('#source-name').fill('Controlled EPG');
    await page.locator('#source-url').fill(`${fixtureBaseUrl}/guide.xml`);
    await page.locator('#modal-save').click();
    const epgRow = page.locator('#epg-list .source-item', { hasText: 'Controlled EPG' });
    await expect(epgRow.locator('.source-sync-status')).toHaveText('Initial sync completed', { timeout: 30_000 });

    const epgSource = await page.evaluate(async () => {
        const response = await fetch('/api/sources');
        return (await response.json()).find(source => source.name === 'Controlled EPG');
    });
    expect(epgSource).toBeTruthy();
    await waitForSync(page, epgSource.id);

    const epg = await page.evaluate(async id => {
        const response = await fetch(`/api/proxy/epg/${id}`);
        return response.json();
    }, epgSource.id);
    expect(epg.programmes).toHaveLength(1);
    expect(epg.programmes[0].title).toBe('Controlled Test Programme');

    await page.locator('#add-epg').click();
    await page.locator('#source-name').fill('Recoverable Initial Sync');
    await page.locator('#source-url').fill(`${fixtureBaseUrl}/retry-guide.xml?access_token=sensitive-query-value`);
    await page.locator('#modal-save').click();
    const retryRow = page.locator('#epg-list .source-item', { hasText: 'Recoverable Initial Sync' });
    const retryStatus = retryRow.locator('.source-sync-status');
    await expect(retryStatus).toContainText('Initial sync failed', { timeout: 30_000 });
    await expect(retryStatus).not.toContainText('sensitive-query-value');
    await retryStatus.getByRole('button', { name: 'Retry' }).click();
    await expect(retryStatus).toHaveText('Initial sync completed', { timeout: 30_000 });

    const retrySource = await page.evaluate(async () => {
        const response = await fetch('/api/sources');
        return (await response.json()).find(source => source.name === 'Recoverable Initial Sync');
    });
    expect(retrySource).toBeTruthy();
    await page.evaluate(async id => {
        const response = await fetch(`/api/sources/${id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(`Retry source cleanup failed: ${response.status}`);
        window.app.sourceManager.initialSyncStates.delete(id);
        await window.app.sourceManager.loadSources();
    }, retrySource.id);

    // XMLTV allows reduced timestamp precision. Valid minute-precision entries
    // must sync, while malformed entries are skipped without aborting the source.
    const reducedPrecisionSource = await page.evaluate(async url => {
        const response = await fetch('/api/sources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'epg', name: 'Reduced Precision EPG', url })
        });
        if (!response.ok) throw new Error(`Reduced-precision EPG source creation failed: ${response.status}`);
        return response.json();
    }, `${fixtureBaseUrl}/reduced-precision-guide.xml`);
    await waitForSync(page, reducedPrecisionSource.id);

    const reducedPrecisionEpg = await page.evaluate(async id => {
        const response = await fetch(`/api/proxy/epg/${id}`);
        return response.json();
    }, reducedPrecisionSource.id);
    expect(reducedPrecisionEpg.programmes).toHaveLength(2);
    expect(reducedPrecisionEpg.programmes.map(programme => programme.title)).toEqual([
        'Full precision start',
        'Minute precision'
    ]);
    expect(reducedPrecisionEpg.programmes.every(programme => (
        Number.isFinite(Date.parse(programme.start)) && Number.isFinite(Date.parse(programme.stop))
    ))).toBe(true);

    await page.evaluate(async id => {
        const response = await fetch(`/api/sources/${id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(`Reduced-precision EPG cleanup failed: ${response.status}`);
    }, reducedPrecisionSource.id);

    const seriesCredentials = {
        username: crypto.randomBytes(18).toString('base64url'),
        password: crypto.randomBytes(24).toString('base64url')
    };
    await page.locator('#add-xtream').click();
    await page.locator('#source-name').fill('Controlled Safari Series');
    await page.locator('#source-url').fill(`${fixtureBaseUrl}/xtream`);
    await page.locator('#source-username').fill(seriesCredentials.username);
    await page.locator('#source-password').fill(seriesCredentials.password);
    await page.locator('#modal-save').click();
    const seriesSourceRow = page.locator('#xtream-list .source-item', { hasText: 'Controlled Safari Series' });
    await expect(seriesSourceRow.locator('.source-sync-status')).toHaveText('Initial sync completed', { timeout: 30_000 });

    const seriesSource = await page.evaluate(async () => {
        const response = await fetch('/api/sources');
        return (await response.json()).find(source => source.name === 'Controlled Safari Series');
    });
    expect(seriesSource).toBeTruthy();
    expect(seriesSource.contentVisibility).toEqual({ live: true, movies: true, series: true });
    await waitForSync(page, seriesSource.id);

    // Source-level visibility is independent for Live TV, Movies, and Series.
    // Existing and newly created sources default to visible everywhere.
    await seriesSourceRow.locator('[data-action="edit"]').click();
    await expect(page.locator('#source-visible-live')).toBeChecked();
    await expect(page.locator('#source-visible-movies')).toBeChecked();
    await expect(page.locator('#source-visible-series')).toBeChecked();
    await page.locator('#source-visible-live').uncheck();
    await page.locator('#source-visible-movies').uncheck();
    await page.locator('#modal-save').click();
    await expect(seriesSourceRow.locator('.source-visibility-summary')).toHaveText('Shown in: Series');

    const restrictedVisibility = await page.evaluate(async id => {
        const response = await fetch(`/api/sources/${id}`);
        return (await response.json()).contentVisibility;
    }, seriesSource.id);
    expect(restrictedVisibility).toEqual({ live: false, movies: false, series: true });

    await page.evaluate(() => window.app.navigateTo('live'));
    await expect(page.locator('#source-select')).not.toContainText('Controlled Safari Series');
    await expect(page.locator('.channel-name', { hasText: 'Controlled Visibility Channel' })).toHaveCount(0);

    await page.evaluate(() => window.app.navigateTo('movies'));
    await expect(page.locator('#movies-source-select')).not.toContainText('Controlled Safari Series');
    await expect(page.locator('.movie-card', { hasText: 'Controlled Visibility Movie' })).toHaveCount(0);

    await page.evaluate(() => window.app.navigateTo('series'));
    await expect(page.locator('#page-series')).toHaveClass(/active/);
    await expect(page.locator('#series-source-select')).toContainText('Controlled Safari Series');
    const controlledSeries = page.locator('.series-card', { hasText: 'Controlled Safari Series' });
    await expect(controlledSeries).toBeVisible();
    await controlledSeries.click();

    const seriesDetails = page.locator('#series-details');
    await expect(seriesDetails).toBeVisible();
    await expect(seriesDetails).toHaveAttribute('aria-hidden', 'false');
    await expect(page.locator('#series-title')).toHaveText('Controlled Safari Series');
    await expect(page.locator('#series-plot')).toContainText('Safari layout testing');
    await expect(page.locator('.season-name')).toHaveText('Season 1 (2 episodes)');
    await expect(page.locator('.episode-item')).toHaveCount(2);

    // Real iOS Safari can fail to lay out an absolutely positioned child of
    // this flex container. Keep the details view in normal flow with a real,
    // scrollable height so tapping a card cannot leave a blank content area.
    const seriesLayout = await seriesDetails.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return {
            position: getComputedStyle(element).position,
            height: rect.height,
            scrollTop: element.scrollTop,
            gridHidden: document.getElementById('series-grid').classList.contains('hidden')
        };
    });
    expect(seriesLayout.position).toBe('relative');
    expect(seriesLayout.height).toBeGreaterThan(0);
    expect(seriesLayout.scrollTop).toBe(0);
    expect(seriesLayout.gridHidden).toBe(true);

    await page.locator('.series-back-btn').click();
    await expect(controlledSeries).toBeVisible();
    await expect(seriesDetails).toBeHidden();

    // Invert the choices to prove Series can be hidden independently while
    // the same source remains available in Live TV and Movies.
    await page.locator('.nav-link[data-page="settings"]').click();
    await page.locator('.tab[data-tab="interface"]').click();
    await expect(page.locator('#tab-interface')).toHaveClass(/active/);

    // Appearance is browser-scoped, applies immediately, and is initialized
    // before the stylesheet on both the app and sign-in pages.
    await expect(page.locator('input[name="theme-preference"][value="dark"]')).toBeChecked();
    await page.locator('input[name="theme-preference"][value="light"]').check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('#theme-settings-status')).toContainText('Light is active. Saved in this browser.');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(247, 247, 251)');
    const lightLogoStyle = await page.evaluate(() => {
        const logo = document.createElement('img');
        logo.className = 'channel-logo';
        document.body.appendChild(logo);
        const style = getComputedStyle(logo);
        const result = { backgroundColor: style.backgroundColor, filter: style.filter };
        logo.remove();
        return result;
    });
    expect(lightLogoStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(lightLogoStyle.filter).not.toBe('none');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.goto('/login.html');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.goto('/#settings');
    await expect(page.locator('#page-settings')).toHaveClass(/active/);
    await page.locator('.tab[data-tab="interface"]').click();

    await page.emulateMedia({ colorScheme: 'light' });
    await page.locator('input[name="theme-preference"][value="system"]').check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => {
        const logo = document.createElement('img');
        logo.className = 'channel-logo';
        document.body.appendChild(logo);
        const filter = getComputedStyle(logo).filter;
        logo.remove();
        return filter;
    })).toBe('none');
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
    await expect(page.locator('#theme-settings-status')).toContainText('System is active and currently using dark.');
    await page.locator('input[name="theme-preference"][value="dark"]').check();

    // The server repairs an invalid request so viewers can never be left with
    // no accessible primary page.
    const repairedNavigation = await page.evaluate(async () => {
        const settings = await window.API.settings.update({
            navigation: {
                landingPage: 'series',
                visibleTabs: {
                    home: false,
                    live: false,
                    guide: false,
                    movies: false,
                    series: false
                }
            }
        });
        await window.API.settings.update({
            navigation: {
                landingPage: 'home',
                visibleTabs: {
                    home: true,
                    live: true,
                    guide: true,
                    movies: true,
                    series: true
                }
            }
        });
        return settings.navigation;
    });
    expect(repairedNavigation.landingPage).toBe('home');
    expect(repairedNavigation.visibleTabs.home).toBe(true);

    await page.locator('[data-navigation-page="home"]').uncheck();
    await page.locator('[data-navigation-page="guide"]').uncheck();
    await page.locator('[data-navigation-page="movies"]').uncheck();
    await page.locator('[data-navigation-page="series"]').uncheck();
    await page.locator('[data-navigation-page="live"]').click();
    await expect(page.locator('[data-navigation-page="live"]')).toBeChecked();
    await expect(page.locator('#interface-settings-status')).toHaveText('Keep at least one main navigation page visible.');
    await page.locator('#setting-landing-page').selectOption('live');
    await page.getByRole('button', { name: 'Save interface settings' }).click();
    await expect(page.locator('#interface-settings-status')).toHaveText('Interface settings saved.');
    await expect(page.locator('.nav-link[data-page="home"]')).toBeHidden();
    await expect(page.locator('.nav-link[data-page="movies"]')).toBeHidden();
    await expect(page.locator('.nav-link[data-page="settings"]')).toBeVisible();

    await page.evaluate(() => window.app.navigateTo('movies'));
    await expect(page).toHaveURL(/#live$/);
    await expect(page.locator('#page-live')).toHaveClass(/active/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/#live$/);
    await expect(page.locator('#page-live')).toHaveClass(/active/);

    // Restore the default navigation so the remainder of this broad workflow
    // continues to exercise every destination.
    await page.locator('.nav-link[data-page="settings"]').click();
    await page.locator('.tab[data-tab="interface"]').click();
    for (const pageName of ['home', 'guide', 'movies', 'series']) {
        await page.locator(`[data-navigation-page="${pageName}"]`).check();
    }
    await page.locator('#setting-landing-page').selectOption('home');
    await page.getByRole('button', { name: 'Save interface settings' }).click();
    await expect(page.locator('.nav-link[data-page="home"]')).toBeVisible();

    await page.locator('.tab[data-tab="sources"]').click();
    await seriesSourceRow.locator('[data-action="edit"]').click();
    await page.locator('#source-visible-live').check();
    await page.locator('#source-visible-movies').check();
    await page.locator('#source-visible-series').uncheck();
    await page.locator('#modal-save').click();
    await expect(seriesSourceRow.locator('.source-visibility-summary')).toHaveText('Shown in: Live TV, Movies');

    await page.evaluate(() => window.app.navigateTo('movies'));
    await expect(page.locator('#movies-source-select')).toContainText('Controlled Safari Series');
    await expect(page.locator('.movie-card', { hasText: 'Controlled Visibility Movie' })).toBeVisible();
    await page.evaluate(() => window.app.navigateTo('series'));
    await expect(page.locator('#series-source-select')).not.toContainText('Controlled Safari Series');
    await expect(page.locator('.series-card', { hasText: 'Controlled Safari Series' })).toHaveCount(0);

    // Hiding a source leaves its synchronized data intact. Keep the controlled
    // Live source hidden for the remaining fixed-geometry channel scenarios.
    const retainedLiveStreams = await page.evaluate(async id => API.proxy.xtream.liveStreams(id), seriesSource.id);
    expect(retainedLiveStreams.map(stream => stream.name)).toContain('Controlled Visibility Channel');
    await page.evaluate(async id => {
        await API.sources.update(id, { contentVisibility: { live: false, movies: true, series: false } });
        await window.app.channelList.loadSources();
        await window.app.channelList.loadChannels();
    }, seriesSource.id);

    await page.locator('.nav-link[data-page="live"]').click();
    await expect(page.locator('#page-live')).toHaveClass(/active/);
    await page.locator('.group-header', { hasText: 'Local Test' }).click();
    await expect(page.locator('.channel-name', { hasText: 'NodeCast Test Pattern' })).toBeVisible();
    await page.locator('.channel-item', { hasText: 'NodeCast Test Pattern' }).click();

    const video = page.locator('#video-player');
    await expect.poll(async () => video.evaluate(element => element.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => video.evaluate(element => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await video.evaluate(element => element.paused)).toBe(false);
    await expect(page.locator('.channel-item.active .channel-name')).toContainText('NodeCast Test Pattern');

    // Selecting a visible channel must preserve both the expanded groups and
    // the sidebar position instead of applying the former focus-mode reset.
    const secondaryGroup = page.locator('.group-header', { hasText: 'Secondary Test' });
    await secondaryGroup.click();
    await expect(secondaryGroup).not.toHaveClass(/collapsed/);
    const primaryGroup = page.locator('.group-header', { hasText: 'Local Test' });
    await expect(primaryGroup).not.toHaveClass(/collapsed/);
    const backupChannel = page.locator('.channel-item', { hasText: 'NodeCast Test Backup' });
    const scrollBeforeSelection = await page.locator('#channel-list').evaluate(element => {
        element.style.height = '90px';
        element.style.flex = 'none';
        element.scrollTop = element.scrollHeight;
        return element.scrollTop;
    });
    expect(scrollBeforeSelection).toBeGreaterThan(0);
    await backupChannel.click();
    await expect(primaryGroup).not.toHaveClass(/collapsed/);
    await expect(secondaryGroup).not.toHaveClass(/collapsed/);
    await page.waitForTimeout(100);
    expect(await page.locator('#channel-list').evaluate(element => element.scrollTop)).toBe(scrollBeforeSelection);
    await page.locator('#channel-list').evaluate(element => {
        element.style.height = '';
        element.style.flex = '';
    });

    // A fixed-resolution source should restart through the local FFmpeg session
    // when the user applies a lower session-only quality cap.
    await expect.poll(() => page.evaluate(() => (
        window.app?.player?.qualityBtn === document.getElementById('player-quality-btn')
    ))).toBe(true);
    await video.hover();
    await expect(page.locator('#player-quality-btn')).toBeVisible();
    await page.locator('#player-quality-btn').click();
    await expect(page.locator('#player-quality-btn')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#player-quality-menu')).toBeVisible();
    await page.locator('#player-quality-menu [data-quality="480p"]').click();
    await expect(page.locator('#player-quality-btn')).toHaveText('480p');
    await expect(page.locator('#player-transcode-status')).toContainText('Up to 480p');
    await expect.poll(() => page.evaluate(() => Boolean(window.app?.player?.currentSessionId)), {
        timeout: 30_000
    }).toBe(true);
    await expect.poll(async () => video.evaluate(element => element.videoHeight), {
        timeout: 30_000
    }).toBe(480);
    await expect(page.locator('#player-quality-badge')).toHaveText('480p');

    // Returning to Auto stops the temporary session and restores the provider's
    // original stream without changing the saved global transcoding setting.
    await video.hover();
    await page.locator('#player-quality-btn').click();
    await page.locator('#player-quality-menu [data-quality="auto"]').click();
    await expect(page.locator('#player-quality-btn')).toHaveText('Auto');
    await expect.poll(() => page.evaluate(() => window.app?.player?.currentSessionId || null), {
        timeout: 30_000
    }).toBeNull();
    await expect.poll(async () => video.evaluate(element => element.readyState), {
        timeout: 30_000
    }).toBeGreaterThanOrEqual(2);
    // A browser-only provider must not leave the player stuck when FFmpeg is
    // rejected. The previous direct stream and Auto selection are restored.
    await page.evaluate(async url => {
        window.app.player.settings.autoTranscode = false;
        await window.app.player.play({ name: 'Browser-only provider' }, url);
    }, `${fixtureBaseUrl}/browser-only.mp4`);
    expect(await page.evaluate(() => window.app.player.settings.maxResolution)).toBe('1080p');
    expect(await page.evaluate(() => window.app.player.playbackQuality)).toBe('auto');
    await expect.poll(async () => video.evaluate(element => element.readyState), {
        timeout: 30_000
    }).toBeGreaterThanOrEqual(2);
    await page.evaluate(() => { window.app.player.settings.forceVideoTranscode = true; });
    await video.hover();
    await page.locator('#player-quality-btn').click();
    await page.locator('#player-quality-menu [data-quality="480p"]').click();
    await expect.poll(() => page.locator('#player-quality-btn').textContent(), {
        timeout: 30_000
    }).toBe('Auto');
    await expect.poll(() => page.evaluate(() => window.app?.player?.currentSessionId || null), {
        timeout: 30_000
    }).toBeNull();
    await expect.poll(async () => video.evaluate(element => element.readyState), {
        timeout: 30_000
    }).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#player-transcode-status')).toContainText('480p unavailable');

    // A cap above the source is a direct-play no-op. If a later lower cap is
    // rejected, recovery must restore that direct stream rather than attempt
    // to transcode to the previous cap.
    await page.locator('#player-quality-btn').click();
    await page.locator('#player-quality-menu [data-quality="4k"]').click();
    await expect(page.locator('#player-quality-btn')).toHaveText('4K');
    await expect(page.locator('#player-transcode-status')).toHaveText('Direct Play');
    await page.locator('#player-quality-btn').click();
    await page.locator('#player-quality-menu [data-quality="480p"]').click();
    await expect.poll(() => page.locator('#player-quality-btn').textContent(), {
        timeout: 30_000
    }).toBe('4K');
    await expect.poll(async () => video.evaluate(element => element.readyState), {
        timeout: 30_000
    }).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#player-transcode-status')).toContainText('Restored Up to 4K');
    await expect(page.locator('#player-overlay')).toHaveClass(/hidden/);
    await page.locator('#video-container').dispatchEvent('mousemove');
    await page.locator('#player-quality-btn').click();
    await page.locator('#player-quality-menu [data-quality="auto"]').click();
    await expect(page.locator('#player-quality-btn')).toHaveText('Auto');
    await expect(page.locator('#player-transcode-status')).toHaveText('Direct Play');
    await expect(page.locator('#player-overlay')).toHaveClass(/hidden/);
    expect(
        qualitySessionSources.filter(path => path === '/browser-only.mp4'),
        qualityLogs.join('\n')
    ).toHaveLength(2);
    await page.evaluate(() => {
        window.app.player.settings.autoTranscode = true;
        window.app.player.settings.forceVideoTranscode = false;
    });

    // A provider that rejects the global cap must continue at its original
    // resolution and clearly explain that the configured limit is best-effort.
    await page.evaluate(async url => {
        await window.API.settings.update({ maxResolution: '480p' });
        window.app.player.settings.maxResolution = '480p';
        await window.app.player.play({ name: 'Rejected global quality cap' }, url);
    }, `${fixtureBaseUrl}/browser-only.mp4`);
    await expect.poll(async () => video.evaluate(element => element.readyState), {
        timeout: 30_000
    }).toBeGreaterThanOrEqual(2);
    await expect.poll(() => page.evaluate(() => window.app?.player?.currentSessionId || null), {
        timeout: 30_000
    }).toBeNull();
    await expect(page.locator('#player-transcode-status')).toContainText(
        '480p limit unavailable · Playing original at 720p'
    );

    // Auto now honors the global max-resolution setting even for a compatible
    // source that would otherwise use direct playback.
    await page.evaluate(async url => {
        await window.API.settings.update({ maxResolution: '480p' });
        window.app.player.settings.maxResolution = '480p';
        await window.app.player.play({ name: 'Global quality cap' }, url);
    }, `${fixtureBaseUrl}/sample.mp4`);
    await expect(page.locator('#player-quality-btn')).toHaveText('Auto');
    await expect.poll(async () => Boolean(await page.evaluate(() => window.app?.player?.currentSessionId)), {
        timeout: 30_000
    }).toBe(true);
    await expect.poll(async () => video.evaluate(element => element.videoHeight), {
        timeout: 30_000
    }).toBe(480);
    expect(qualitySessionSources.at(-1)).toBe('/sample.mp4');
    await page.evaluate(async () => {
        await window.API.settings.update({ maxResolution: '1080p' });
        window.app.player.settings.maxResolution = '1080p';
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await video.hover();
    const mobileQualityBounds = await page.locator('#player-quality-btn').boundingBox();
    expect(mobileQualityBounds).toBeTruthy();
    expect(mobileQualityBounds.x).toBeGreaterThanOrEqual(0);
    expect(mobileQualityBounds.x + mobileQualityBounds.width).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1280, height: 720 });

    // Exercise the separate movie/series player and verify that a quality
    // restart preserves the current playback position.
    await page.evaluate(async ({ url, sourceId }) => {
        await window.app.pages.watch.play({
            id: 'controlled-movie',
            type: 'movie',
            title: 'Controlled Movie',
            sourceId,
            categoryId: 'controlled'
        }, url);
    }, { url: `${fixtureBaseUrl}/sample.mp4`, sourceId: m3uSource.id });
    const watchVideo = page.locator('#watch-video');
    await expect.poll(async () => watchVideo.evaluate(element => element.readyState), {
        timeout: 30_000
    }).toBeGreaterThanOrEqual(2);
    expect(subtitleRequests).toHaveLength(0);
    await watchVideo.evaluate(element => { element.currentTime = 2; });
    await page.locator('.watch-video-section').hover();
    await page.locator('#watch-quality-btn').click();
    await page.locator('#watch-quality-menu [data-quality="480p"]').click();
    await expect(page.locator('#watch-quality-btn')).toHaveText('480p');
    await expect.poll(() => page.evaluate(() => Boolean(window.app?.pages?.watch?.currentSessionId)), {
        timeout: 30_000
    }).toBe(true);
    await expect.poll(async () => watchVideo.evaluate(element => element.currentTime), {
        timeout: 30_000
    }).toBeGreaterThanOrEqual(1.5);
    await expect.poll(async () => watchVideo.evaluate(element => element.videoHeight), {
        timeout: 30_000
    }).toBe(480);
    await page.locator('.watch-video-section').hover();
    await page.locator('#watch-quality-btn').click();
    await page.locator('#watch-quality-menu [data-quality="auto"]').click();
    await expect.poll(() => page.evaluate(() => window.app?.pages?.watch?.currentSessionId || null), {
        timeout: 30_000
    }).toBeNull();

    // Embedded movie tracks are discovered from the original container. Audio
    // switches restart only the playback session at the current position, while
    // subtitle choices use authenticated WebVTT extraction.
    await page.evaluate(async () => {
        await window.API.settings.update({ autoTranscode: true, maxResolution: '1080p' });
    });
    await page.evaluate(async ({ url, sourceId }) => {
        await window.app.pages.watch.play({
            id: 'controlled-multi-track-movie',
            type: 'movie',
            title: 'Controlled Multi-track Movie',
            sourceId,
            categoryId: 'controlled'
        }, url);
    }, { url: `${fixtureBaseUrl}/multi-track.mkv`, sourceId: m3uSource.id });
    await expect.poll(() => page.evaluate(() => Boolean(window.app?.pages?.watch?.currentSessionId)), {
        timeout: 30_000
    }).toBe(true);
    await expect.poll(async () => watchVideo.evaluate(element => element.readyState), {
        timeout: 30_000
    }).toBeGreaterThanOrEqual(2);
    await page.setViewportSize({ width: 1180, height: 720 });
    const playbackNavbarLayout = await page.locator('.navbar').evaluate(element => ({
        height: element.getBoundingClientRect().height,
        scrollHeight: element.scrollHeight,
        nowPlayingWidth: document.getElementById('now-playing-indicator')?.getBoundingClientRect().width || 0,
        labelsHidden: Array.from(document.querySelectorAll('.navbar-menu .nav-link span:not(.nav-icon)'))
            .every(label => getComputedStyle(label).display === 'none')
    }));
    expect(playbackNavbarLayout.height).toBeLessThanOrEqual(60);
    expect(playbackNavbarLayout.scrollHeight).toBeLessThanOrEqual(60);
    expect(playbackNavbarLayout.nowPlayingWidth).toBeGreaterThan(0);
    expect(playbackNavbarLayout.labelsHidden).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.locator('.watch-video-section').hover();
    await page.locator('#watch-captions-btn').click();
    await expect(page.locator('#watch-audio-list .captions-option')).toHaveCount(2);
    await expect(page.locator('#watch-audio-list')).toContainText('English 440 Hz');
    await expect(page.locator('#watch-audio-list')).toContainText('Norwegian 880 Hz');
    await expect(page.locator('#watch-captions-list')).toContainText('English');
    await expect(page.locator('#watch-captions-list')).toContainText('Norwegian');
    expect(subtitleRequests).toHaveLength(0);

    await watchVideo.evaluate(element => { element.currentTime = 5; });
    const contentPositionBeforeAudioSwitch = await page.evaluate(() => (
        window.app.pages.watch.getCurrentPlaybackTime()
    ));
    const defaultAudioSession = await page.evaluate(() => window.app.pages.watch.currentSessionId);
    await page.locator('#watch-audio-list .captions-option', { hasText: 'Norwegian 880 Hz' }).click();
    await expect.poll(() => page.evaluate(() => window.app.pages.watch.currentSessionId), {
        timeout: 30_000
    }).not.toBe(defaultAudioSession);
    await expect.poll(() => page.evaluate(() => {
        const watch = window.app.pages.watch;
        const selected = watch.availableAudioTracks.find(track => track.index === watch.selectedAudioTrackIndex);
        return selected?.title || '';
    }), { timeout: 30_000 }).toBe('Norwegian 880 Hz');
    await expect.poll(async () => watchVideo.evaluate(element => element.currentTime), {
        timeout: 30_000
    }).toBeGreaterThanOrEqual(1.5);
    const resumedAudioClock = await page.evaluate(() => {
        const watch = window.app.pages.watch;
        const contentTime = watch.getCurrentPlaybackTime();
        return {
            offset: watch.playbackTimeOffset,
            contentTime,
            displayedTime: document.getElementById('watch-time-current')?.textContent,
            allowedDisplayedTimes: [
                watch.formatTime(contentTime),
                watch.formatTime(Math.max(0, contentTime - 1))
            ]
        };
    });
    expect(resumedAudioClock.offset).toBeGreaterThanOrEqual(contentPositionBeforeAudioSwitch - 0.5);
    expect(resumedAudioClock.contentTime).toBeGreaterThan(contentPositionBeforeAudioSwitch);
    expect(resumedAudioClock.allowedDisplayedTimes).toContain(resumedAudioClock.displayedTime);

    await page.locator('.watch-video-section').hover();
    await page.locator('#watch-captions-btn').click();
    await page.locator('#watch-captions-list .captions-option', { hasText: 'English' }).click();
    await expect.poll(() => subtitleRequests.length, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => page.evaluate(() => window.app.pages.watch.selectedSubtitleStreamIndex), {
        timeout: 10_000
    }).not.toBeNull();

    // A growing transcode playlist must not redefine the full VOD duration.
    // Seeking behind a session offset starts a replacement session at the
    // requested source position instead of clamping to the current window.
    const durationState = await page.evaluate(() => {
        const watch = window.app.pages.watch;
        return {
            sourceDuration: watch.sourceDuration,
            playbackDuration: watch.getPlaybackDuration(),
            generatedDuration: watch.video.duration
        };
    });
    expect(durationState.sourceDuration).toBeGreaterThan(19);
    expect(durationState.sourceDuration).toBeLessThan(21);
    expect(durationState.playbackDuration).toBeCloseTo(durationState.sourceDuration, 3);
    const offsetAudioSession = await page.evaluate(() => window.app.pages.watch.currentSessionId);
    await page.evaluate(() => window.app.pages.watch.seek(0));
    await expect.poll(() => page.evaluate(() => window.app.pages.watch.currentSessionId), {
        timeout: 30_000
    }).not.toBe(offsetAudioSession);
    await expect.poll(() => page.evaluate(() => window.app.pages.watch.playbackTimeOffset), {
        timeout: 30_000
    }).toBe(0);
    await expect.poll(async () => watchVideo.evaluate(element => element.readyState), {
        timeout: 30_000
    }).toBeGreaterThanOrEqual(2);
    await expect.poll(async () => watchVideo.evaluate(element => Array.from(element.textTracks).some(track => (
        track.mode === 'showing' && Array.from(track.cues || []).some(cue => cue.text.includes('English controlled subtitle'))
    ))), { timeout: 30_000 }).toBe(true);
    expect(subtitleRequests).toHaveLength(2);
    await watchVideo.evaluate(element => { element.currentTime = 2; });
    await expect.poll(() => watchVideo.evaluate(element => Array.from(element.textTracks).some(track => (
        track.mode === 'showing' && Array.from(track.activeCues || []).some(cue => cue.text.includes('English controlled subtitle'))
    ))), { timeout: 10_000 }).toBe(true);

    await page.locator('.watch-video-section').hover();
    await page.locator('#watch-captions-btn').click();
    await page.locator('#watch-captions-list .captions-option', { hasText: 'Norwegian' }).click();
    await expect.poll(() => subtitleRequests.length, { timeout: 10_000 }).toBe(3);
    await expect.poll(() => watchVideo.evaluate(element => Array.from(element.textTracks).some(track => (
        track.mode === 'showing' && Array.from(track.cues || []).some(cue => cue.text.includes('Norsk kontrollert undertekst'))
    ))), { timeout: 30_000 }).toBe(true);

    // The movie/series player uses the same transactional fallback when a
    // provider permits browser playback but rejects FFmpeg.
    await page.evaluate(async () => {
        await window.API.settings.update({ maxResolution: '480p' });
    });
    await page.evaluate(async ({ url, sourceId }) => {
        const watch = window.app.pages.watch;
        watch.stop();
        watch.content = {
            id: 'browser-only-movie',
            type: 'movie',
            title: 'Browser-only Movie',
            sourceId,
            categoryId: 'controlled'
        };
        watch.contentType = 'movie';
        watch.sourceUrl = url;
        watch.currentUrl = url;
        watch.playbackQuality = 'auto';
        watch.resumeTime = 0;
        watch.updateQualityMenu();
        window.app.navigateTo('watch', true);
        await watch.loadVideo(url);
    }, { url: `${fixtureBaseUrl}/browser-only.mp4`, sourceId: m3uSource.id });
    await expect.poll(async () => watchVideo.evaluate(element => element.readyState), {
        timeout: 30_000
    }).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#watch-transcode-status')).toContainText(
        '480p limit unavailable · Playing original at 720p'
    );
    await page.evaluate(async () => {
        await window.API.settings.update({ maxResolution: '1080p' });
        window.app.pages.watch.settings.maxResolution = '1080p';
    });
    await watchVideo.evaluate(element => { element.currentTime = 2; });
    await page.locator('.watch-video-section').hover();
    await page.locator('#watch-quality-btn').click();
    await page.locator('#watch-quality-menu [data-quality="480p"]').click();
    await expect.poll(() => page.locator('#watch-quality-btn').textContent(), {
        timeout: 30_000
    }).toBe('Auto');
    await expect.poll(() => page.evaluate(() => window.app?.pages?.watch?.currentSessionId || null), {
        timeout: 30_000
    }).toBeNull();
    await expect.poll(async () => watchVideo.evaluate(element => element.currentTime), {
        timeout: 30_000
    }).toBeGreaterThanOrEqual(1.5);
    await expect(page.locator('#watch-transcode-status')).toContainText('480p unavailable');
    expect(qualitySessionSources.filter(path => path === '/browser-only.mp4')).toHaveLength(3);

    // A transient HLS segment outage after playback begins must reconnect
    // instead of leaving the movie/series player black and silent.
    expectedRejectedResourceErrors += 4;
    await page.evaluate(async ({ url, sourceId }) => {
        await window.API.settings.update({ autoTranscode: false, maxResolution: '1080p' });
        const watch = window.app.pages.watch;
        watch.stop();
        watch.content = {
            id: 'recoverable-hls-movie',
            type: 'movie',
            title: 'Recoverable HLS Movie',
            sourceId,
            categoryId: 'controlled'
        };
        watch.contentType = 'movie';
        watch.sourceUrl = url;
        watch.currentUrl = url;
        watch.playbackQuality = 'auto';
        watch.resumeTime = 0;
        window.app.navigateTo('watch', true);
        await watch.loadVideo(url);
    }, { url: `${fixtureBaseUrl}/recoverable-hls/playlist.m3u8`, sourceId: m3uSource.id });
    await expect.poll(async () => watchVideo.evaluate(element => element.currentTime), {
        timeout: 30_000
    }).toBeGreaterThan(5);
    expect(await watchVideo.evaluate(element => element.paused)).toBe(false);
    const recoverableStats = await (await fetch(`${fixtureBaseUrl}/recoverable-hls/stats`)).json();
    expect(recoverableStats.failedRequests).toBe(4);
    expect(recoverableStats.segmentRequests).toBeGreaterThan(4);
    expect(await page.evaluate(() => window.app.pages.watch.hlsRecoveryCount)).toBe(0);
    // Chromium may coalesce identical failed-resource console messages. The
    // fixture counters above are the authoritative outage assertion.
    expectedRejectedResourceErrors = 0;

    const reset = await fetch(`${fixtureBaseUrl}/connection-stats/reset`, { method: 'POST' });
    expect(reset.status).toBe(204);

    await page.evaluate(async url => {
        const firstPlay = window.app.player.play({ name: 'First test channel' }, url);
        await new Promise(resolve => setTimeout(resolve, 100));
        const secondPlay = window.app.player.play({ name: 'Second test channel' }, url);
        await Promise.allSettled([firstPlay, secondPlay]);
    }, `${fixtureBaseUrl}/slow-sample.mp4`);

    await expect.poll(async () => {
        const response = await fetch(`${fixtureBaseUrl}/connection-stats`);
        const current = await response.json();
        return current.total >= 2 && current.active <= 1;
    }, { timeout: 15_000 }).toBe(true);

    const stats = await (await fetch(`${fixtureBaseUrl}/connection-stats`)).json();
    expect(stats.total).toBeGreaterThanOrEqual(2);
    expect(stats.aborted).toBeGreaterThanOrEqual(1);
    expect(stats.maxActive).toBe(1);

    // The setup screen hides SSO, while a configured provider is offered on
    // subsequent login visits.
    await page.goto('/login.html');
    await expect(page.locator('#sso-login-section')).toBeVisible();

    const oidcStatusRoute = '**/api/auth/oidc/status';
    const setupRequiredRoute = '**/api/auth/setup-required';
    const oidcLoginRoute = '**/api/auth/oidc/login';
    const fulfillJson = (route, payload) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload)
    });

    // SSO-only mode hides every local-login control, while an OIDC callback
    // error remains on the page for a deliberate retry instead of looping.
    await page.route(oidcStatusRoute, route => fulfillJson(route, {
        enabled: true,
        localAuthEnabled: false,
        autoRedirect: true
    }));
    await page.goto('/login.html?error=SSO%20Failed');
    await expect(page.locator('#login-form')).toBeHidden();
    await expect(page.locator('#sso-login-section')).toBeVisible();
    await expect(page.locator('#sso-divider')).toBeHidden();
    await expect(page.locator('#error-message')).toHaveText('SSO Failed');
    await page.unroute(oidcStatusRoute);

    // Automatic redirect remains optional, and local=1 provides an explicit
    // escape only while password sign-in is still enabled.
    await page.route(oidcStatusRoute, route => fulfillJson(route, {
        enabled: true,
        localAuthEnabled: true,
        autoRedirect: true
    }));
    await page.route(oidcLoginRoute, route => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<title>Controlled OIDC redirect</title>'
    }));
    await page.goto('/login.html');
    await expect(page).toHaveURL(/\/api\/auth\/oidc\/login$/);
    await page.goto('/login.html?local=1');
    await expect(page.locator('#login-form')).toBeVisible();
    await expect(page.locator('#sso-login-section')).toBeVisible();
    await expect(page.locator('#sso-divider')).toBeVisible();
    await page.unroute(oidcStatusRoute);
    await page.route(oidcStatusRoute, route => fulfillJson(route, {
        enabled: true,
        localAuthEnabled: false,
        autoRedirect: true
    }));
    await page.goto('/login.html?local=1');
    await expect(page).toHaveURL(/\/api\/auth\/oidc\/login$/);
    await page.unroute(oidcLoginRoute);
    await page.unroute(oidcStatusRoute);

    // A deliberate logout suppresses automatic redirect once, including in
    // SSO-only mode, so the user is not immediately signed back in.
    await page.route(oidcStatusRoute, route => fulfillJson(route, {
        enabled: true,
        localAuthEnabled: false,
        autoRedirect: true
    }));
    await page.goto('/login.html?signed_out=1');
    await expect(page.locator('#setup-message')).toHaveText('You have been signed out.');
    await expect(page.locator('#sso-login-section')).toBeVisible();
    await expect(page.locator('#login-form')).toBeHidden();
    await page.unroute(oidcStatusRoute);

    // Misconfigured SSO-only mode fails closed with a useful explanation.
    await page.route(oidcStatusRoute, route => fulfillJson(route, {
        enabled: false,
        localAuthEnabled: false,
        autoRedirect: false
    }));
    await page.goto('/login.html');
    await expect(page.locator('#login-form')).toBeHidden();
    await expect(page.locator('#sso-login-section')).toBeHidden();
    await expect(page.locator('#error-message')).toHaveText(
        'Single sign-on is unavailable. Check the server OIDC configuration.'
    );
    await page.unroute(oidcStatusRoute);

    // The empty-database bootstrap form remains available even when the
    // eventual sign-in mode will be SSO-only.
    await page.route(setupRequiredRoute, route => fulfillJson(route, { setupRequired: true }));
    await page.goto('/login.html');
    await expect(page.locator('#login-form')).toBeVisible();
    await expect(page.locator('#setup-message')).toHaveText(
        'Welcome! Please create your admin account to get started.'
    );
    await expect(page.locator('#sso-login-section')).toBeHidden();
    await page.unroute(setupRequiredRoute);

    expect(expectedRejectedResourceErrors).toBe(0);
    expect(expectedAuthenticationErrors).toBe(0);
    expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
