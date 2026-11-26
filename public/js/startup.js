/* Shared startup wait for sign-in and existing authenticated sessions. */
const NodeCastStartup = (() => {
    let pending;
    let stopped = false;
    let reloadPending = false;
    let controller;
    window.addEventListener('pagehide', () => { stopped = true; controller?.abort(); });
    window.addEventListener('pageshow', () => { stopped = false; reloadPending = false; });

    function notice(message) {
        let element = document.getElementById('startup-notice');
        if (!element) {
            element = document.createElement('div');
            element.id = 'startup-notice';
            element.className = 'startup-overlay';
            element.setAttribute('role', 'status');
            element.setAttribute('aria-live', 'polite');
            const text = document.createElement('p');
            element.appendChild(text);
            document.body.appendChild(element);
        }
        if (element.firstChild.textContent !== message) element.firstChild.textContent = message;
    }

    async function poll() {
        let delay = 2000;
        const content = document.getElementById('app') || document.querySelector('.login-container');
        const wasInert = content?.inert;
        if (content) content.inert = true;
        notice('Server is starting. Please wait.');
        try {
            while (!stopped) {
                try {
                    controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 10000);
                    let response;
                    let result;
                    try {
                        response = await fetch(NodeCastUrl.resolve('/api/startup'), { cache: 'no-store', signal: controller.signal });
                        if (response.ok) result = await response.json();
                    } finally { clearTimeout(timeout); }
                    if (response.status === 429) {
                        const retry = response.headers.get('Retry-After');
                        const seconds = Number(retry);
                        const retryMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now();
                        delay = Math.max(2000, Number.isFinite(retryMs) ? retryMs : 10000);
                    } else {
                        if (!response.ok) throw new Error('Startup check unavailable');
                        if (result.state === 'ready' || result.state === 'degraded') return true;
                        if (!['starting', 'failed'].includes(result.state)) throw new Error('Invalid startup state');
                        notice(result.state === 'failed'
                            ? 'The server could not finish starting. Please try again later.'
                            : 'Server is starting. Please wait.');
                        delay = 2000;
                    }
                } catch {
                    if (stopped) return false;
                    notice('Waiting for the server. Please wait.');
                    delay = Math.min(30000, delay * 2);
                }
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            return false;
        } finally {
            if (content) content.inert = wasInert;
            document.getElementById('startup-notice')?.remove();
        }
    }

    function wait() {
        if (!pending) pending = poll().finally(() => { pending = null; });
        return pending;
    }

    function handleUnavailable(response, result) {
        if (response.status !== 503 || result?.code !== 'APPLICATION_STARTING') return false;
        if (!reloadPending) {
            reloadPending = true;
            wait().then(ready => { if (ready) window.location.reload(); });
        }
        return true;
    }

    return { wait, handleUnavailable };
})();
