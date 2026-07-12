const HTTP_RECONNECT_ARGS = Object.freeze([
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    // The bundled FFmpeg reliably supports status-code families for server
    // errors. Authentication/provider rejections are retried once by the
    // session lifecycle instead of looping inside FFmpeg.
    '-reconnect_on_http_error', '5xx',
    '-reconnect_delay_max', '10'
]);

function appendHttpReconnectArgs(args) {
    args.push(...HTTP_RECONNECT_ARGS);
    return args;
}

module.exports = { HTTP_RECONNECT_ARGS, appendHttpReconnectArgs };
