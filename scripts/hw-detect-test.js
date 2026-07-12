const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findIntelRenderDevice } = require('../server/services/hwDetect');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-hw-detect-'));
const drmRoot = path.join(testRoot, 'sys', 'class', 'drm');
const deviceRoot = path.join(testRoot, 'dev', 'dri');

function addRenderNode(name, vendorId, mapped = true) {
    fs.mkdirSync(path.join(drmRoot, name, 'device'), { recursive: true });
    fs.writeFileSync(path.join(drmRoot, name, 'device', 'vendor'), `${vendorId}\n`);
    if (mapped) {
        fs.mkdirSync(deviceRoot, { recursive: true });
        fs.writeFileSync(path.join(deviceRoot, name), '');
    }
}

try {
    addRenderNode('renderD128', '0x1002');
    assert.equal(
        findIntelRenderDevice({ drmRoot, deviceRoot }),
        null,
        'AMD render nodes must not be reported as Intel QSV devices.'
    );

    addRenderNode('renderD129', '0x8086', false);
    assert.equal(
        findIntelRenderDevice({ drmRoot, deviceRoot }),
        null,
        'An Intel render node that is not mapped into the container must not enable QSV.'
    );

    addRenderNode('renderD129', '0x8086');
    assert.equal(
        findIntelRenderDevice({ drmRoot, deviceRoot }),
        path.join(deviceRoot, 'renderD129'),
        'A mapped Intel render node should enable QSV detection.'
    );

    console.log('Hardware detection tests passed.');
} finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
}
