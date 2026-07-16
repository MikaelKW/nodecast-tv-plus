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
    const browserErrors = [];
    const qualityLogs = [];
    const qualitySessionSources = [];
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
        if (request.method() !== 'POST' || !request.url().endsWith('/api/transcode/session')) return;
        const sourceUrl = request.postDataJSON()?.url;
        if (!sourceUrl) return;
        const sourcePath = new URL(sourceUrl).pathname;
        qualitySessionSources.push(sourcePath);
        if (sourcePath === '/browser-only.mp4') expectedRejectedResourceErrors += 1;
    });

    const password = crypto.randomBytes(24).toString('base64url');
    await page.goto('/login.html');
    await expect(page.locator('#setup-message')).toHaveClass(/show/);
    await expect(page.locator('#sso-login-section')).toBeHidden();
    await expect(page.locator('#confirm-password-group')).toBeVisible();
    await expect(page.locator('#confirm-password')).toBeEnabled();
    await page.locator('#username').fill('e2e-admin');
    await page.locator('#password').fill(password);
    await expect(page.locator('#confirm-password')).toBeVisible();
    await page.locator('#confirm-password').fill(`${password}-different`);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();
    await expect(page.locator('#error-message')).toHaveText('Passwords do not match');
    await expect(page).toHaveURL(/\/login\.html$/);
    await page.locator('#confirm-password').fill(password);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();
    await expect(page).toHaveURL(/\/(?:#home)?$/);
    await expect(page.getByText('NodeCast TV Plus', { exact: true }).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(
        window.app?.currentUser && window.app?.sourceManager && window.app?.channelList
    ))).toBe(true);

    // Enroll through the same guided flow presented to local accounts, then
    // prove password sign-in stops at the server-side challenge until a fresh
    // authenticator code is supplied.
    await expect(page.locator('#account-menu-initial')).toHaveText('E');
    await page.locator('#account-menu-trigger').click();
    await expect(page.locator('#account-menu-popover')).toBeVisible();
    await page.locator('#account-security-link').click();
    await expect(page.locator('#page-account')).toHaveClass(/active/);
    await expect(page.locator('#two-factor-status-badge')).toHaveText('Not enabled');
    await page.getByRole('button', { name: 'Enable two-factor authentication' }).click();
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

    await page.locator('.nav-link[data-page="settings"]').click();
    await expect(page.locator('#page-settings')).toHaveClass(/active/);
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
    await waitForSync(page, seriesSource.id);

    await page.evaluate(() => window.app.navigateTo('series'));
    await expect(page.locator('#page-series')).toHaveClass(/active/);
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

    expect(expectedRejectedResourceErrors).toBe(0);
    expect(expectedAuthenticationErrors).toBe(0);
    expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
