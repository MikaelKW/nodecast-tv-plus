const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');

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
    page.on('pageerror', error => browserErrors.push(`pageerror: ${error.message}`));
    page.on('console', message => {
        if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
    });

    const password = crypto.randomBytes(24).toString('base64url');
    await page.goto('/login.html');
    await expect(page.locator('#setup-message')).toHaveClass(/show/);
    await page.locator('#username').fill('e2e-admin');
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Create Account', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('NodeCast TV Plus', { exact: true }).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(
        window.app?.currentUser && window.app?.sourceManager && window.app?.channelList
    ))).toBe(true);

    await page.locator('.nav-link[data-page="settings"]').click();
    await expect(page.locator('#page-settings')).toHaveClass(/active/);
    await page.locator('#add-m3u').click();
    await page.locator('#source-name').fill('Controlled M3U');
    await page.locator('#source-url').fill(`${fixtureBaseUrl}/playlist.m3u`);
    await page.locator('#modal-save').click();
    await expect(page.locator('#m3u-list .source-name')).toContainText('Controlled M3U');

    const m3uSource = await page.evaluate(async () => {
        const response = await fetch('/api/sources');
        return (await response.json()).find(source => source.name === 'Controlled M3U');
    });
    expect(m3uSource).toBeTruthy();
    await waitForSync(page, m3uSource.id);

    const epgSource = await page.evaluate(async url => {
        const response = await fetch('/api/sources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'epg', name: 'Controlled EPG', url })
        });
        if (!response.ok) throw new Error(`EPG source creation failed: ${response.status}`);
        return response.json();
    }, `${fixtureBaseUrl}/guide.xml`);
    await waitForSync(page, epgSource.id);

    const epg = await page.evaluate(async id => {
        const response = await fetch(`/api/proxy/epg/${id}`);
        return response.json();
    }, epgSource.id);
    expect(epg.programmes).toHaveLength(1);
    expect(epg.programmes[0].title).toBe('Controlled Test Programme');

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

    expect(browserErrors, browserErrors.join('\n')).toEqual([]);
});
