/** Administrator-only diagnostics view. The server enforces authorization too. */
class DiagnosticsPanel {
    constructor() {
        this.content = document.getElementById('diagnostics-content');
        this.status = document.getElementById('diagnostics-status');
        this.refreshButton = document.getElementById('diagnostics-refresh');
        this.visible = false;
        this.generation = 0;
        this.timer = null;
        this.loadingGeneration = null;
        this.refreshButton?.addEventListener('click', () => this.load());
    }

    show() {
        this.visible = true;
        this.generation += 1;
        this.loadingGeneration = null;
        this.load();
    }

    hide() {
        this.visible = false;
        this.generation += 1;
        clearTimeout(this.timer);
        this.timer = null;
        this.content?.replaceChildren();
        if (this.status) this.status.textContent = '';
    }

    async load() {
        if (!this.visible || this.loadingGeneration === this.generation) return;
        const generation = this.generation;
        this.loadingGeneration = generation;
        clearTimeout(this.timer);
        if (this.refreshButton) this.refreshButton.disabled = true;
        if (this.status) this.status.textContent = 'Loading diagnostics…';

        try {
            const data = await API.diagnostics.getSummary();
            if (!this.visible || generation !== this.generation || !data) return;
            this.render(data);
            if (this.status) this.status.textContent = `Updated ${new Date().toLocaleTimeString()}.`;
        } catch {
            if (!this.visible || generation !== this.generation) return;
            this.content?.replaceChildren();
            if (this.status) this.status.textContent = 'Diagnostics are unavailable. Check your session or try again.';
        } finally {
            if (this.loadingGeneration === generation) this.loadingGeneration = null;
            if (this.visible && generation === this.generation) {
                if (this.refreshButton) this.refreshButton.disabled = false;
                // One request at a time; no polling while the tab is hidden.
                this.timer = setTimeout(() => this.load(), 15000);
            }
        }
    }

    static addLine(parent, text) {
        const line = document.createElement('p');
        line.textContent = text;
        parent.append(line);
    }

    static addCard(root, title) {
        const card = document.createElement('section');
        card.className = 'diagnostics-card';
        const heading = document.createElement('h4');
        heading.textContent = title;
        card.append(heading);
        root.append(card);
        return card;
    }

    static time(value) {
        if (!value) return 'Unavailable';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
    }

    static mib(value) {
        return Number.isFinite(value) && value >= 0
            ? `${(value / 1024 / 1024).toFixed(1)} MiB` : 'Unavailable';
    }

    render(data) {
        if (!this.content) return;
        const root = document.createDocumentFragment();
        const overview = DiagnosticsPanel.addCard(root, 'Application and resources');
        DiagnosticsPanel.addLine(overview, `Version: ${data.version || 'Unavailable'}`);
        DiagnosticsPanel.addLine(overview, `Revision: ${data.revision || 'Unavailable in this installation'}`);
        DiagnosticsPanel.addLine(overview, `Process uptime: ${Number.isFinite(data.resources?.processUptimeSeconds) ? data.resources.processUptimeSeconds + ' seconds' : 'Unavailable'}`);
        DiagnosticsPanel.addLine(overview, `Process memory (RSS): ${DiagnosticsPanel.mib(data.resources?.processRssBytes)}`);
        DiagnosticsPanel.addLine(overview, `JavaScript heap used: ${DiagnosticsPanel.mib(data.resources?.processHeapUsedBytes)}`);

        const playback = DiagnosticsPanel.addCard(root, 'Managed playback sessions');
        const sessions = Array.isArray(data.playback?.managedSessions) ? data.playback.managedSessions : [];
        if (!sessions.length) DiagnosticsPanel.addLine(playback, 'No managed sessions are currently active. Direct and browser-remuxed paths appear only in Recent events.');
        for (const session of sessions) {
            DiagnosticsPanel.addLine(playback, `${session.status || 'Unavailable'} · ${session.ageSeconds ?? 'Unknown'} seconds · Trace ${session.traceId || 'Unavailable'}`);
        }

        const sync = DiagnosticsPanel.addCard(root, 'Source synchronization');
        if (!data.synchronization?.available) {
            DiagnosticsPanel.addLine(sync, 'Synchronization status is unavailable.');
        } else if (!data.synchronization.sources?.length) {
            DiagnosticsPanel.addLine(sync, 'No recent source status is available.');
        } else {
            for (const source of data.synchronization.sources) {
                DiagnosticsPanel.addLine(sync, `Source #${source.sourceId} · ${source.status} · ${DiagnosticsPanel.time(source.at)}`);
            }
        }

        const events = DiagnosticsPanel.addCard(root, 'Recent events');
        const entries = Array.isArray(data.events) ? data.events : [];
        if (!entries.length) {
            DiagnosticsPanel.addLine(events, 'No recent events. The history is held in memory and resets when the app restarts.');
        } else {
            const list = document.createElement('ol');
            list.className = 'diagnostics-events';
            for (const event of entries) {
                const item = document.createElement('li');
                item.textContent = `${DiagnosticsPanel.time(event.at)} · ${event.reasonText || event.reason || 'Event'} · Trace ${event.traceId || 'Unavailable'}${Number.isSafeInteger(event.sourceId) ? ` · Source #${event.sourceId}` : ''}`;
                list.append(item);
            }
            events.append(list);
        }
        DiagnosticsPanel.addLine(events, 'Recent events are limited to 128 entries and expire after one hour.');
        this.content.replaceChildren(root);
    }
}

window.DiagnosticsPanel = DiagnosticsPanel;
