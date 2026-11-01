/**
 * Administrator view of the authentication audit log (Settings → Logs).
 * The server enforces administrator access. Entries contain untrusted text
 * such as attempted usernames and user agents, so everything is rendered with
 * textContent and never parsed as HTML.
 */
class AuthLogPanel {
    static LABELS = Object.freeze({
        event: { sign_in: 'Sign-in', sign_out: 'Sign-out', setup: 'Initial setup' },
        outcome: { success: 'Succeeded', failure: 'Failed', mfa_required: 'Two-factor required' },
        method: {
            password: 'Password',
            sso: 'Single sign-on',
            'password+totp': 'Password + authenticator',
            'password+recovery_code': 'Password + recovery code',
            'sso+totp': 'Single sign-on + authenticator',
            'sso+recovery_code': 'Single sign-on + recovery code'
        }
    });

    constructor({ api = window.API, root = document, onRetentionSaved = null } = {}) {
        this.api = api;
        this.root = root;
        // Lets the page update other cached copies of the settings, such as
        // the player's, which saves its whole settings object later.
        this.onRetentionSaved = onRetentionSaved;
        const $ = id => root.getElementById(id);
        this.form = $('auth-log-filters');
        this.fields = {
            from: $('auth-log-from'),
            to: $('auth-log-to'),
            account: $('auth-log-account'),
            ip: $('auth-log-ip'),
            outcome: $('auth-log-outcome'),
            event: $('auth-log-event')
        };
        this.rows = $('auth-log-rows');
        this.status = $('auth-log-status');
        this.pageLabel = $('auth-log-page');
        this.prevButton = $('auth-log-prev');
        this.nextButton = $('auth-log-next');
        this.retentionForm = $('auth-log-retention');
        this.retentionDays = $('auth-log-retention-days');
        this.maxEntries = $('auth-log-max-entries');
        this.retentionStatus = $('auth-log-retention-status');

        this.page = 1;
        this.pages = 1;
        this.pageSize = 25;
        this.visible = false;
        this.generation = 0;

        this.form?.addEventListener('submit', event => {
            event.preventDefault();
            this.page = 1;
            this.load();
        });
        $('auth-log-reset')?.addEventListener('click', () => {
            this.form?.reset();
            this.page = 1;
            this.load();
        });
        $('auth-log-refresh')?.addEventListener('click', () => this.load());
        this.prevButton?.addEventListener('click', () => this.goTo(this.page - 1));
        this.nextButton?.addEventListener('click', () => this.goTo(this.page + 1));
        this.retentionForm?.addEventListener('submit', event => {
            event.preventDefault();
            this.saveRetention();
        });
        // Filter by a value from a row: clicking an IP or account applies it.
        this.rows?.addEventListener('click', event => {
            const filterButton = event.target.closest('[data-auth-log-filter]');
            if (!filterButton) return;
            const field = this.fields[filterButton.dataset.authLogFilter];
            if (!field) return;
            field.value = filterButton.dataset.value || '';
            this.page = 1;
            this.load();
        });
    }

    show() {
        this.visible = true;
        this.load();
        this.loadRetention();
    }

    hide() {
        this.visible = false;
        this.generation += 1;
    }

    goTo(page) {
        if (page < 1 || page > this.pages) return;
        this.page = page;
        this.load();
    }

    static toIsoOrEmpty(localValue) {
        if (!localValue) return '';
        const time = new Date(localValue);
        return Number.isFinite(time.getTime()) ? time.toISOString() : '';
    }

    filters() {
        let to = AuthLogPanel.toIsoOrEmpty(this.fields.to?.value);
        // A datetime-local value has minute precision; include that whole minute.
        if (to) to = new Date(Date.parse(to) + 59999).toISOString();
        return {
            from: AuthLogPanel.toIsoOrEmpty(this.fields.from?.value),
            to,
            account: this.fields.account?.value.trim() || '',
            ip: this.fields.ip?.value.trim() || '',
            outcome: this.fields.outcome?.value || '',
            event: this.fields.event?.value || '',
            page: this.page,
            pageSize: this.pageSize
        };
    }

    setStatus(text) {
        if (this.status) this.status.textContent = text;
    }

