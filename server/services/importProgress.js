function createImportProgress({ inactivityMs = 30000 } = {}) {
    const controller = new AbortController();
    let timer;
    let disposed = false;
    const touch = () => {
        if (disposed || controller.signal.aborted) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
            const error = new Error('Initial import stopped making progress');
            error.code = 'PROVIDER_INACTIVE';
            controller.abort(error);
        }, inactivityMs);
        timer.unref?.();
    };
    touch();
    return {
        signal: controller.signal,
        touch,
        check() { controller.signal.throwIfAborted(); touch(); },
        dispose() { disposed = true; clearTimeout(timer); }
    };
}

module.exports = { createImportProgress };
