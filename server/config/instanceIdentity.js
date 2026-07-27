const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INSTANCE_ID_FILE = '.nodecast-instance-id';
const MAX_INSTANCE_ID_LENGTH = 128;

function getDataDirectory() {
    return process.env.NODECAST_DATA_DIR
        ? path.resolve(process.env.NODECAST_DATA_DIR)
        : path.join(__dirname, '..', '..', 'data');
}

function validateInstanceId(value, source) {
    const normalized = value?.trim();
    if (!normalized) {
        throw new Error(`${source} must not be empty.`);
    }
    if (normalized.length > MAX_INSTANCE_ID_LENGTH) {
        throw new Error(`${source} must not exceed ${MAX_INSTANCE_ID_LENGTH} characters.`);
    }
    return normalized;
}

function createPersistentInstanceId(filePath) {
    const generated = crypto.randomUUID();
    try {
        const descriptor = fs.openSync(filePath, 'wx', 0o600);
        try {
            fs.writeFileSync(descriptor, `${generated}\n`, 'utf8');
        } finally {
            fs.closeSync(descriptor);
        }
        return generated;
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        return validateInstanceId(fs.readFileSync(filePath, 'utf8'), INSTANCE_ID_FILE);
    }
}

function loadInstanceId() {
    if (process.env.NODECAST_INSTANCE_ID?.trim()) {
        return validateInstanceId(process.env.NODECAST_INSTANCE_ID, 'NODECAST_INSTANCE_ID');
    }

    const dataDirectory = getDataDirectory();
    fs.mkdirSync(dataDirectory, { recursive: true });
    const filePath = path.join(dataDirectory, INSTANCE_ID_FILE);

    try {
        return validateInstanceId(fs.readFileSync(filePath, 'utf8'), INSTANCE_ID_FILE);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return createPersistentInstanceId(filePath);
    }
}

const instanceId = loadInstanceId();
const cookieSuffix = crypto
    .createHash('sha256')
    .update(`nodecast-tv-plus:${instanceId}`)
    .digest('hex')
    .slice(0, 12);

module.exports = {
    instanceId,
    cookieSuffix,
    authCookieName: `nodecast_auth_${cookieSuffix}`,
    sessionCookieName: `nodecast.sid.${cookieSuffix}`,
    legacyAuthCookieName: 'nodecast_auth',
    legacySessionCookieName: 'nodecast.sid'
};
