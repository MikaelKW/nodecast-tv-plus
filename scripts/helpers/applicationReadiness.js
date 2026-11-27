async function isApplicationReady(baseUrl) {
    const response = await fetch(`${baseUrl}/api/startup`);
    return response.ok && ['ready', 'degraded'].includes((await response.json()).state);
}

async function waitForApplicationReady(baseUrl, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { if (await isApplicationReady(baseUrl)) return; } catch { /* The listener may not be available yet. */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Application did not become ready for authentication');
}

module.exports = { isApplicationReady, waitForApplicationReady };
