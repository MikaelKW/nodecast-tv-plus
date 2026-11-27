const fs = require('node:fs');
const expected = JSON.parse(fs.readFileSync(0, 'utf8'));

// Observe the configuration after the real entrypoint has loaded dotenv and
// its configuration modules. Only comparison results cross the IPC channel.
setImmediate(() => {
    const security = require('../../server/config/security');
    const basePath = require('../../server/config/basePath');
    process.send({
        type: 'configuration-observed',
        jwtMatches: security.jwtSecret === expected.jwt,
        sessionMatches: security.sessionSecret === expected.session,
        totpMatches: security.totpEncryptionSecret === expected.totp,
        basePathMatches: basePath.configuredBasePath === expected.basePath,
        production: process.env.NODE_ENV === 'production',
        valuesMatch: Object.entries(expected.values).every(([key, value]) => process.env[key] === value)
    });
});
