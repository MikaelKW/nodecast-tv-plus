const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');

const fixtureBaseUrl = `http://127.0.0.1:${process.env.NODECAST_TEST_FIXTURE_PORT || 3231}`;
const providerTimeZone = 'Europe/Amsterdam';

function providerTime(date) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: providerTimeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}:${parts.hour}-${parts.minute}`;
}

async function catchupRequests() {
    return (await fetch(`${fixtureBaseUrl}/catchup-requests`)).json();
}

test('a past programme plays from the provider archive and can be sought', async ({ page }) => {
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));

    const password = crypto.randomBytes(24).toString('base64url');
    const setup = await page.request.post('/api/auth/setup', {
        data: { username: 'catchup-admin', password, passwordConfirmation: password }
    });
    expect(setup.status()).toBe(201);
    await page.goto('/');

    const source = await page.evaluate(async values => {
        const response = await fetch('/api/sources', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'xtream', name: 'Archive Provider', ...values })
        });
        if (!response.ok) throw new Error(`Source creation failed: ${response.status}`);
        return response.json();
    }, {
        url: `${fixtureBaseUrl}/xtream`,
        username: `catchup-${crypto.randomBytes(8).toString('hex')}`,
        password: crypto.randomBytes(16).toString('base64url')
    });
    await expect.poll(async () => page.evaluate(async id => {
        const response = await fetch('/api/sources/status');
        if (!response.ok) return `http-${response.status}`;
        const statuses = await response.json();
        return statuses.find(status => status.source_id === id && status.type === 'all')?.status || 'pending';
    }, source.id), { timeout: 45_000 }).toBe('success');

    // Open the guide two hours back so the archived programme is in view.
    await page.reload();
    await page.evaluate(() => window.app.navigateTo('guide'));
    await page.locator('#guide-prev').click();
    await page.locator('#guide-prev').click();

    const archived = page.locator('.epg-program.catchup', { hasText: 'Archived Test Programme' });
    await expect(archived).toBeVisible();
    await expect(archived.locator('.epg-catchup-badge')).toBeVisible();
    const programmeStart = new Date(await archived.getAttribute('data-start'));

    await archived.click();
    await expect(page.locator('#modal')).toContainText('The provider keeps 2 days of this channel.');
    await page.locator('#modal-catchup-watch').click();

    await expect(page.locator('#page-watch')).toHaveClass(/active/);
    await expect(page.locator('#watch-title')).toHaveText('Archived Test Programme');
    await expect(page.locator('#watch-live-btn')).toBeVisible();
    await expect(page.locator('#watch-favorite-btn')).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.querySelector('#watch-video')?.currentTime || 0)).toBeGreaterThan(1);

    // The provider is asked for the programme in its own time zone.
    let requests = await catchupRequests();
    expect(requests.some(path => path.endsWith(`/60/${providerTime(programmeStart)}/1501.ts`))).toBe(true);
    // The programme's full length is shown, not the length of the stream.
    expect(await page.evaluate(() => window.app.pages.watch.getPlaybackDuration())).toBe(3600);

    // Seeking past what the stream holds requests the archive from there.
    await page.evaluate(() => window.app.pages.watch.seekToContentTime(1800));
    const seekStart = providerTime(new Date(programmeStart.getTime() + 30 * 60 * 1000));
    await expect.poll(async () => (await catchupRequests())
        .some(path => path.endsWith(`/30/${seekStart}/1501.ts`))).toBe(true);
    await expect.poll(() => page.evaluate(() => window.app.pages.watch.getCurrentPlaybackTime()))
        .toBeGreaterThanOrEqual(1800);
    await expect(page.locator('#watch-title')).toHaveText('Archived Test Programme');

    // Return to the live channel.
    await page.locator('#watch-live-btn').click();
    await expect(page.locator('#page-live')).toHaveClass(/active/);
    await expect.poll(() => page.evaluate(() => String(window.app.channelList.currentChannel?.streamId))).toBe('1501');

    // The archive is not part of the watch history.
    const history = await page.evaluate(async () => (await fetch('/api/history')).json());
    expect(JSON.stringify(history)).not.toContain('catchup:');

    requests = await catchupRequests();
    expect(requests.every(path => !path.includes('undefined'))).toBe(true);
    expect(browserErrors).toEqual([]);
});
