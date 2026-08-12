const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.join(__dirname, '..');
const channelListPath = path.join(projectRoot, 'public', 'js', 'components', 'ChannelList.js');
const channelListSource = fs.readFileSync(channelListPath, 'utf8');

const context = vm.createContext({
    window: {},
    API: {
        sources: {
            isVisibleIn: () => true
        }
    },
    console: {
        log() {},
        warn() {},
        error() {}
    },
    setTimeout(callback) {
        callback();
        return 1;
    }
});

vm.runInContext(
    `${channelListSource}\nglobalThis.ChannelListForTest = ChannelList;`,
    context,
    { filename: channelListPath }
);

const ChannelList = context.ChannelListForTest;

function sourceResult(sourceId, sourceType, revision) {
    return {
        groups: [{
            id: `${sourceType}_${sourceId}_group`,
            name: `Source ${sourceId} ${revision}`,
            sourceId,
            sourceType
        }],
        channels: [{
            id: `${sourceType}_${sourceId}_channel`,
            name: `Channel ${sourceId} ${revision}`,
            sourceId,
            sourceType
        }]
    };
}

function createChannelList() {
    const channelList = Object.create(ChannelList.prototype);
    channelList.container = { innerHTML: '' };
    channelList.sources = [
        { id: 1, type: 'xtream', enabled: true },
        { id: 2, type: 'm3u', enabled: true }
    ];
    channelList.channels = [];
    channelList.groups = [];
    channelList.isLoading = true;
    channelList.sourceCatalogueCache = new Map();
    channelList.loadHiddenItems = async () => {};
    channelList.loadFavorites = async () => {};
    channelList.renderCount = 0;
    channelList.render = () => {
        assert.equal(channelList.isLoading, false, 'Catalogue rendering must begin only after loading completes.');
        channelList.renderCount += 1;
    };
    return channelList;
}

async function run() {
    const channelList = createChannelList();
    const attempts = new Map();
    let failSourceTwo = false;

    channelList.fetchSourceChannels = async (sourceId, sourceType) => {
        attempts.set(sourceId, (attempts.get(sourceId) || 0) + 1);
        if (sourceId === 2 && failSourceTwo) {
            throw new Error('controlled transient source failure');
        }
        return sourceResult(sourceId, sourceType, failSourceTwo ? 'refreshed' : 'initial');
    };

    await channelList.loadAllChannels();
    assert.deepEqual(
        Array.from(channelList.channels, channel => channel.name),
        ['Channel 1 initial', 'Channel 2 initial']
    );

    failSourceTwo = true;
    attempts.clear();
    await channelList.loadAllChannels();

    assert.equal(attempts.get(2), 2, 'The unavailable source should receive the normal retry.');
    assert.deepEqual(
        Array.from(channelList.channels, channel => channel.name),
        ['Channel 1 refreshed', 'Channel 2 initial'],
        'A transient source failure must retain its last known channels.'
    );
    assert.deepEqual(
        Array.from(channelList.groups, group => group.name),
        ['Source 1 refreshed', 'Source 2 initial'],
        'A transient source failure must retain its last known groups.'
    );

    console.log('Channel catalogue resilience test passed.');
}

run().catch(error => {
    console.error(error);
    process.exit(1);
});
