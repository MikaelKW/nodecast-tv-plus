// Test-only preload for controlling the disposable server's startup boundary.
const http = require('node:http');
const service = require('../../server/services/startupReadiness');

const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
    this.once('listening', () => process.send({ port: this.address().port }));
    return listen.apply(this, args);
};

const prepare = service.prepare;
service.prepare = () => new Promise(resolve => process.once('message', async message => {
    if (message === 'prepare') resolve(await prepare());
}));

process.on('message', message => {
    if (message === 'fatal-storage') {
        service.fail();
        process.send(service.snapshot());
    }
});