    async load() {
        if (!this.visible) return;
        const generation = ++this.generation;
        this.setStatus('Loading sign-in activity…');
        try {
            const result = await this.api.authLog.list(this.filters());
            if (!this.visible || generation !== this.generation) return;
            this.render(result);
        } catch (error) {
            if (!this.visible || generation !== this.generation) return;
            this.rows?.replaceChildren();
            this.setStatus(`The sign-in log could not be loaded: ${error.message}`);
            this.updatePagination({ total: 0, page: 1, pages: 1, pageSize: this.pageSize });
        }
    }

    render(result) {
        const entries = Array.isArray(result?.entries) ? result.entries : [];
        const fragment = document.createDocumentFragment();
        for (const entry of entries) {
            const [row, details] = this.renderEntry(entry);
            fragment.append(row, details);
        }
        this.rows?.replaceChildren(fragment);
        this.setStatus(entries.length ? '' : 'No sign-in activity matches these filters.');
        this.updatePagination(result || {});
    }

    updatePagination({ total = 0, page = 1, pages = 1, pageSize = this.pageSize }) {
        this.page = page;
        this.pages = Math.max(1, pages);
        if (this.prevButton) this.prevButton.disabled = page <= 1;
        if (this.nextButton) this.nextButton.disabled = page >= this.pages;
        if (!this.pageLabel) return;
        if (!total) {
            this.pageLabel.textContent = '';
            return;
        }
        const first = (page - 1) * pageSize + 1;
        const last = Math.min(total, page * pageSize);
        this.pageLabel.textContent = `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`;
    }

    static label(group, value) {
        if (!value) return '—';
        return AuthLogPanel.LABELS[group]?.[value] || value;
    }

    static formatTime(iso) {
        const date = new Date(iso);
        if (!Number.isFinite(date.getTime())) return String(iso || '');
        return date.toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
    }

    /** Compact two-line label: date (year only when not this year) and time. */
    static formatTimeParts(iso, now = new Date()) {
        const date = new Date(iso);
        if (!Number.isFinite(date.getTime())) return { day: String(iso || ''), time: '' };
        const sameYear = date.getFullYear() === now.getFullYear();
        return {
            day: date.toLocaleDateString(undefined, {
                day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' })
            }),
            time: date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        };
    }

    secondary(text) {
        const span = document.createElement('span');
        span.className = 'auth-log-secondary';
        span.textContent = text;
        return span;
    }

    cell(content, className) {
        const td = document.createElement('td');
        if (className) td.className = className;
        if (content instanceof Node) td.append(content);
        else td.textContent = content === null || content === undefined || content === '' ? '—' : String(content);
        return td;
    }

    filterButton(field, value, text = value) {
        if (!value) return document.createTextNode('—');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'auth-log-filter-link';
        button.dataset.authLogFilter = field;
        button.dataset.value = value;
        button.title = field === 'ip' ? 'Show entries from this IP address' : 'Show entries for this account';
        button.textContent = text;
        return button;
    }

    renderEntry(entry) {
        const row = document.createElement('tr');
        row.className = `auth-log-row auth-log-${entry.outcome}`;

        const details = document.createElement('tr');
        details.className = 'auth-log-details';
        details.hidden = true;
        const detailsCell = document.createElement('td');
        detailsCell.colSpan = 6;
        detailsCell.append(this.renderDetails(entry));
        details.append(detailsCell);

        // The time doubles as the details toggle, so no extra column is needed.
        const parts = AuthLogPanel.formatTimeParts(entry.at);
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'auth-log-toggle';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', `Show details for ${AuthLogPanel.formatTime(entry.at)}`);
        const chevron = document.createElement('span');
        chevron.className = 'auth-log-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        chevron.textContent = '▸';
        const time = document.createElement('time');
        time.dateTime = entry.at;
        time.title = AuthLogPanel.formatTime(entry.at);
        time.append(document.createTextNode(parts.day), this.secondary(parts.time));
        toggle.append(chevron, time);
        toggle.addEventListener('click', () => {
            details.hidden = !details.hidden;
            toggle.setAttribute('aria-expanded', String(!details.hidden));
            row.classList.toggle('expanded', !details.hidden);
        });
        row.append(this.cell(toggle));

        // The whole row toggles the details. The time button keeps keyboard
        // access; other controls (account and IP filters) keep their own
        // action, and selecting text to copy it does not toggle the row.
        row.addEventListener('click', event => {
            if (event.target.closest('button, a, input, select, textarea')) return;
            if (String(window.getSelection?.() || '').trim()) return;
            toggle.click();
        });

        row.append(this.cell(this.filterButton('account', entry.username)));

        const eventCell = this.cell(AuthLogPanel.label('event', entry.event));
        if (entry.method) eventCell.append(this.secondary(AuthLogPanel.label('method', entry.method)));
        row.append(eventCell);

        const outcome = document.createElement('span');
        outcome.className = `auth-log-outcome auth-log-outcome-${entry.outcome}`;
        outcome.textContent = AuthLogPanel.label('outcome', entry.outcome);
        const outcomeCell = this.cell(outcome);
        if (entry.reasonText) outcomeCell.append(this.secondary(entry.reasonText));
        row.append(outcomeCell);

        row.append(this.cell(this.filterButton('ip', entry.ip)));
        row.append(this.cell(entry.client));

        return [row, details];
    }

