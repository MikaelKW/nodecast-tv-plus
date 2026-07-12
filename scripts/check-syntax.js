const { readdirSync, statSync } = require('fs');
const { join, relative } = require('path');
const { spawnSync } = require('child_process');

const projectRoot = join(__dirname, '..');
const sourceDirectories = ['public/js', 'server', 'scripts', 'tests'];
const rootFiles = ['playwright.config.js'];
const ignoredFiles = new Set();

function collectJavaScriptFiles(directory) {
    const absoluteDirectory = join(projectRoot, directory);
    const files = [];

    for (const entry of readdirSync(absoluteDirectory)) {
        const absolutePath = join(absoluteDirectory, entry);
        const projectPath = relative(projectRoot, absolutePath).replaceAll('\\', '/');
        const stats = statSync(absolutePath);

        if (stats.isDirectory()) {
            files.push(...collectJavaScriptFiles(projectPath));
        } else if (entry.endsWith('.js') && !ignoredFiles.has(projectPath)) {
            files.push(projectPath);
        }
    }

    return files;
}

const files = [...rootFiles, ...sourceDirectories.flatMap(collectJavaScriptFiles)].sort();
let failed = false;

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
        cwd: projectRoot,
        encoding: 'utf8'
    });

    if (result.status !== 0) {
        failed = true;
        console.error(`Syntax check failed: ${file}`);
        console.error(result.stderr || result.stdout);
    }
}

if (failed) {
    process.exit(1);
}

console.log(`Syntax check passed for ${files.length} JavaScript files.`);
