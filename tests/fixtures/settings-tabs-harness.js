// Shared harness for the Settings tab row tests: renders the shipped tab
// markup inside the real settings container with the application stylesheet
// and drives it with the real SettingsPage.switchTab().
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const start = indexHtml.indexOf('<div class="tabs">');
const tabsMarkup = indexHtml.slice(start, indexHtml.indexOf('</div>', start) + '</div>'.length)
    // An administrator sees every tab, including Users and Logs.
    .replace(/ style="display:none;"/g, '');

async function openSettingsTabs(page) {
    await page.route('**/settings-tabs-harness', route => route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
            <body><div id="page-settings" class="page active"><div class="settings-container">
            <h2>Settings</h2>${tabsMarkup}</div></div></body></html>`
    }));
    await page.goto('/settings-tabs-harness');
    await page.addStyleTag({ path: path.join(root, 'public/css/main.css') });
    await page.addScriptTag({ path: path.join(root, 'public/js/pages/Settings.js') });
    await page.evaluate(() => {
        const noop = () => {};
        const settings = Object.create(window.SettingsPage.prototype);
        Object.assign(settings, {
            app: { currentUser: { role: 'admin' }, sourceManager: { loadContentSources: noop } },
            tabs: document.querySelectorAll('.tabs .tab'),
            tabContents: [],
            isVisible: false,
            diagnosticsPanel: { show: noop, hide: noop },
            authLogPanel: { show: noop, hide: noop },
            loadUsers: noop,
            loadAboutInformation: noop,
            loadLiveTvPreferences: noop,
            loadSubtitlePreferences: noop,
            loadHardwareInfo: noop
        });
        settings.tabs.forEach(tab => tab.addEventListener('click', () => settings.switchTab(tab.dataset.tab)));
    });
}

// Geometry of the tab row and of one tab relative to the visible row.
function tabRowState(page, tabName) {
    return page.evaluate(name => {
        const row = document.querySelector('.tabs');
        const tabs = [...row.querySelectorAll('.tab')];
        const rowRect = row.getBoundingClientRect();
        const tab = tabs.find(item => item.dataset.tab === name);
        const tabRect = tab?.getBoundingClientRect();
        return {
            rowClientWidth: row.clientWidth,
            rowScrollWidth: row.scrollWidth,
            scrollbarHeight: row.offsetHeight - row.clientHeight - parseFloat(getComputedStyle(row).borderBottomWidth),
            rows: new Set(tabs.map(item => Math.round(item.getBoundingClientRect().top))).size,
            minTabHeight: Math.min(...tabs.map(item => item.getBoundingClientRect().height)),
            tabVisible: tabRect ? tabRect.left >= rowRect.left - 1 && tabRect.right <= rowRect.right + 1 : null,
            tabActive: tab?.classList.contains('active') ?? null,
            pageOverflow: document.documentElement.scrollWidth - window.innerWidth
        };
    }, tabName);
}

module.exports = { openSettingsTabs, tabRowState };