    renderDetails(entry) {
        const list = document.createElement('dl');
        list.className = 'auth-log-detail-list';
        const add = (term, value, { wide = false, hint = '' } = {}) => {
            const group = document.createElement('div');
            group.className = wide ? 'auth-log-detail wide' : 'auth-log-detail';
            const dt = document.createElement('dt');
            dt.textContent = term;
            if (hint) dt.title = hint;
            const dd = document.createElement('dd');
            dd.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
            group.append(dt, dd);
            list.append(group);
        };
        add('Time (UTC)', entry.at);
        add('Event', [AuthLogPanel.label('event', entry.event), entry.method && AuthLogPanel.label('method', entry.method)]
            .filter(Boolean).join(' · '));
        add('Account', entry.userId !== null && entry.userId !== undefined
            ? `${entry.username || '—'} (ID ${entry.userId})`
            : entry.username);
        add('Reason', entry.reasonText || entry.reason);
        add('Client IP', entry.ip, { hint: 'Resolved through the trusted proxy settings' });
        add('Received from', entry.peerIp, { hint: 'The address that connected to the server: a proxy or the client itself' });
        add('Forwarded chain', Array.isArray(entry.forwardedFor) && entry.forwardedFor.length
            ? entry.forwardedFor.join(' → ')
            : '', { hint: 'Trusted X-Forwarded-For addresses, client first' });
        add('Host', entry.host, { hint: 'The host name the client used to reach the server' });
        add('Browser', entry.client);
        add('Flow ID', entry.flowId, { hint: 'Shared by the steps of one two-factor sign-in' });
        add('User agent', entry.userAgent, { wide: true });
        return list;
    }

    async loadRetention() {
        try {
            const settings = await this.api.settings.get();
            if (!this.visible) return;
            if (this.retentionDays) this.retentionDays.value = settings.authLogRetentionDays ?? 90;
            if (this.maxEntries) this.maxEntries.value = settings.authLogMaxEntries ?? 50000;
        } catch {
            if (this.retentionStatus) this.retentionStatus.textContent = 'Retention settings could not be loaded.';
        }
    }

    async saveRetention() {
        if (this.retentionStatus) this.retentionStatus.textContent = 'Saving…';
        try {
            const saved = await this.api.settings.update({
                authLogRetentionDays: Number(this.retentionDays?.value),
                authLogMaxEntries: Number(this.maxEntries?.value)
            });
            if (this.retentionDays) this.retentionDays.value = saved.authLogRetentionDays;
            if (this.maxEntries) this.maxEntries.value = saved.authLogMaxEntries;
            try {
                this.onRetentionSaved?.({
                    authLogRetentionDays: saved.authLogRetentionDays,
                    authLogMaxEntries: saved.authLogMaxEntries
                });
            } catch {
                // Keeping another cache in sync must not hide a successful save.
            }
            if (this.retentionStatus) this.retentionStatus.textContent = 'Retention saved.';
            this.load();
        } catch (error) {
            if (this.retentionStatus) this.retentionStatus.textContent = `Could not save: ${error.message}`;
        }
    }
}

window.AuthLogPanel = AuthLogPanel;
