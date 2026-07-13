const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function fail(message) {
    console.error(`Release metadata check failed: ${message}`);
    process.exitCode = 1;
}

const manifest = readJson('package.json');
const lockfile = readJson('package-lock.json');
const version = manifest.version;
const stableSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

if (!stableSemver.test(version)) {
    fail(`package.json version "${version}" is not a stable semantic version.`);
}

if (lockfile.version !== version) {
    fail(`package-lock.json version "${lockfile.version}" does not match package.json "${version}".`);
}

if (lockfile.packages?.['']?.version !== version) {
    fail(`package-lock.json root package version does not match package.json "${version}".`);
}

if (lockfile.name !== manifest.name || lockfile.packages?.['']?.name !== manifest.name) {
    fail('package name is inconsistent between package.json and package-lock.json.');
}

const changelogPath = path.join(root, 'CHANGELOG.md');
if (!fs.existsSync(changelogPath)) {
    fail('CHANGELOG.md is missing.');
} else {
    const changelog = fs.readFileSync(changelogPath, 'utf8');
    if (!changelog.includes(`## [${version}]`)) {
        fail(`CHANGELOG.md has no entry for ${version}.`);
    }
}

const releaseNotesPath = path.join(root, 'docs', 'releases', `v${version}.md`);
if (!fs.existsSync(releaseNotesPath)) {
    fail(`curated release notes are missing at docs/releases/v${version}.md.`);
}

const refType = process.env.GITHUB_REF_TYPE;
const refName = process.env.GITHUB_REF_NAME
    || process.env.GITHUB_REF?.replace(/^refs\/tags\//, '');

if (refType === 'tag' || process.env.GITHUB_REF?.startsWith('refs/tags/')) {
    const expectedTag = `v${version}`;
    if (refName !== expectedTag) {
        fail(`tag "${refName}" does not match package version; expected "${expectedTag}".`);
    }
}

if (!process.exitCode) {
    console.log(`Release metadata is consistent for v${version}.`);
}
