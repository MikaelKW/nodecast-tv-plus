const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourceManagerPath = path.join(__dirname, '..', 'public', 'js', 'components', 'SourceManager.js');
const sourceManagerSource = fs.readFileSync(sourceManagerPath, 'utf8');
const context = vm.createContext({ console, window: {} });

vm.runInContext(
    `${sourceManagerSource}\nglobalThis.SourceManagerForTest = SourceManager;`,
    context,
    { filename: sourceManagerPath }
);

const manager = Object.create(context.SourceManagerForTest.prototype);
const completeGroup = {
    id: 'group-1',
    name: 'Example Group',
    items: [
        { type: 'channel', id: 'one' },
        { type: 'channel', id: 'two' },
        { type: 'channel', id: 'three' }
    ]
};
manager.treeData = { groups: [completeGroup] };

function stateWithHidden(...keys) {
    manager.hiddenSet = new Set(keys);
    return manager.getGroupVisibilityState(completeGroup);
}

function assertState(actual, checked, indeterminate, message) {
    assert.equal(actual.checked, checked, message);
    assert.equal(actual.indeterminate, indeterminate, message);
}

assertState(stateWithHidden(), true, false, 'all visible');
assertState(stateWithHidden('channel:one'), false, true, 'partially visible');
assertState(
    stateWithHidden('channel:one', 'channel:two', 'channel:three'),
    false,
    false,
    'all hidden'
);

manager.hiddenSet = new Set(['channel:two', 'channel:three']);
assertState(
    manager.getGroupVisibilityState({ ...completeGroup, items: [completeGroup.items[0]] }),
    false,
    true,
    'search-filtered groups must retain the complete group state'
);

const attributes = new Map();
const checkbox = {
    checked: false,
    indeterminate: false,
    dataset: {},
    setAttribute(name, value) {
        attributes.set(name, value);
    }
};
manager.applyGroupCheckboxState(checkbox, completeGroup);
assert.equal(checkbox.checked, false);
assert.equal(checkbox.indeterminate, true);
assert.equal(checkbox.dataset.indeterminate, 'true');
assert.equal(attributes.get('aria-checked'), 'mixed');

console.log('Content group tri-state test passed.');
