const assert = require('node:assert/strict');
const VodDuration = require('../public/js/components/VodDuration');

assert.equal(VodDuration.parse(90), 90);
assert.equal(VodDuration.parse('90.5'), 90.5);
assert.equal(VodDuration.parse('24:30'), 1470);
assert.equal(VodDuration.parse('01:02:03'), 3723);
assert.equal(VodDuration.parse(' 00:20 '), 20);

for (const invalid of [undefined, null, '', 0, -1, Infinity, 'Infinity', '1:60', '1:2:60', '1:2:3:4', 'unknown']) {
    assert.equal(VodDuration.parse(invalid), 0, `Expected ${String(invalid)} to be rejected`);
}

assert.equal(VodDuration.firstValid('', '00:42', 80), 42);
assert.equal(VodDuration.firstValid('invalid', 0, null), 0);
assert.equal(VodDuration.fromContent({ duration_secs: '125', duration: '00:03:00' }), 125);
assert.equal(VodDuration.fromContent({ duration: '00:24:00' }), 1440);
assert.equal(VodDuration.fromContent({ info: { duration_secs: 3600 } }), 3600);
assert.equal(VodDuration.fromContent({ movie_data: { duration: '01:30:00' } }), 5400);

console.log('VOD duration tests passed.');
