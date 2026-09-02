// Loaded only by the large-catalogue benchmark. It lets the parent benchmark
// sample the server process without adding a diagnostics endpoint to NodeCast.
process.on('message', message => {
    if (message?.type !== 'benchmark-memory-request' || !process.send) return;
    process.send({
        type: 'benchmark-memory-response',
        requestId: message.requestId,
        memory: process.memoryUsage()
    });
});
