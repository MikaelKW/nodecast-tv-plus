/**
 * NodeCast TV Plus Application Entry Point
 */

class App {
    constructor() {
        this.currentPage = 'home';
        this.pages = {};
        this.currentUser = null;
        this.navigationSettings = this.getDefaultNavigationSettings();
        this.liveTvSettings = this.getDefaultLiveTvSettings();
        this.lastLiveChannelSave = Promise.resolve();

        // Initialize components
        this.player = new VideoPlayer();
        this.channelList = new ChannelList();
        this.sourceManager = new SourceManager();
        this.epgGuide = new EpgGuide();

        // Initialize page controllers
        this.pages.home = new HomePage(this);
        this.pages.live = new LivePage(this);
        this.pages.guide = new GuidePage(this);
        this.pages.movies = new MoviesPage(this);
        this.pages.series = new SeriesPage(this);
        this.pages.settings = new SettingsPage(this);
        this.pages.account = new AccountPage(this);
        this.pages['mfa-onboarding'] = new MfaOnboardingPage(this);
        this.pages.watch = new WatchPage(this);

        this.init();
    }

    async init() {
        // Check authentication first
        await this.checkAuth();
        await this.loadNavigationSettings();
        this.applyNavigationVisibility();

        // Mobile menu toggle
        const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
        const navbarMenu = document.getElementById('navbar-menu');

        if (mobileMenuToggle && navbarMenu) {
            mobileMenuToggle.addEventListener('click', () => {
                mobileMenuToggle.classList.toggle('active');
                navbarMenu.classList.toggle('active');
            });

            // Close menu when a nav link is clicked
            document.querySelectorAll('.nav-link').forEach(link => {
                link.addEventListener('click', () => {
                    mobileMenuToggle.classList.remove('active');
                    navbarMenu.classList.remove('active');
                });
            });

            // Close menu when clicking outside
            document.addEventListener('click', (e) => {
                if (!e.target.closest('.navbar')) {
                    mobileMenuToggle.classList.remove('active');
                    navbarMenu.classList.remove('active');
                }
            });
        }

        // Channel drawer toggle (mobile)
        const channelToggleBtn = document.getElementById('channel-toggle-btn');
        const channelSidebar = document.getElementById('channel-sidebar');
        const channelOverlay = document.getElementById('channel-sidebar-overlay');

        if (channelToggleBtn && channelSidebar && channelOverlay) {
            const toggleChannelDrawer = () => {
                channelSidebar.classList.toggle('active');
                channelOverlay.classList.toggle('active');
            };

            channelToggleBtn.addEventListener('click', toggleChannelDrawer);
            channelOverlay.addEventListener('click', toggleChannelDrawer);

            // Close drawer when a channel is selected
            channelSidebar.addEventListener('click', (e) => {
                if (e.target.closest('.channel-item')) {
                    // Small delay to let the channel selection happen
                    setTimeout(() => {
                        channelSidebar.classList.remove('active');
                        channelOverlay.classList.remove('active');
                    }, 300);
                }
            });
        }

        // Desktop sidebar collapse toggle
        const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
        const sidebarExpandBtn = document.getElementById('sidebar-expand-btn');
        const homeLayout = document.querySelector('.home-layout');

        const toggleSidebarCollapse = () => {
            channelSidebar?.classList.toggle('collapsed');
            homeLayout?.classList.toggle('sidebar-collapsed');

            // Persist preference
            const isCollapsed = channelSidebar?.classList.contains('collapsed');
            localStorage.setItem('sidebarCollapsed', isCollapsed ? 'true' : 'false');
        };

        sidebarCollapseBtn?.addEventListener('click', toggleSidebarCollapse);
        sidebarExpandBtn?.addEventListener('click', toggleSidebarCollapse);

        // Restore sidebar state from localStorage
        if (localStorage.getItem('sidebarCollapsed') === 'true') {
            channelSidebar?.classList.add('collapsed');
            homeLayout?.classList.add('sidebar-collapsed');
        }

        // Navigation handling
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigateTo(link.dataset.page);
            });
        });

        // Now Playing indicator
        const nowPlayingBtn = document.getElementById('now-playing-indicator');
        if (nowPlayingBtn) {
            nowPlayingBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.navigateTo('watch');
            });
        }

        // Toggle groups button
        document.getElementById('toggle-groups').addEventListener('click', () => {
            this.channelList.toggleAllGroups();
        });

        // Search clear buttons (global handler for all)
        document.querySelectorAll('.search-clear').forEach(btn => {
            btn.addEventListener('click', () => {
                const wrapper = btn.closest('.search-wrapper');
                const input = wrapper?.querySelector('.search-input');
                if (input) {
                    input.value = '';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.focus();
                }
            });
        });

        // Handle browser back/forward buttons
        window.addEventListener('popstate', (e) => {
            const page = e.state?.page || this.navigationSettings.landingPage;
            this.navigateTo(page, true);
        });

        // Initialize home page first (it's needed for channel list)
        await this.pages.home.init();

        // Live TV needs only the currently-airing title. The complete guide is
        // loaded lazily when TV Guide is opened.
        this.epgGuide.fetchNowPlaying()
            .then(() => {
                this.channelList.clearProgramInfoCache();
                this.channelList.updateVisibleEpgInfo?.();
            })
            .catch(err => {
                console.warn('Background EPG load failed:', err.message);
            })
            .finally(() => this.epgGuide.startBackgroundRefresh());

        // Navigate to an explicit page hash or the configured starting page.
        const hash = window.location.hash.slice(1); // Remove #
        const mfaOnboardingPending = NodeCastOnboarding.isMfaPending();
        const requestedPage = hash && this.pages[hash] ? hash : this.navigationSettings.landingPage;
        const autoPlayOnStartup = !mfaOnboardingPending && this.liveTvSettings.autoPlayOnStartup;
        const initialPage = mfaOnboardingPending
            ? 'mfa-onboarding'
            : (autoPlayOnStartup
                ? 'live'
                : (requestedPage === 'mfa-onboarding' ? this.navigationSettings.landingPage : requestedPage));
        this.navigateTo(initialPage, true); // true = replace history (don't add)

        if (autoPlayOnStartup) {
            try {
                await this.pages.live.ensureReady();
                await this.channelList.playStartupChannel(
                    this.liveTvSettings.startupChannelMode,
                    this.currentUser?.lastLiveChannel
                );
            } catch (err) {
                // Live TV remains usable even when the startup channel cannot
                // be resolved or its provider is temporarily unavailable.
                console.warn('[App] Unable to auto-play a startup channel:', err.message);
            }
        }

        console.log('NodeCast TV Plus initialized');
    }

    async checkAuth() {
        const token = localStorage.getItem('authToken');

        try {
            // Verify either the legacy Bearer token or the secure HttpOnly cookie.
            const headers = {};
            if (token) headers.Authorization = `Bearer ${token}`;
            const response = await fetch(NodeCastUrl.resolve('/api/auth/me'), {
                headers
            });

            if (!response.ok) {
                throw new Error('Invalid token');
            }

            this.currentUser = await response.json();
            // The server has migrated any legacy token into an HttpOnly cookie.
            localStorage.removeItem('authToken');

            this.setupAccountMenu();

        } catch (err) {
            console.error('Authentication error:', err);
            localStorage.removeItem('authToken');
            window.location.replace(NodeCastUrl.resolve('/login.html'));
        }
    }

    setupAccountMenu() {
        const menu = document.getElementById('account-menu');
        const trigger = document.getElementById('account-menu-trigger');
        const popover = document.getElementById('account-menu-popover');
        const initial = document.getElementById('account-menu-initial');
        const securityLink = document.getElementById('account-security-link');
        const logoutButton = document.getElementById('logout-btn');
        if (!menu || !trigger || !popover || !initial || !securityLink || !logoutButton) return;

        const username = String(this.currentUser?.username || '').trim();
        initial.textContent = Array.from(username)[0]?.toLocaleUpperCase() || '?';
        trigger.title = username ? `Account: ${username}` : 'Account';

        const closeMenu = () => {
            popover.classList.add('hidden');
            trigger.setAttribute('aria-expanded', 'false');
        };
        const toggleMenu = () => {
            const opening = popover.classList.contains('hidden');
            popover.classList.toggle('hidden', !opening);
            trigger.setAttribute('aria-expanded', String(opening));
            if (opening) securityLink.focus();
        };

        trigger.addEventListener('click', event => {
            event.stopPropagation();
            toggleMenu();
        });
        popover.addEventListener('click', event => event.stopPropagation());
        securityLink.addEventListener('click', () => {
            closeMenu();
            this.closeMobileMenu();
            this.navigateTo('account');
        });
        logoutButton.addEventListener('click', () => this.logout());
        document.addEventListener('click', closeMenu);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !popover.classList.contains('hidden')) {
                closeMenu();
                trigger.focus();
            }
        });
    }

    closeMobileMenu() {
        document.getElementById('mobile-menu-toggle')?.classList.remove('active');
        document.getElementById('navbar-menu')?.classList.remove('active');
    }

    getDefaultNavigationSettings() {
        return {
            landingPage: 'home',
            visibleTabs: {
                home: true,
                live: true,
                guide: true,
                movies: true,
                series: true
            }
        };
    }

    normalizeNavigationSettings(navigation = {}) {
        navigation ||= {};
        const defaults = this.getDefaultNavigationSettings();
        const pages = Object.keys(defaults.visibleTabs);
        const requestedVisibility = navigation.visibleTabs || {};
        const visibleTabs = Object.fromEntries(pages.map(page => [
            page,
            requestedVisibility[page] === undefined
                ? defaults.visibleTabs[page]
                : requestedVisibility[page] !== false
        ]));

        if (!pages.some(page => visibleTabs[page])) visibleTabs.home = true;

        const requestedLanding = pages.includes(navigation.landingPage)
            ? navigation.landingPage
            : defaults.landingPage;
        const landingPage = visibleTabs[requestedLanding]
            ? requestedLanding
            : pages.find(page => visibleTabs[page]);

        return { landingPage, visibleTabs };
    }

    getDefaultLiveTvSettings() {
        return {
            layout: 'grouped',
            order: 'channel-number',
            autoPlayOnStartup: false,
            startupChannelMode: 'last-active'
        };
    }

    normalizeLiveTvSettings(liveTv = {}) {
        return {
            layout: liveTv?.layout === 'flat' ? 'flat' : 'grouped',
            order: liveTv?.order === 'alphabetical' ? 'alphabetical' : 'channel-number',
            autoPlayOnStartup: liveTv?.autoPlayOnStartup === true,
            startupChannelMode: liveTv?.startupChannelMode === 'first-channel'
                ? 'first-channel'
                : 'last-active'
        };
    }

    async loadNavigationSettings() {
        this.liveTvSettings = this.normalizeLiveTvSettings(this.currentUser?.liveTvPreferences);
        this.channelList.setLiveTvSettings(this.liveTvSettings, { reload: false });
        try {
            const settings = await API.settings.get();
            this.navigationSettings = this.normalizeNavigationSettings(settings.navigation);
        } catch (err) {
            console.warn('[App] Failed to load navigation settings, using defaults:', err.message);
        }
    }

    setNavigationSettings(navigation) {
        this.navigationSettings = this.normalizeNavigationSettings(navigation);
        this.applyNavigationVisibility();

        if (this.navigationSettings.visibleTabs[this.currentPage] === false) {
            this.navigateTo(this.navigationSettings.landingPage, true);
        }
    }

    async setLiveTvSettings(liveTv, options = {}) {
        this.liveTvSettings = this.normalizeLiveTvSettings(liveTv);
        await this.channelList.setLiveTvSettings(this.liveTvSettings, options);
    }

    rememberLastLiveChannel(channel) {
        const sourceId = Number(channel?.sourceId);
        const itemId = String(channel?.streamId || '').trim();
        if (!Number.isSafeInteger(sourceId) || sourceId < 1 || !itemId) return;

        const lastLiveChannel = { sourceId, itemId };
        this.currentUser = { ...this.currentUser, lastLiveChannel };
        this.lastLiveChannelSave = this.lastLiveChannelSave
            .catch(() => {})
            .then(() => API.account.updateLastLiveChannel(lastLiveChannel))
            .catch(err => {
                console.warn('[App] Unable to remember the current Live TV channel:', err.message);
            });
    }

    applyNavigationVisibility() {
        document.querySelectorAll('.nav-link[data-page]').forEach(link => {
            const page = link.dataset.page;
            if (!(page in this.navigationSettings.visibleTabs)) return;
            link.classList.toggle('hidden', !this.navigationSettings.visibleTabs[page]);
        });
    }

    resolveNavigationTarget(pageName) {
        if (this.navigationSettings.visibleTabs[pageName] === false) {
            return this.navigationSettings.landingPage;
        }
        return pageName;
    }

    async logout() {
        const token = localStorage.getItem('authToken');
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        await fetch(NodeCastUrl.resolve('/api/auth/logout'), { method: 'POST', headers });

        localStorage.removeItem('authToken');
        window.location.replace(NodeCastUrl.resolve('/login.html?signed_out=1'));
    }

    navigateTo(pageName, replaceHistory = false) {
        pageName = this.resolveNavigationTarget(pageName);

        // Don't navigate if already on this page
        if (this.currentPage === pageName && !replaceHistory) {
            return;
        }

        // Update browser history
        if (replaceHistory) {
            // Replace current history entry (used on initial load)
            history.replaceState({ page: pageName }, '', `#${pageName}`);
        } else {
            // Add new history entry
            history.pushState({ page: pageName }, '', `#${pageName}`);
        }

        // Update nav
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.toggle('active', link.dataset.page === pageName);
        });
        document.getElementById('account-menu-trigger')?.classList.toggle('active', pageName === 'account');

        // Update pages
        document.querySelectorAll('.page').forEach(page => {
            page.classList.toggle('active', page.id === `page-${pageName}`);
        });

        // Notify page controllers
        if (this.pages[this.currentPage]?.hide) {
            this.pages[this.currentPage].hide();
        }

        this.currentPage = pageName;

        if (this.pages[pageName]?.show) {
            this.pages[pageName].show();
        }
    }
}

// Start app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();

    // Fetch and display version badge
    fetch(NodeCastUrl.resolve('/api/version'))
        .then(res => res.json())
        .then(data => {
            const badge = document.getElementById('version-badge');
            if (badge && data.version) badge.textContent = `v${data.version}`;
        })
        .catch(() => { });
});
