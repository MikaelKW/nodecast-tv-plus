/**
 * Channel List Component
 * Handles the sidebar channel list
 */

const BOUNDED_GROUP_PAGE_SIZE = 500;

class ChannelList {
    constructor() {
        this.container = document.getElementById('channel-list');
        this.searchInput = document.getElementById('channel-search');
        this.sourceSelect = document.getElementById('source-select');
        this.showHiddenCheckbox = document.getElementById('show-hidden');
        this.toggleGroupsBtn = document.getElementById('toggle-groups');
        this.contextMenu = document.getElementById('context-menu');

        this.channels = [];
        this.groups = [];
        this.hiddenItems = new Set(); // Set<"type:sourceId:itemId">
        this.collapsedGroups = new Set(); // Track collapsed groups
        this._userExpandedGroups = new Set(); // Track groups user has explicitly expanded
        this.favorites = []; // Array of favorite objects
        this.visibleFavorites = new Set(); // Set<"sourceId:channelId">
        this.currentChannel = null;
        this.sources = [];
        this.sourceCatalogueCache = new Map();
        this.boundedSummaryCache = new Map();
        this.boundedMode = true;
        this.isCatalogueReady = false;
        this.boundedGroups = [];
        this.boundedGroupIndex = new Map();
        this.boundedGroupPages = new Map();
        this.boundedSearchResults = [];
        this.boundedSearchPages = new Map();
        this.boundedSources = [];
        this.favoriteChannels = [];
        this.guideChannels = null;
        this._boundedRequestId = 0;
        this.boundedContinuationObserver = null;
        this.boundedObserverLoadInFlight = false;
        this.boundedLookaheadScrollScheduled = false;
        this.isLoading = false;
        this.loadError = null;
        this.renderedChannels = [];

        this.loadCollapsedState();
        this.init();
    }

    /**
     * Get proxied image URL to avoid mixed content errors on HTTPS
     * Only proxies HTTP URLs when on HTTPS page
     */
    getProxiedImageUrl(url) {
        if (!url || url.length === 0) return 'img/placeholder.png';
        // Only proxy if we're on HTTPS and the image is HTTP
        if (window.location.protocol === 'https:' && url.startsWith('http://')) {
            return NodeCastUrl.resolve(`/api/proxy/image?url=${encodeURIComponent(url)}`);
        }
        return url;
    }

    /**
     * Load collapsed state from localStorage
     */
    loadCollapsedState() {
        try {
            // Keep the legacy storage key so upstream users retain collapsed groups after upgrading.
            const saved = localStorage.getItem('nodecast_tv_collapsed_groups');
            if (saved) {
                this.collapsedGroups = new Set(JSON.parse(saved));
                this._hasCollapsedState = true;
            } else {
                this._hasCollapsedState = false; // First load - will collapse all by default
            }
        } catch (err) {
            console.error('Error loading collapsed state:', err);
            this._hasCollapsedState = false;
        }
    }

    /**
     * Save collapsed state to localStorage
     */
    saveCollapsedState() {
        try {
            localStorage.setItem('nodecast_tv_collapsed_groups', JSON.stringify([...this.collapsedGroups]));
        } catch (err) {
            console.error('Error saving collapsed state:', err);
        }
    }

    /**
     * Toggle group collapsed state
     */
    toggleGroup(groupName) {
        if (this.collapsedGroups.has(groupName)) {
            this.collapsedGroups.delete(groupName);
            // Track that user explicitly expanded this group
            this._userExpandedGroups.add(groupName);
        } else {
            this.collapsedGroups.add(groupName);
            // User collapsed it, remove from expanded tracking
            this._userExpandedGroups.delete(groupName);
        }
        this.saveCollapsedState();
    }

    /**
     * Expand all groups
     */
    expandAll() {
        if (this.boundedMode) {
            // Mark every header as expanded, but let the viewport observer
            // fetch each group's first bounded page only as it approaches the
            // visible area. This preserves Expand All semantics without
            // materializing an entire large provider catalogue at once.
            for (const group of this.boundedGroups) {
                const groupName = group.name;
                this.collapsedGroups.delete(groupName);
                this._userExpandedGroups.add(groupName);
            }
            this.saveCollapsedState();
            this.renderBounded();
            return;
        }
        this.collapsedGroups.clear();
        this.saveCollapsedState();

        // Expand all and render channels for empty containers
        this.container.querySelectorAll('.group-header.collapsed').forEach(h => {
            h.classList.remove('collapsed');
            const groupName = h.dataset.group;
            const groupEl = h.closest('.channel-group');
            const channelsContainer = groupEl?.querySelector('.group-channels');
            if (channelsContainer && channelsContainer.children.length === 0) {
                this.renderGroupChannels(groupName, channelsContainer);
            }
        });

        // Update toggle button
        if (this.toggleGroupsBtn) {
            this.toggleGroupsBtn.innerHTML = Icons.collapseAll;
            this.toggleGroupsBtn.title = 'Collapse All';
        }
    }

    /**
     * Collapse all groups
     */
    collapseAll() {
        if (this.boundedMode) {
            for (const group of this.boundedGroups) {
                this.collapsedGroups.add(group.name);
                this._userExpandedGroups.delete(group.name);
            }
            this.saveCollapsedState();
            this.renderBounded();
            return;
        }
        this.container.querySelectorAll('.group-header').forEach(h => {
            const groupName = h.dataset.group;
            this.collapsedGroups.add(groupName);
            h.classList.add('collapsed');
        });
        this.saveCollapsedState();

        // Update toggle button
        if (this.toggleGroupsBtn) {
            this.toggleGroupsBtn.innerHTML = Icons.expandAll;
            this.toggleGroupsBtn.title = 'Expand All';
        }
    }

    /**
     * Toggle between expand/collapse all
     */
    toggleAllGroups() {
        if (this.boundedMode) {
            const allCollapsed = this.boundedGroups.length > 0
                && this.boundedGroups.every(group => this.collapsedGroups.has(group.name));
            if (allCollapsed) {
                this.expandAll();
            } else {
                this.collapseAll();
            }
            return;
        }
        const allHeaders = this.container.querySelectorAll('.group-header');
        const allCollapsed = [...allHeaders].every(h => h.classList.contains('collapsed'));

        if (allCollapsed) {
            this.expandAll();
        } else {
            this.collapseAll();
        }
    }

    init() {
        // Search handler (debounced)
        let searchTimeout;
        this.searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                if (this.boundedMode) {
                    this.loadBoundedSearch().catch(err => {
                        console.error('Error searching live catalogue:', err);
                    });
                } else {
                    this.render();
                }
            }, 300);
        });

        // Source filter handler
        this.sourceSelect.addEventListener('change', () => this.loadChannels());

        // Prepare one additional group page after the user starts scrolling an
        // expanded large group. The page stays outside the rendered channel
        // list until the continuation boundary is reached, which keeps the DOM
        // bounded while making ordinary scrolling less likely to catch up with
        // the provider request.
        this.container.addEventListener('scroll', () => this._scheduleBoundedGroupLookahead());

        // Show hidden toggle
        if (this.showHiddenCheckbox) {
            this.showHiddenCheckbox.addEventListener('change', () => this.render());
        }

        // Context menu handlers
        document.addEventListener('click', (e) => {
            // Don't close if clicking inside context menu
            if (!this.contextMenu.contains(e.target)) {
                this.hideContextMenu();
            }
        });

        this.contextMenu.querySelectorAll('.context-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent document click from firing
                this.handleContextAction(e);
            });
        });

        // Intersection Observer for lazy loading
        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                this.renderNextBatch();
            }
        }, { rootMargin: '100px' });

        // Start EPG refresh timer (updates visible program info every 60 seconds)
        this.startEpgRefreshTimer();
    }

    /**
     * Start timer to refresh EPG info in visible channel items
     * Updates every 60 seconds to keep "Now Playing" program info current
     */
    startEpgRefreshTimer() {
        // Clear any existing timer
        if (this._epgRefreshTimer) {
            clearInterval(this._epgRefreshTimer);
        }

        // Refresh every 60 seconds
        this._epgRefreshTimer = setInterval(() => {
            this.updateVisibleEpgInfo();
        }, 60000);
    }

    /**
     * Update EPG info for visible channel items without full re-render
     * Only updates the program text, not the entire channel item
     */
    updateVisibleEpgInfo() {
        if (!window.app || !window.app.epgGuide) return;

        // Clear the cache so we get fresh data
        this.clearProgramInfoCache();

        // Find all visible channel items and update their program info
        const channelItems = this.container.querySelectorAll('.channel-item');
        channelItems.forEach(item => {
            const channelId = item.dataset.channelId;
            const sourceId = item.dataset.sourceId;

            // Find the channel data
            const channel = this.channels.find(c =>
                String(c.id) === String(channelId) &&
                String(c.sourceId) === String(sourceId)
            );

            if (channel) {
                const programInfo = this.getProgramInfo(channel);
                const programElement = item.querySelector('.channel-program');
                if (programElement) {
                    programElement.textContent = programInfo || '';
                }
            }
        });
    }

    // ... (loadSources, loadChannels, loadAllChannels, loadXtreamChannels, loadM3uChannels, loadHiddenItems, isHidden, loadFavorites, isFavorite, toggleFavorite methods remain same)

    /**
     * Get current program info string - cached for performance
     */
    getProgramInfo(channel) {
        try {
            if (!window.app || !window.app.epgGuide) return null;

            // Cache key: channel_id + current_minute (invalidate every minute)
            const currentMinute = Math.floor(Date.now() / 60000);
            const cacheKey = `${channel.tvgId || channel.name}:${currentMinute}`;

            if (this._programInfoCache && this._programInfoCache.has(cacheKey)) {
                return this._programInfoCache.get(cacheKey);
            }

            // Clear old cache entries if minute changed
            if (!this._lastCacheMinute || this._lastCacheMinute !== currentMinute) {
                this._programInfoCache = new Map();
                this._lastCacheMinute = currentMinute;
            }

            const program = window.app.epgGuide.getCurrentProgram(channel.tvgId, channel.name);
            const result = program ? program.title : null;

            this._programInfoCache.set(cacheKey, result);
            return result;
        } catch (e) {
            console.warn("Error in getProgramInfo", e);
            return null;
        }
    }

    /**
     * Clear program info cache
     * Useful when EPG data has been updated
     */
    clearProgramInfoCache() {
        if (this._programInfoCache) {
            this._programInfoCache.clear();
        }
    }

    escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    /**
     * Render channel list
     */
    render() {
        if (this.boundedMode) {
            this.renderBounded();
            return;
        }
        if (this.isLoading) {
            this.container.innerHTML = '<div class="loading"></div>';
            this.renderedChannels = [];
            return;
        }
        if (this.loadError) {
            this.container.innerHTML = `<div class="empty-state"><p>Error loading channels</p><p class="hint">${this.escapeHtml(this.loadError)}</p></div>`;
            this.renderedChannels = [];
            return;
        }

        const searchTerm = this.searchInput.value.toLowerCase();
        const showHidden = this.showHiddenCheckbox ? this.showHiddenCheckbox.checked : false;

        // Reset batching
        this.currentBatch = 0;
        this.batchSize = 100; // Number of groups to render per batch (increased to handle many hidden groups)
        this.container.innerHTML = ''; // Clear container

        // Filter and Group channels
        const groupedChannels = {};

        // 1. Filter
        this.filteredChannels = this.channels;
        if (searchTerm) {
            this.filteredChannels = this.channels.filter(ch =>
                String(ch.name ?? "").toLowerCase().includes(searchTerm) ||
                String(ch.groupTitle ?? "").toLowerCase().includes(searchTerm)
            );
        }

        let filteredChannels = this.filteredChannels;

        // 2. Group
        filteredChannels.forEach(ch => {
            const groupKey = ch.groupTitle || 'Uncategorized';
            if (!groupedChannels[groupKey]) {
                groupedChannels[groupKey] = [];
            }
            groupedChannels[groupKey].push(ch);
        });

        // 3. Add Favorites
        const favoritedChannels = this.channels.filter(ch => {
            const rawChannelId = ch.streamId || ch.id;
            return this.isFavorite(ch.sourceId, ch.id)
                && !this.isHidden('channel', ch.sourceId, rawChannelId);
        });
        if (favoritedChannels.length > 0) {
            favoritedChannels.sort((a, b) => a.name.localeCompare(b.name));
            groupedChannels['Favorites'] = favoritedChannels;
        }

        // 4. Sort Groups and filter to only those with visible channels
        const allGroups = Object.keys(groupedChannels).sort((a, b) => {
            if (a === 'Favorites') return -1;
            if (b === 'Favorites') return 1;
            return a.localeCompare(b);
        });

        // Pre-filter to only include groups with visible channels (so hidden groups don't consume batch slots)
        this.sortedGroups = allGroups.filter(groupName => {
            if (groupName === 'Favorites') return true;
            const channels = groupedChannels[groupName];
            // Check if any channel in this group is visible
            return channels.some(channel => {
                const rawChannelId = channel.streamId || channel.id;
                const isHidden = this.isHidden('channel', channel.sourceId, rawChannelId);
                return !isHidden || showHidden;
            });
        });

        this.groupedChannels = groupedChannels;
        this.showHidden = showHidden;

        // Collapse all groups by default on first load (for large playlists)
        // This prevents rendering 100K+ channel items on initial load
        if (!this._hasCollapsedState && this.sortedGroups.length > 0) {
            this.sortedGroups.forEach(groupName => {
                if (groupName !== 'Favorites') {
                    this.collapsedGroups.add(groupName);
                }
            });
            this._hasCollapsedState = true;
            this.saveCollapsedState();
        }

        // Build rendered channel list for navigation (matches visual order)
        this.renderedChannels = [];
        this.sortedGroups.forEach(groupName => {
            const channels = this.groupedChannels[groupName];
            const isFavoritesGroup = groupName === 'Favorites';

            const visibleChannels = channels.filter(channel => {
                if (isFavoritesGroup) return true;
                const rawChannelId = channel.streamId || channel.id;
                const channelHidden = this.isHidden('channel', channel.sourceId, rawChannelId);
                return !channelHidden || this.showHidden;
            });

            // Assign unique render IDs for linear navigation
            visibleChannels.forEach(ch => {
                // We clone the object for the rendered list to attach the unique ID
                // ensuring no side effects on the main channel object
                const renderedCh = {
                    ...ch,
                    _renderId: `rid_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    _renderGroup: groupName // Track visual group for navigation
                };
                this.renderedChannels.push(renderedCh);
            });
        });

        // Empty State
        if (this.sortedGroups.length === 0) {
            this.container.innerHTML = `
        <div class="empty-state">
          <p>${searchTerm ? 'No channels match your search' : 'No channels loaded'}</p>
          <p class="hint">${searchTerm ? 'Try a different search term' : 'Add a source in Settings to get started'}</p>
        </div>
      `;
            return;
        }

        // Wrap container content in a specific list div to append to
        this.listContainer = document.createElement('div');
        this.listContainer.className = 'channel-list-content';
        this.container.appendChild(this.listContainer);

        // Add loader element at bottom
        this.loader = document.createElement('div');
        this.loader.className = 'batch-loader';
        this.loader.innerHTML = '<div class="loading-spinner"></div>';
        this.loader.style.opacity = '0'; // Hide initially
        this.container.appendChild(this.loader);

        // Render initial batches - load just enough to fill visible area + buffer
        // Reduced from 10 to 2 to significantly speed up initial load time for large lists
        const maxInitialBatches = 2;
        for (let i = 0; i < maxInitialBatches; i++) {
            if (this.currentBatch * this.batchSize >= this.sortedGroups.length) break;
            this.renderNextBatch();
        }

        // Start observing loader for additional batches
        this.observer.observe(this.loader);
    }

    /**
     * Render next batch of groups
     */
    renderNextBatch() {
        const start = this.currentBatch * this.batchSize;
        const end = start + this.batchSize;
        const groupsToRender = this.sortedGroups.slice(start, end);

        if (groupsToRender.length === 0) {
            // No more groups
            this.loader.style.display = 'none';
            return;
        }

        this.loader.style.opacity = '1';
        let html = '';

        let renderIndex = start; // Keep track of global index for mapping to renderedChannels

        for (const groupName of groupsToRender) {
            const channels = this.groupedChannels[groupName];
            if (channels.length === 0) continue;

            const isFavoritesGroup = groupName === 'Favorites';

            // Pre-filter visible channels for this group
            const visibleChannels = channels.filter(channel => {
                if (isFavoritesGroup) return true;
                const rawChannelId = channel.streamId || channel.id;
                const channelHidden = this.isHidden('channel', channel.sourceId, rawChannelId);
                return !channelHidden || this.showHidden;
            });

            // Skip group if no visible channels (derived visibility)
            if (visibleChannels.length === 0) continue;

            // Default new groups to collapsed (except Favorites)
            // This handles groups loaded via scroll that weren't in the initial collapse
            if (!isFavoritesGroup && !this.collapsedGroups.has(groupName) && !this._userExpandedGroups?.has(groupName)) {
                this.collapsedGroups.add(groupName);
            }

            html += `
        <div class="channel-group">
          <div class="group-header ${this.collapsedGroups.has(groupName) ? 'collapsed' : ''} ${isFavoritesGroup ? 'favorites-group' : ''}" data-group="${groupName}">
            <span class="group-toggle">${Icons.chevronDown}</span>
            <span class="group-name">${groupName}</span>
            <span class="group-count">${visibleChannels.length}</span>
          </div>
          <div class="group-channels">
      `;

            // Skip rendering channel items if group is collapsed (major performance optimization)
            // Channels will be rendered when user expands the group
            if (this.collapsedGroups.has(groupName)) {
                html += '</div></div>';
                continue;
            }


            for (const channel of visibleChannels) {
                // Check hidden again for styling (showHidden mode)
                const rawChannelId = channel.streamId || channel.id;
                const channelHidden = !isFavoritesGroup && this.isHidden('channel', channel.sourceId, rawChannelId);

                const isActive = this.currentChannel?.id === channel.id;
                // Check if this specific instance is the "active" one for navigation purposes
                const isRenderActive = this.currentRenderId && this.renderedChannels[renderIndex]?._renderId === this.currentRenderId;

                const isFavorite = this.isFavorite(channel.sourceId, channel.id);
                const renderId = this.renderedChannels[renderIndex]?._renderId || '';
                const renderGroup = this.renderedChannels[renderIndex]?._renderGroup || groupName;
                renderIndex++;

                html += `
          <div class="channel-item ${isActive ? 'active' : ''} ${isRenderActive ? 'nav-active' : ''} ${channelHidden ? 'hidden' : ''}" 
               data-channel-id="${channel.id}"
               data-source-id="${channel.sourceId}"
               data-source-type="${channel.sourceType}"
               data-stream-id="${channel.streamId || ''}"
               data-url="${channel.url || ''}"
               data-render-id="${renderId}"
               data-render-group="${renderGroup}">
            <img class="channel-logo" src="${this.getProxiedImageUrl(channel.tvgLogo)}" 
                 alt="" onerror="this.onerror=null;this.src='img/placeholder.png'">
            <div class="channel-info">
              <div class="channel-name">${this.escapeHtml(channel.name)}</div>
              <div class="channel-program">${this.escapeHtml(this.getProgramInfo(channel) || '')}</div>
            </div>
            <button class="favorite-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
              ${isFavorite ? Icons.favorite : Icons.favoriteOutline}
            </button>
          </div>
        `;
            }
            html += '</div></div>';
        }

        // Append to list container
        // Use temp div to parse HTML string
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;

        while (tempDiv.firstElementChild) {
            const groupEl = tempDiv.firstElementChild;
            this.attachGroupListeners(groupEl);
            this.listContainer.appendChild(groupEl);
        }

        this.currentBatch++;

        // Hide loader if we might be done (next batch check will confirm)
        if (end >= this.sortedGroups.length) {
            this.loader.style.display = 'none';
        }
    }

    attachGroupListeners(groupEl) {
        const header = groupEl.querySelector('.group-header');
        if (header) {
            header.addEventListener('click', () => {
                const groupName = header.dataset.group;
                const isCollapsed = header.classList.contains('collapsed');

                header.classList.toggle('collapsed');
                this.toggleGroup(groupName);

                // If expanding, render channels if they weren't rendered initially
                if (isCollapsed) {
                    const channelsContainer = groupEl.querySelector('.group-channels');
                    if (channelsContainer && channelsContainer.children.length === 0) {
                        // Channels weren't rendered - render them now
                        this.renderGroupChannels(groupName, channelsContainer);
                    }
                }
            });
            header.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'group', header.dataset));
        }

        groupEl.querySelectorAll('.channel-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.favorite-btn')) return;
                this.selectChannel(item.dataset);
            });
            item.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'channel', item.dataset));

            const favBtn = item.querySelector('.favorite-btn');
            if (favBtn) {
                favBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleFavorite(parseInt(item.dataset.sourceId), item.dataset.channelId);
                });
            }
        });
    }

    /**
     * Render channels for a specific group (called when expanding a collapsed group)
     */
    renderGroupChannels(groupName, container) {
        const channels = this.groupedChannels[groupName];
        if (!channels || channels.length === 0) return;

        const isFavoritesGroup = groupName === 'Favorites';

        // Filter visible channels
        const visibleChannels = channels.filter(channel => {
            if (isFavoritesGroup) return true;
            const rawChannelId = channel.streamId || channel.id;
            const channelHidden = this.isHidden('channel', channel.sourceId, rawChannelId);
            return !channelHidden || this.showHidden;
        });

        let html = '';
        for (const channel of visibleChannels) {
            const rawChannelId = channel.streamId || channel.id;
            const channelHidden = !isFavoritesGroup && this.isHidden('channel', channel.sourceId, rawChannelId);
            const isActive = this.currentChannel?.id === channel.id;
            const isFavorite = this.isFavorite(channel.sourceId, channel.id);

            // Find the matching rendered channel to get its unique IDs
            const renderedChannel = this.renderedChannels.find(rc =>
                rc.id === channel.id && rc.sourceId === channel.sourceId && rc._renderGroup === groupName
            );
            const renderId = renderedChannel?._renderId || '';
            const renderGroup = renderedChannel?._renderGroup || groupName;

            html += `
          <div class="channel-item ${isActive ? 'active' : ''} ${channelHidden ? 'hidden' : ''}" 
               data-channel-id="${channel.id}"
               data-source-id="${channel.sourceId}"
               data-source-type="${channel.sourceType}"
               data-stream-id="${channel.streamId || ''}"
               data-url="${channel.url || ''}"
               data-render-id="${renderId}"
               data-render-group="${renderGroup}">
            <img class="channel-logo" src="${this.getProxiedImageUrl(channel.tvgLogo)}" 
                 alt="" onerror="this.onerror=null;this.src='img/placeholder.png'">
            <div class="channel-info">
              <div class="channel-name">${this.escapeHtml(channel.name)}</div>
              <div class="channel-program">${this.escapeHtml(this.getProgramInfo(channel) || '')}</div>
            </div>
            <button class="favorite-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
              ${isFavorite ? Icons.favorite : Icons.favoriteOutline}
            </button>
          </div>
        `;
        }

        container.innerHTML = html;

        // Attach listeners to the new channel items
        container.querySelectorAll('.channel-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.favorite-btn')) return;
                this.selectChannel(item.dataset);
            });
            item.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'channel', item.dataset));

            const favBtn = item.querySelector('.favorite-btn');
            if (favBtn) {
                favBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleFavorite(parseInt(item.dataset.sourceId), item.dataset.channelId);
                });
            }
        });
    }

    /**
     * Load sources into dropdown
     */
    async loadSources() {
        try {
            this.sources = await API.sources.getAll();
            console.log('[ChannelList] loadSources: Got', this.sources?.length || 0, 'sources');
            this.sourceSelect.innerHTML = '<option value="">All Sources</option>';

            const xtreamSources = this.sources.filter(s => s.type === 'xtream' && s.enabled && API.sources.isVisibleIn(s, 'live'));
            const m3uSources = this.sources.filter(s => s.type === 'm3u' && s.enabled && API.sources.isVisibleIn(s, 'live'));

            if (xtreamSources.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = 'Xtream';
                xtreamSources.forEach(s => {
                    const option = document.createElement('option');
                    option.value = `xtream:${s.id}`;
                    option.textContent = s.name;
                    optgroup.appendChild(option);
                });
                this.sourceSelect.appendChild(optgroup);
            }

            if (m3uSources.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = 'M3U';
                m3uSources.forEach(s => {
                    const option = document.createElement('option');
                    option.value = `m3u:${s.id}`;
                    option.textContent = s.name;
                    optgroup.appendChild(option);
                });
                this.sourceSelect.appendChild(optgroup);
            }
        } catch (err) {
            console.error('Error loading sources:', err);
        }
    }

    /**
     * Load channels from selected source
     */
    async loadChannels() {
        if (this.boundedMode) {
            return this.loadBoundedChannels();
        }
        return this.loadLegacyChannels();
    }

    async loadLegacyChannels() {
        if (this.isLoading) return;
        this.isLoading = true;
        this.loadError = null;
        this.currentRenderId = null; // Reset render tracking

        const sourceValue = this.sourceSelect.value;
        const self = this;

        if (!sourceValue) {
            // Load from all sources
            await this.loadAllChannels();
            this.isLoading = false;
            return;
        }

        const [type, id] = sourceValue.split(':');

        try {
            this.container.innerHTML = '<div class="loading"></div>';

            if (type === 'xtream') {
                await this.loadXtreamChannels(parseInt(id));
            } else if (type === 'm3u') {
                await this.loadM3uChannels(parseInt(id));
            }

            // Provider endpoints already return visible content only. Loading
            // every hidden item separately can be enormous for providers where
            // most of the catalogue is hidden.
            this.hiddenItems = new Set();
            await this.loadFavorites();

            this.isLoading = false;
            this.render();
        } catch (err) {
            console.error('Error loading channels:', err);
            this.loadError = err.message || 'Unable to load channels';
            this.isLoading = false;
            this.render();
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Load channels from all enabled sources
     */
    async loadAllChannels() {
        try {
            this.container.innerHTML = '<div class="loading"></div>';

            const xtreamSources = this.sources.filter(s => s.type === 'xtream' && s.enabled && API.sources.isVisibleIn(s, 'live'));
            const m3uSources = this.sources.filter(s => s.type === 'm3u' && s.enabled && API.sources.isVisibleIn(s, 'live'));
            console.log('[ChannelList] loadAllChannels: xtream=', xtreamSources.length, 'm3u=', m3uSources.length);

            const sourceDescriptors = [
                ...xtreamSources.map(source => ({ source, type: 'xtream' })),
                ...m3uSources.map(source => ({ source, type: 'm3u' }))
            ];
            const fetchSource = descriptor =>
                this.fetchSourceChannels(descriptor.source.id, descriptor.type);

            const [initialResults] = await Promise.all([
                Promise.allSettled(sourceDescriptors.map(fetchSource)),
                this.loadFavorites()
            ]);
            this.hiddenItems = new Set();
            const sourceResults = [...initialResults];
            const failedIndexes = sourceResults
                .map((result, index) => result.status === 'rejected' ? index : -1)
                .filter(index => index !== -1);

            if (failedIndexes.length > 0) {
                console.warn(`[ChannelList] Retrying ${failedIndexes.length} unavailable source(s)`);
                await new Promise(resolve => setTimeout(resolve, 250));
                const retryResults = await Promise.allSettled(
                    failedIndexes.map(index => fetchSource(sourceDescriptors[index]))
                );
                retryResults.forEach((result, retryIndex) => {
                    sourceResults[failedIndexes[retryIndex]] = result;
                });
            }

            const nextCatalogue = { groups: [], channels: [] };
            let availableSources = 0;
            sourceResults.forEach((result, index) => {
                const descriptor = sourceDescriptors[index];
                if (result.status === 'fulfilled') {
                    this._cacheSourceChannels(descriptor.source.id, descriptor.type, result.value);
                    this._appendSourceChannels(nextCatalogue, result.value);
                    availableSources += 1;
                    return;
                }

                const source = descriptor?.source;
                console.error(`Error loading source ${source?.id}:`, result.reason);

                const cached = this._getCachedSourceChannels(source?.id, descriptor?.type);
                if (cached) {
                    console.warn(`Using last known channel catalogue for source ${source?.id}`);
                    this._appendSourceChannels(nextCatalogue, cached);
                    availableSources += 1;
                }
            });

            if (sourceDescriptors.length > 0 && availableSources === 0) {
                throw new Error('Unable to load channels from any enabled source');
            }

            this.groups = nextCatalogue.groups;
            this.channels = nextCatalogue.channels;
            this.isLoading = false;
            this.render();
        } catch (err) {
            console.error('Error loading all channels:', err);
            this.loadError = err.message || 'Unable to load channels';
            this.isLoading = false;
            this.render();
        }
    }

    /**
     * Load Xtream channels
     */
    async loadXtreamChannels(sourceId, append = false) {
        if (!append) {
            this.channels = [];
            this.groups = [];
        }

        const result = await this.fetchSourceChannels(sourceId, 'xtream');
        this._cacheSourceChannels(sourceId, 'xtream', result);
        this._applySourceChannels(result);
    }

    /**
     * Load M3U channels
     * Now uses unified Xtream-style API endpoints (backend supports both source types)
     */
    async loadM3uChannels(sourceId, append = false) {
        if (!append) {
            this.channels = [];
            this.groups = [];
        }

        const result = await this.fetchSourceChannels(sourceId, 'm3u');
        this._cacheSourceChannels(sourceId, 'm3u', result);
        this._applySourceChannels(result);
    }

    /**
     * Fetch and map one source without mutating shared channel-list state.
     * This lets independent providers load concurrently while preserving their
     * configured display order when the results are applied.
     */
    async fetchSourceChannels(sourceId, sourceType) {
        const [categories, streams] = await Promise.all([
            API.proxy.xtream.liveCategories(sourceId),
            API.proxy.xtream.liveStreams(sourceId)
        ]);
        const categoryNames = new Map(
            categories.map(category => [String(category.category_id), category.category_name])
        );

        const groups = categories.map(category => ({
            id: `${sourceType}_${sourceId}_${category.category_id}`,
            name: category.category_name,
            sourceId,
            sourceType
        }));
        const channels = streams.map(stream => ({
            id: `${sourceType}_${sourceId}_${stream.stream_id}`,
            streamId: stream.stream_id,
            name: stream.name,
            tvgId: stream.epg_channel_id,
            tvgLogo: stream.stream_icon,
            ...(sourceType === 'm3u' ? { url: stream.stream_url } : {}),
            groupId: `${sourceType}_${sourceId}_${stream.category_id}`,
            groupTitle: categoryNames.get(String(stream.category_id)) || 'Uncategorized',
            sourceId,
            sourceType
        }));

        return { groups, channels };
    }

    _applySourceChannels(result) {
        this.groups = this.groups.concat(result.groups);
        this.channels = this.channels.concat(result.channels);
    }

    _appendSourceChannels(target, result) {
        // Avoid passing an entire provider catalogue as variadic arguments.
        // Chromium rejects sufficiently large argument lists (for example a
        // 280,000-channel M3U) with "Maximum call stack size exceeded".
        for (const group of result.groups) {
            target.groups.push(group);
        }
        for (const channel of result.channels) {
            target.channels.push(channel);
        }
    }

    _sourceCatalogueCacheKey(sourceId, sourceType) {
        return `${sourceType}:${sourceId}`;
    }

    _cacheSourceChannels(sourceId, sourceType, result) {
        this.sourceCatalogueCache.set(
            this._sourceCatalogueCacheKey(sourceId, sourceType),
            {
                groups: [...result.groups],
                channels: [...result.channels]
            }
        );
    }

    _getCachedSourceChannels(sourceId, sourceType) {
        if (sourceId === undefined || !sourceType) return null;
        return this.sourceCatalogueCache.get(
            this._sourceCatalogueCacheKey(sourceId, sourceType)
        ) || null;
    }

    /**
     * Load hidden items
     */
    async loadHiddenItems() {
        try {
            const items = await API.channels.getHidden();
            this.hiddenItems = new Set(items.map(i => `${i.item_type}:${i.source_id}:${i.item_id}`));
        } catch (err) {
            console.error('Error loading hidden items:', err);
        }
    }

    /**
     * Check if item is hidden
     */
    isHidden(type, sourceId, itemId) {
        return this.hiddenItems.has(`${type}:${sourceId}:${itemId}`);
    }

    /**
     * Load favorites
     */
    async loadFavorites() {
        try {
            // Get all favorites (filtered for channels or legacy items without type)
            const allFavs = await API.favorites.getAll();
            const channelFavs = allFavs.filter(f => !f.item_type || f.item_type === 'channel');

            this.visibleFavorites = new Set(
                channelFavs.map(f => `${f.source_id}:${f.item_id || f.channel_id}`)
            );
        } catch (err) {
            console.error('Error loading favorites:', err);
        }
    }

    /**
     * Check if channel is favorite
     */
    isFavorite(sourceId, channelId) {
        return this.visibleFavorites.has(`${sourceId}:${channelId}`);
    }

    /**
     * Toggle favorite status
     */
    async toggleFavorite(sourceId, channelId) {
        const key = `${sourceId}:${channelId}`;
        const wasFavorite = this.visibleFavorites.has(key);

        // Find all buttons for this channel in the DOM (it may appear in multiple groups)
        const btns = document.querySelectorAll(`.channel-item[data-channel-id="${channelId}"][data-source-id="${sourceId}"] .favorite-btn`);

        try {
            // Optimistic update
            if (wasFavorite) {
                this.visibleFavorites.delete(key);
                btns.forEach(btn => {
                    btn.classList.remove('active');
                    btn.innerHTML = Icons.favoriteOutline;
                    btn.title = 'Add to Favorites';
                });
            } else {
                this.visibleFavorites.add(key);
                btns.forEach(btn => {
                    btn.classList.add('active');
                    btn.innerHTML = Icons.favorite;
                    btn.title = 'Remove from Favorites';
                });
            }

            // Updates Favorites Group DOM
            const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
            if (channel) {
                this.updateFavoritesGroup(channel, !wasFavorite);
            }
            // Do NOT call this.render() - it causes lag

            // Perform API call
            if (wasFavorite) {
                await API.favorites.remove(sourceId, channelId, 'channel');
            } else {
                await API.favorites.add(sourceId, channelId, 'channel');
            }

            // Sync to EPG Guide
            if (window.app?.epgGuide) {
                window.app.epgGuide.syncFavorite(sourceId, channelId, !wasFavorite);
            }
        } catch (err) {
            console.error('Error toggling favorite:', err);
            // Revert on error
            if (wasFavorite) {
                this.visibleFavorites.add(key);
                btns.forEach(btn => {
                    btn.classList.add('active');
                    btn.innerHTML = Icons.favorite;
                });
                // Revert group update
                const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
                if (channel) this.updateFavoritesGroup(channel, true);
            } else {
                this.visibleFavorites.delete(key);
                btns.forEach(btn => {
                    btn.classList.remove('active');
                    btn.innerHTML = Icons.favoriteOutline;
                });
                // Revert group update
                const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
                if (channel) this.updateFavoritesGroup(channel, false);
            }
        }
    }

    /**
     * Update Favorites group in DOM and data
     */
    updateFavoritesGroup(channel, isAdded) {
        if (this.boundedMode) {
            const existingIndex = this.favoriteChannels.findIndex(item =>
                item.id === channel.id && String(item.sourceId) === String(channel.sourceId)
            );
            if (isAdded && existingIndex === -1) {
                this.favoriteChannels.push(channel);
                this.favoriteChannels.sort((a, b) => a.name.localeCompare(b.name));
            } else if (!isAdded && existingIndex !== -1) {
                this.favoriteChannels.splice(existingIndex, 1);
            }
            this.renderBounded();
            return;
        }

        // 1. Update Data
        if (!this.groupedChannels['Favorites']) {
            this.groupedChannels['Favorites'] = [];
        }

        const favArray = this.groupedChannels['Favorites'];
        const existingIdx = favArray.findIndex(c => c.id === channel.id && c.sourceId === channel.sourceId);

        if (isAdded) {
            if (existingIdx === -1) favArray.push(channel);
        } else {
            if (existingIdx !== -1) favArray.splice(existingIdx, 1);
        }

        // 2. Update DOM
        const groupHeader = this.listContainer.querySelector('.group-header[data-group="Favorites"]');

        if (!groupHeader) {
            // If group doesn't exist and we're adding, we ideally should create it
            // For now, simpler to just return. User will see it on next refresh.
            // Or we could force a re-render if it's the first favorite? 
            if (isAdded && favArray.length === 1) {
                this.render(); // This is the one case where full render is worth it
            }
            return;
        }

        const groupChannels = groupHeader.nextElementSibling; // .group-channels
        const countSpan = groupHeader.querySelector('.group-count');

        if (isAdded) {
            // Check if already in DOM (to avoid dupes)
            const existingEl = groupChannels.querySelector(`.channel-item[data-channel-id="${channel.id}"][data-source-id="${channel.sourceId}"]`);
            if (!existingEl) {
                const newEl = this.createChannelElement(channel);
                groupChannels.appendChild(newEl);
            }
        } else {
            const existingEl = groupChannels.querySelector(`.channel-item[data-channel-id="${channel.id}"][data-source-id="${channel.sourceId}"]`);
            if (existingEl) {
                existingEl.remove();
            }
        }

        // Update count
        if (countSpan) countSpan.textContent = favArray.length;

        // Hide/Show group if empty?
        if (favArray.length === 0) {
            groupHeader.classList.add('hidden'); // Or remove
            groupHeader.style.display = 'none';
        } else {
            groupHeader.classList.remove('hidden');
            groupHeader.style.display = '';
        }
    }

    createChannelElement(channel) {
        const div = document.createElement('div');
        const isActive = this.currentChannel?.id === channel.id;
        // In Favorites group, it IS a favorite
        const isFavorite = true;

        div.className = `channel-item ${isActive ? 'active' : ''}`;
        div.dataset.channelId = channel.id;
        div.dataset.sourceId = channel.sourceId;
        div.dataset.sourceType = channel.sourceType;
        div.dataset.streamId = channel.streamId || '';
        div.dataset.url = channel.url || '';

        div.innerHTML = `
            <img class="channel-logo" src="${this.getProxiedImageUrl(channel.tvgLogo)}" 
                 alt="" onerror="this.onerror=null;this.src='img/placeholder.png'">
            <div class="channel-info">
              <div class="channel-name">${this.escapeHtml(channel.name)}</div>
              <div class="channel-program">${this.getProgramInfo(channel) || ''}</div>
            </div>
            <button class="favorite-btn active" title="Remove from Favorites">
              ❤️
            </button>
        `;

        // Attach listeners
        div.addEventListener('click', (e) => {
            if (e.target.closest('.favorite-btn')) return;
            // Pass the render ID from the dataset
            this.selectChannel({ ...div.dataset, renderId: div.dataset.renderId });
        });
        div.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'channel', div.dataset));

        const favBtn = div.querySelector('.favorite-btn');
        if (favBtn) {
            favBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleFavorite(parseInt(div.dataset.sourceId), div.dataset.channelId);
            });
        }

        return div;
    }

    /**
     * Select and play a channel
     */
    async selectChannel(dataset) {
        const channel = this.channels.find(c => c.id === dataset.channelId);
        if (!channel) return;

        this.currentChannel = channel;
        this.currentRenderId = dataset.renderId; // Track which visual instance is active
        this.currentRenderGroup = dataset.renderGroup; // Track which group the selection came from

        // Update active state in DOM
        this.container.querySelectorAll('.channel-item.active').forEach(el => {
            el.classList.remove('active');
            el.classList.remove('nav-active');
        });

        // Try to find specific render instance first
        let activeItem;
        activeItem = this.container.querySelector(`[data-render-id="${this.currentRenderId}"]`);

        // If not found in DOM, it might be in a future batch not yet rendered
        // Render batches until we find it or run out
        if (!activeItem && this.renderedChannels.length > 0) {
            let safety = 0;
            while (!activeItem && this.currentBatch * this.batchSize < this.sortedGroups.length && safety < 20) {
                this.renderNextBatch();
                if (this.currentRenderId) {
                    activeItem = this.container.querySelector(`[data-render-id="${this.currentRenderId}"]`);
                }
                safety++;
            }
        }

        // Fallback checks if still not found
        if (!activeItem) {
            activeItem = this.container.querySelector(`[data-channel-id="${channel.id}"]`);
            // If we fell back to channel ID, update currentRenderId to match what we found
            if (activeItem && activeItem.dataset.renderId) {
                this.currentRenderId = activeItem.dataset.renderId;
            }
        }

        if (activeItem) {
            activeItem.classList.add('active');
            activeItem.classList.add('nav-active'); // Add specific class for navigation tracking

            // Expand the selected channel's group when selection came from
            // outside the sidebar, but preserve the user's other expanded groups.
            const groupHeader = activeItem.closest('.channel-group')?.querySelector('.group-header');
            if (groupHeader) {
                const groupName = groupHeader.dataset.group;

                if (this.collapsedGroups.has(groupName)) {
                    this.collapsedGroups.delete(groupName);
                    groupHeader.classList.remove('collapsed');
                    this.saveCollapsedState();
                }

                // Wait for a possible expansion to finish layout, then move only
                // when the selected item is outside the channel-list viewport.
                setTimeout(() => {
                    const listRect = this.container.getBoundingClientRect();
                    const itemRect = activeItem.getBoundingClientRect();
                    const isFullyVisible = itemRect.top >= listRect.top && itemRect.bottom <= listRect.bottom;
                    if (!isFullyVisible) {
                        activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                }, 50);
            } else {
                // Fallback for non-grouped items or flat list
                activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }

        await this.playChannelRecord(channel);
    }

    _selectedLiveSources() {
        const selected = this.sourceSelect.value;
        const enabled = this.sources.filter(source =>
            ['xtream', 'm3u'].includes(source.type)
            && source.enabled
            && API.sources.isVisibleIn(source, 'live')
        );
        if (!selected) return enabled;
        const [type, id] = selected.split(':');
        return enabled.filter(source => source.type === type && String(source.id) === id);
    }

    _mapBoundedChannel(item, source, fallbackGroupName = 'Uncategorized') {
        const sourceType = source.type;
        return {
            id: `${sourceType}_${source.id}_${item.stream_id}`,
            streamId: item.stream_id,
            name: item.name,
            tvgId: item.epg_channel_id,
            tvgLogo: item.stream_icon,
            ...(sourceType === 'm3u'
                ? { url: item.stream_url || item.url || null }
                : {}),
            groupId: `${sourceType}_${source.id}_${item.category_id || ''}`,
            groupTitle: item.category_name || fallbackGroupName,
            sourceId: source.id,
            sourceType
        };
    }

    _rememberBoundedChannels(items) {
        const byKey = new Map(this.channels.map(channel => [
            `${channel.sourceId}:${channel.id}`,
            channel
        ]));
        for (const channel of items) {
            byKey.set(`${channel.sourceId}:${channel.id}`, channel);
        }
        this.channels = [...byKey.values()];
    }

    async loadBoundedChannels() {
        if (this.isLoading) return;
        const requestId = ++this._boundedRequestId;
        this.isLoading = true;
        this.isCatalogueReady = false;
        this.loadError = null;
        this.currentRenderId = null;
        this.renderBounded();

        try {
            const selectedSources = this._selectedLiveSources();
            const [initialSummaryResults, favoriteChannels] = await Promise.all([
                Promise.allSettled(selectedSources.map(source =>
                    API.proxy.catalogue.liveSummary(source.id)
                )),
                API.favorites.getChannels(100)
            ]);
            if (requestId !== this._boundedRequestId) return;

            const summaryResults = [...initialSummaryResults];
            const failedIndexes = summaryResults
                .map((result, index) => result.status === 'rejected' ? index : -1)
                .filter(index => index !== -1);
            if (failedIndexes.length > 0) {
                await new Promise(resolve => setTimeout(resolve, 250));
                const retryResults = await Promise.allSettled(
                    failedIndexes.map(index =>
                        API.proxy.catalogue.liveSummary(selectedSources[index].id)
                    )
                );
                retryResults.forEach((result, retryIndex) => {
                    summaryResults[failedIndexes[retryIndex]] = result;
                });
            }

            const groupByName = new Map();
            let availableSources = 0;
            summaryResults.forEach((result, index) => {
                const source = selectedSources[index];
                let summary;
                if (result.status === 'fulfilled') {
                    summary = result.value;
                    this.boundedSummaryCache.set(String(source.id), summary);
                } else {
                    console.error(`Error loading source ${source?.id}:`, result.reason);
                    summary = this.boundedSummaryCache.get(String(source?.id));
                    if (summary) {
                        console.warn(`Using last known live summary for source ${source?.id}`);
                    } else {
                        return;
                    }
                }
                availableSources += 1;
                for (const group of summary.groups || []) {
                    const name = group.name || 'Uncategorized';
                    let entry = groupByName.get(name);
                    if (!entry) {
                        entry = { name, count: 0, parts: [] };
                        groupByName.set(name, entry);
                    }
                    entry.count += Number(group.count) || 0;
                    entry.parts.push({
                        source,
                        categoryId: group.id,
                        count: Number(group.count) || 0,
                        revision: summary.revision
                    });
                }
            });

            if (selectedSources.length > 0 && availableSources === 0) {
                throw new Error('Unable to load channels from any enabled source');
            }

            this.boundedSources = selectedSources;
            this.boundedGroups = [...groupByName.values()].sort((a, b) =>
                a.name.localeCompare(b.name)
            );
            this.boundedGroupIndex = new Map(this.boundedGroups.map(group => [group.name, group]));
            // A catalogue refresh invalidates every previously loaded bounded
            // page. Reset expanded state as well so a group cannot remain
            // visually open with an empty page until it is toggled twice.
            this._userExpandedGroups.clear();
            for (const group of this.boundedGroups) {
                this.collapsedGroups.add(group.name);
            }
            this.boundedGroupPages.clear();
            this.boundedSearchPages.clear();
            this.boundedSearchResults = [];
            this.favoriteChannels = (favoriteChannels || []).filter(channel =>
                selectedSources.some(source => String(source.id) === String(channel.sourceId))
            );
            this.visibleFavorites = new Set(this.favoriteChannels.map(channel =>
                `${channel.sourceId}:${channel.id}`
            ));
            this.channels = [...this.favoriteChannels];
            this.groups = this.boundedGroups.map(group => ({ id: group.name, name: group.name }));
            this.hiddenItems = new Set();
            this.isCatalogueReady = true;
            this.isLoading = false;
            if (this.searchInput.value.trim()) {
                await this.loadBoundedSearch();
                return;
            }
            this.renderBounded();
        } catch (err) {
            if (requestId !== this._boundedRequestId) return;
            console.error('Error loading bounded live catalogue:', err);
            this.loadError = err.message || 'Unable to load channels';
            this.isLoading = false;
            this.isCatalogueReady = true;
            this.renderBounded();
        }
    }

    async loadBoundedSearch({ append = false } = {}) {
        const query = this.searchInput.value.trim();
        if (!this.isCatalogueReady) return;
        const requestId = ++this._boundedRequestId;
        if (!query) {
            this.boundedSearchResults = [];
            this.boundedSearchPages.clear();
            this.renderBounded();
            return;
        }

        this.isLoading = !append;
        if (!append) {
            this.boundedSearchResults = [];
            this.boundedSearchPages.clear();
        }
        this.renderBounded({ preserveScrollPosition: append });

        try {
            const requests = this.boundedSources.map(async source => {
                const previous = this.boundedSearchPages.get(String(source.id));
                if (append && previous && !previous.hasMore) return null;
                const page = await API.proxy.catalogue.liveChannels(source.id, {
                    query,
                    cursor: append ? previous?.nextCursor : null,
                    limit: 100
                });
                return { source, page };
            });
            const results = await Promise.allSettled(requests);
            if (requestId !== this._boundedRequestId) return;

            const nextItems = [];
            let completedSources = 0;
            for (const result of results) {
                if (result.status !== 'fulfilled' || !result.value) {
                    if (result.status === 'rejected') {
                        console.warn('Unable to search one live source:', result.reason);
                    }
                    continue;
                }
                completedSources += 1;
                const { source, page } = result.value;
                this.boundedSearchPages.set(String(source.id), page);
                for (const item of page.items || []) {
                    nextItems.push(this._mapBoundedChannel(item, source));
                }
            }
            if (requests.length > 0 && completedSources === 0) {
                throw new Error('Unable to search channels from any enabled source');
            }
            const combined = append
                ? [...this.boundedSearchResults, ...nextItems]
                : nextItems;
            const unique = new Map(combined.map(channel => [
                `${channel.sourceId}:${channel.id}`,
                channel
            ]));
            this.boundedSearchResults = [...unique.values()].sort((a, b) =>
                a.name.localeCompare(b.name)
            );
            this._rememberBoundedChannels(this.boundedSearchResults);
            this.isLoading = false;
            this.renderBounded({ preserveScrollPosition: append });
        } catch (err) {
            if (requestId !== this._boundedRequestId) return;
            this.isLoading = false;
            this.loadError = err.message || 'Unable to search channels';
            this.renderBounded({ preserveScrollPosition: append });
        }
    }

    async loadBoundedGroup(groupName, {
        append = false,
        preserveScrollPosition = true,
        scrollAnchor = null
    } = {}) {
        const group = this.boundedGroupIndex.get(groupName);
        if (!group) return;
        const current = this.boundedGroupPages.get(groupName) || {
            channels: [],
            parts: new Map(),
            loading: false
        };
        if (current.loading) return;
        current.loading = true;
        this.boundedGroupPages.set(groupName, current);
        this.renderBounded({ preserveScrollPosition, scrollAnchor });

        try {
            let batch = null;
            if (append && current.prefetchedBatch) {
                batch = current.prefetchedBatch;
                current.prefetchedBatch = null;
            } else if (append && current.prefetchPromise) {
                batch = await current.prefetchPromise;
                current.prefetchedBatch = null;
            }
            if (!batch) {
                batch = await this._fetchBoundedGroupPage(groupName, current, { append });
            }
            this._applyBoundedGroupPage(current, batch, { append });
            current.loading = false;
            current.error = null;
            this._rememberBoundedChannels(current.channels);
            this.renderBounded({ preserveScrollPosition, scrollAnchor });
            if (append && current.hasMore) {
                this._prefetchBoundedGroup(groupName);
            }
        } catch (err) {
            current.loading = false;
            current.error = err.message || 'Unable to load group';
            this.renderBounded({ preserveScrollPosition, scrollAnchor });
        }
    }

    async _fetchBoundedGroupPage(groupName, current, { append = true } = {}) {
        const group = this.boundedGroupIndex.get(groupName);
        if (!group) throw new Error('Channel group is no longer available');

        const requests = group.parts.map(async part => {
            const key = `${part.source.id}:${part.categoryId}`;
            const previous = current.parts.get(key);
            if (append && previous && !previous.hasMore) return null;
            const page = await API.proxy.catalogue.liveChannels(part.source.id, {
                categoryId: part.categoryId,
                cursor: append ? previous?.nextCursor : null,
                // A normal-sized group should feel complete as soon as it
                // opens. Larger groups continue in bounded pages as the
                // user approaches the end of the loaded channels.
                limit: Math.min(BOUNDED_GROUP_PAGE_SIZE, Math.max(1, part.count || BOUNDED_GROUP_PAGE_SIZE))
            });
            return { part, page };
        });
        const results = await Promise.allSettled(requests);
        const pages = [];
        const channels = [];
        let completedParts = 0;
        for (const result of results) {
            if (result.status !== 'fulfilled' || !result.value) {
                if (result.status === 'rejected') {
                    console.warn(`Unable to load part of group ${groupName}:`, result.reason);
                }
                continue;
            }
            completedParts += 1;
            const { part, page } = result.value;
            pages.push({ key: `${part.source.id}:${part.categoryId}`, page });
            for (const item of page.items || []) {
                channels.push(this._mapBoundedChannel(item, part.source, groupName));
            }
        }
        if (requests.length > 0 && completedParts === 0) {
            throw new Error('Unable to load this channel group');
        }
        return { pages, channels };
    }

    _applyBoundedGroupPage(current, batch, { append = true } = {}) {
        for (const { key, page } of batch.pages) current.parts.set(key, page);
        const combined = append ? [...current.channels, ...batch.channels] : batch.channels;
        const unique = new Map(combined.map(channel => [
            `${channel.sourceId}:${channel.id}`,
            channel
        ]));
        current.channels = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
        current.hasMore = [...current.parts.values()].some(page => page.hasMore);
    }

    _prefetchBoundedGroup(groupName) {
        const current = this.boundedGroupPages.get(groupName);
        if (!current?.channels?.length || !current.hasMore || current.loading) return null;
        if (current.prefetchedBatch) return Promise.resolve(current.prefetchedBatch);
        if (current.prefetchPromise) return current.prefetchPromise;

        const expectedState = current;
        current.prefetchPromise = this._fetchBoundedGroupPage(groupName, current, { append: true })
            .then(batch => {
                if (this.boundedGroupPages.get(groupName) !== expectedState) return null;
                current.prefetchedBatch = batch;
                return batch;
            })
            .catch(err => {
                // A speculative request must not put the visible group into an
                // error state. Reaching the boundary will retry normally.
                console.warn(`Unable to prepare more channels for group ${groupName}:`, err);
                return null;
            })
            .finally(() => {
                if (current.prefetchPromise) current.prefetchPromise = null;
            });
        return current.prefetchPromise;
    }

    _scheduleBoundedGroupLookahead() {
        if (!this.boundedMode || this.searchInput.value.trim() || this.boundedLookaheadScrollScheduled) return;
        this.boundedLookaheadScrollScheduled = true;
        const schedule = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : callback => setTimeout(callback, 0);
        schedule(() => {
            this.boundedLookaheadScrollScheduled = false;
            const containerRect = this.container.getBoundingClientRect();
            const expandedGroups = [...this.container.querySelectorAll('.channel-group')];
            for (const groupElement of expandedGroups) {
                const header = groupElement.querySelector('.group-header[data-group]:not(.collapsed)');
                if (!header || header.classList.contains('favorites-group')) continue;
                const state = this.boundedGroupPages.get(header.dataset.group);
                if (!state?.hasMore || !state.channels?.length) continue;
                const rect = groupElement.getBoundingClientRect();
                if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) continue;
                this._prefetchBoundedGroup(header.dataset.group);
                break;
            }
        });
    }

    _boundedChannelHtml(channel, groupName) {
        const isActive = this.currentChannel?.id === channel.id
            && String(this.currentChannel?.sourceId) === String(channel.sourceId);
        const isFavorite = this.isFavorite(channel.sourceId, channel.id);
        const renderId = `bounded_${groupName}_${channel.sourceId}_${channel.id}`;
        return `
          <div class="channel-item ${isActive ? 'active nav-active' : ''}"
               data-channel-id="${this.escapeHtml(String(channel.id))}"
               data-source-id="${this.escapeHtml(String(channel.sourceId))}"
               data-source-type="${this.escapeHtml(channel.sourceType)}"
               data-stream-id="${this.escapeHtml(String(channel.streamId || ''))}"
               data-url="${this.escapeHtml(channel.url || '')}"
               data-render-id="${this.escapeHtml(renderId)}"
               data-render-group="${this.escapeHtml(groupName)}">
            <img class="channel-logo" src="${this.escapeHtml(this.getProxiedImageUrl(channel.tvgLogo))}"
                 alt="" onerror="this.onerror=null;this.src='img/placeholder.png'">
            <div class="channel-info">
              <div class="channel-name">${this.escapeHtml(channel.name)}</div>
              <div class="channel-program">${this.escapeHtml(this.getProgramInfo(channel) || '')}</div>
            </div>
            <button class="favorite-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
              ${isFavorite ? Icons.favorite : Icons.favoriteOutline}
            </button>
          </div>`;
    }

    _attachBoundedChannelListeners(container) {
        container.querySelectorAll('.channel-item').forEach(item => {
            item.addEventListener('click', event => {
                if (!event.target.closest('.favorite-btn')) this.selectChannel(item.dataset);
            });
            item.addEventListener('contextmenu', event => this.showContextMenu(event, 'channel', item.dataset));
            item.querySelector('.favorite-btn')?.addEventListener('click', event => {
                event.stopPropagation();
                this.toggleFavorite(Number(item.dataset.sourceId), item.dataset.channelId);
            });
        });
    }

    _setupBoundedContinuationObserver() {
        this.boundedContinuationObserver?.disconnect();
        this.boundedContinuationObserver = null;

        const sentinels = this.container.querySelectorAll(
            '.bounded-load-sentinel, .bounded-search-sentinel'
        );
        if (sentinels.length === 0) return;

        if (typeof IntersectionObserver === 'undefined') {
            sentinels.forEach(sentinel => {
                const button = document.createElement('button');
                button.className = 'btn btn-secondary bounded-load-fallback';
                button.textContent = sentinel.dataset.kind === 'search'
                    ? 'Load more results'
                    : 'Load remaining channels';
                button.addEventListener('click', () => {
                    if (sentinel.dataset.kind === 'search') {
                        this.loadBoundedSearch({ append: true });
                    } else {
                        this.loadBoundedGroup(sentinel.dataset.group, {
                            append: sentinel.dataset.mode !== 'initial',
                            preserveScrollPosition: true
                        });
                    }
                });
                sentinel.replaceChildren(button);
            });
            return;
        }

        this.boundedContinuationObserver = new IntersectionObserver(async entries => {
            if (this.boundedObserverLoadInFlight) return;
            // Load a single visible sentinel at a time. Expand All can expose
            // several unloaded group sentinels in the viewport; serializing
            // them prevents a burst of large page requests and DOM updates.
            const entry = entries.find(candidate => candidate.isIntersecting);
            if (!entry) return;
            const isSearch = entry.target.dataset.kind === 'search';
            const groupName = entry.target.dataset.group;
            const append = entry.target.dataset.mode !== 'initial';
            this.boundedContinuationObserver?.unobserve(entry.target);
            this.boundedObserverLoadInFlight = true;
            try {
                if (isSearch) {
                    await this.loadBoundedSearch({ append: true });
                } else {
                    await this.loadBoundedGroup(groupName, { append, preserveScrollPosition: true });
                }
            } catch (err) {
                console.error(
                    isSearch
                        ? 'Unable to continue loading search results:'
                        : `Unable to continue loading group ${groupName}:`,
                    err
                );
            } finally {
                this.boundedObserverLoadInFlight = false;
                // A render performed while the serialized load was active may
                // already have observed another sentinel. Recreate the
                // observer so the next visible group can proceed normally.
                this._setupBoundedContinuationObserver();
            }
        }, {
            root: this.container,
            // Begin fetching well before the sentinel reaches the bottom of
            // the sidebar. This keeps fast scrolling ahead of the network
            // without increasing the bounded page size or DOM footprint.
            rootMargin: '150% 0px'
        });

        sentinels.forEach(sentinel => this.boundedContinuationObserver.observe(sentinel));
    }

    _captureBoundedScrollAnchor(element = null) {
        const containerRect = this.container.getBoundingClientRect();
        let anchor = element;
        if (!anchor) {
            const headers = [...this.container.querySelectorAll('.group-header[data-group]')];
            anchor = headers.find(header => {
                const rect = header.getBoundingClientRect();
                return rect.bottom >= containerRect.top;
            });
        }
        if (!anchor?.dataset?.group) return null;
        return {
            groupName: anchor.dataset.group,
            offset: anchor.getBoundingClientRect().top - containerRect.top
        };
    }

    _restoreBoundedScrollAnchor(anchor) {
        if (!anchor) return;
        const header = [...this.container.querySelectorAll('.group-header[data-group]')]
            .find(candidate => candidate.dataset.group === anchor.groupName);
        if (!header) return;
        const containerTop = this.container.getBoundingClientRect().top;
        const nextOffset = header.getBoundingClientRect().top - containerTop;
        this.container.scrollTop += nextOffset - anchor.offset;
    }

    renderBounded({ preserveScrollPosition = false, scrollAnchor = null } = {}) {
        const previousScrollTop = preserveScrollPosition ? this.container.scrollTop : 0;
        if (this.isLoading) {
            if (this.toggleGroupsBtn) {
                this.toggleGroupsBtn.disabled = true;
                this.toggleGroupsBtn.title = 'Channels are loading';
            }
            this.container.innerHTML = '<div class="loading"></div>';
            this.renderedChannels = [];
            return;
        }
        if (this.loadError) {
            if (this.toggleGroupsBtn) {
                this.toggleGroupsBtn.disabled = true;
                this.toggleGroupsBtn.title = 'Groups are unavailable';
            }
            this.container.innerHTML = `<div class="empty-state"><p>Error loading channels</p><p class="hint">${this.escapeHtml(this.loadError)}</p></div>`;
            this.renderedChannels = [];
            return;
        }

        const query = this.searchInput.value.trim();
        if (this.toggleGroupsBtn) {
            const hasGroups = this.boundedGroups.length > 0;
            const allCollapsed = hasGroups
                && this.boundedGroups.every(group => this.collapsedGroups.has(group.name));
            this.toggleGroupsBtn.disabled = !hasGroups || Boolean(query);
            this.toggleGroupsBtn.innerHTML = allCollapsed ? Icons.expandAll : Icons.collapseAll;
            this.toggleGroupsBtn.title = query
                ? 'Clear the search to expand or collapse all groups'
                : (allCollapsed ? 'Expand All Groups' : 'Collapse All Groups');
        }

        const fragment = document.createDocumentFragment();
        const list = document.createElement('div');
        list.className = 'channel-list-content';
        this.listContainer = list;
        this.groupedChannels = {};
        this.renderedChannels = [];

        const groups = [];
        if (query) {
            const byGroup = new Map();
            for (const channel of this.boundedSearchResults) {
                const name = channel.groupTitle || 'Uncategorized';
                if (!byGroup.has(name)) byGroup.set(name, []);
                byGroup.get(name).push(channel);
            }
            for (const [name, channels] of [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
                groups.push({ name, count: channels.length, channels, search: true });
            }
        } else {
            if (this.favoriteChannels.length > 0) {
                groups.push({ name: 'Favorites', count: this.favoriteChannels.length, channels: this.favoriteChannels, favorites: true });
            }
            groups.push(...this.boundedGroups);
        }

        for (const group of groups) {
            const groupName = group.name;
            const isFavorites = group.favorites;
            const isSearch = group.search;
            const state = this.boundedGroupPages.get(groupName);
            const collapsed = !isSearch && !isFavorites && this.collapsedGroups.has(groupName);
            const channels = group.channels || state?.channels || [];
            this.groupedChannels[groupName] = channels;
            if (!collapsed) {
                for (const channel of channels) {
                    this.renderedChannels.push({
                        ...channel,
                        _renderId: `bounded_${groupName}_${channel.sourceId}_${channel.id}`,
                        _renderGroup: groupName
                    });
                }
            }

            const groupEl = document.createElement('div');
            groupEl.className = 'channel-group';
            groupEl.innerHTML = `
              <div class="group-header ${collapsed ? 'collapsed' : ''} ${isFavorites ? 'favorites-group' : ''}" data-group="${this.escapeHtml(groupName)}">
                <span class="group-toggle">${Icons.chevronDown}</span>
                <span class="group-name">${this.escapeHtml(groupName)}</span>
                <span class="group-count">${group.count}</span>
              </div>
              <div class="group-channels">
                ${collapsed ? '' : channels.map(channel => this._boundedChannelHtml(channel, groupName)).join('')}
                ${!collapsed && state?.loading ? '<div class="loading"></div>' : ''}
                ${!collapsed && state?.error ? `<div class="empty-state"><p>${this.escapeHtml(state.error)}</p><button class="btn btn-secondary bounded-load-retry">Try again</button></div>` : ''}
                ${!collapsed && !isSearch && !isFavorites && !state ? `<div class="bounded-load-sentinel" data-mode="initial" data-group="${this.escapeHtml(groupName)}"><div class="loading"></div></div>` : ''}
                ${!collapsed && state?.hasMore && !state.loading && !state.error ? `<div class="bounded-load-sentinel" data-mode="append" data-group="${this.escapeHtml(groupName)}"><div class="loading"></div></div>` : ''}
              </div>`;

            const header = groupEl.querySelector('.group-header');
            header.addEventListener('click', async () => {
                if (isSearch || isFavorites) return;
                const anchor = this._captureBoundedScrollAnchor(header);
                this.toggleGroup(groupName);
                if (collapsed && !state?.channels?.length) {
                    await this.loadBoundedGroup(groupName, { scrollAnchor: anchor });
                } else {
                    this.renderBounded({ scrollAnchor: anchor });
                }
            });
            header.addEventListener('contextmenu', event => this.showContextMenu(event, 'group', header.dataset));
            groupEl.querySelector('.bounded-load-retry')?.addEventListener('click', () =>
                this.loadBoundedGroup(groupName, { append: true })
            );
            this._attachBoundedChannelListeners(groupEl);
            list.appendChild(groupEl);
        }

        if (query && this.boundedSearchResults.length === 0) {
            list.innerHTML = '<div class="empty-state"><p>No channels match your search</p><p class="hint">Try a different search term</p></div>';
        } else if (!query && groups.length === 0) {
            list.innerHTML = '<div class="empty-state"><p>No channels loaded</p><p class="hint">Add a source in Settings to get started</p></div>';
        }

        if (query && [...this.boundedSearchPages.values()].some(page => page.hasMore)) {
            const sentinel = document.createElement('div');
            sentinel.className = 'bounded-search-sentinel';
            sentinel.dataset.kind = 'search';
            sentinel.innerHTML = '<div class="loading"></div>';
            list.appendChild(sentinel);
        }

        fragment.appendChild(list);
        this.container.replaceChildren(fragment);
        if (preserveScrollPosition) {
            this.container.scrollTop = previousScrollTop;
        }
        this._restoreBoundedScrollAnchor(scrollAnchor);
        this._setupBoundedContinuationObserver();
    }

    async loadGuideChannels() {
        const descriptors = this.sources
            .filter(source => ['xtream', 'm3u'].includes(source.type)
                && source.enabled
                && API.sources.isVisibleIn(source, 'live'))
            .map(source => ({ source, type: source.type }));
        const results = await Promise.allSettled(descriptors.map(descriptor =>
            this.fetchSourceChannels(descriptor.source.id, descriptor.type)
        ));
        const channels = [];
        let available = 0;
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                available += 1;
                for (const channel of result.value.channels) channels.push(channel);
            } else {
                console.warn(`Unable to load guide catalogue for source ${descriptors[index]?.source.id}:`, result.reason);
            }
        });
        if (descriptors.length > 0 && available === 0) {
            throw new Error('Unable to load channels for TV Guide');
        }
        this.guideChannels = channels;
        return channels;
    }

    /**
     * Resolve and play a channel record that may come from outside the full
     * Live TV catalogue, such as the targeted favorites endpoint on Home.
     */
    async playChannelRecord(channel) {
        if (!channel) return;

        this.currentChannel = channel;

        // Get stream URL
        let streamUrl;
        if (channel.sourceType === 'xtream') {
            // Get stream format from player settings (server-side) or fallback
            const configuredFormat = window.app?.player?.settings?.streamFormat || 'm3u8';
            const streamFormat = window.app?.player?.getPreferredXtreamStreamFormat?.(
                channel.sourceId,
                channel.streamId,
                configuredFormat
            ) || configuredFormat;
            const result = await API.proxy.xtream.getStreamUrl(channel.sourceId, channel.streamId, 'live', streamFormat);
            streamUrl = result.url;
        } else {
            streamUrl = channel.url;
        }

        // Play channel
        if (window.app?.player) {
            window.app.player.play(channel, streamUrl);
        }
    }

    /**
     * Show context menu
     */
    showContextMenu(e, type, data) {
        e.preventDefault();
        this.contextMenu.dataset.type = type;
        this.contextMenu.dataset.sourceId = data.sourceId;
        this.contextMenu.dataset.itemId = type === 'group' ? data.group : data.channelId;
        this.contextMenu.dataset.streamId = data.streamId || '';

        this.contextMenu.style.left = `${e.clientX}px`;
        this.contextMenu.style.top = `${e.clientY}px`;
        this.contextMenu.classList.add('active');
    }

    /**
     * Hide context menu
     */
    hideContextMenu() {
        this.contextMenu.classList.remove('active');
    }

    /**
     * Handle context menu action
     */
    async handleContextAction(e) {
        const action = e.target.dataset.action;
        const { type, sourceId, itemId, streamId } = this.contextMenu.dataset;

        switch (action) {
            case 'play':
                if (type === 'channel') {
                    const channel = this.channels.find(c => c.id === itemId);
                    if (channel) {
                        await this.selectChannel({ channelId: channel.id });
                    }
                }
                break;
            case 'hide':
                // Use streamId for hiding Xtream channels (raw ID, not composite)
                // Server expects 'channel' type, not 'live'
                const hideId = streamId || itemId;
                await API.channels.hide(parseInt(sourceId), 'channel', hideId);
                this.hiddenItems.add(`channel:${sourceId}:${hideId}`);
                this.render();
                break;
            case 'epg':
                // Show EPG info modal
                this.showEpgInfo(sourceId, itemId, streamId);
                break;
        }

        this.hideContextMenu();
    }

    /**
     * Show EPG info for a channel
     */
    showEpgInfo(sourceId, channelId, streamId) {
        const channel = this.channels.find(c => c.id === channelId);
        if (!channel) {
            alert('Channel not found');
            return;
        }

        const modal = document.getElementById('modal');
        const modalTitle = document.getElementById('modal-title');
        const modalBody = document.getElementById('modal-body');

        if (!modal || !modalTitle || !modalBody) return;

        modalTitle.textContent = `📋 ${channel.name} - EPG Info`;

        // Get current and upcoming programs
        let programsHtml = '<p class="no-programs">No EPG data available for this channel.</p>';

        if (window.app?.epgGuide) {
            const tvgKey = channel.tvgId || channel.name;
            const currentProgram = window.app.epgGuide.getCurrentProgram(channel.tvgId, channel.name);
            const programs = window.app.epgGuide.getChannelPrograms?.(tvgKey) || [];

            if (currentProgram || programs.length > 0) {
                programsHtml = '<div class="epg-program-list">';

                // Show current program
                if (currentProgram) {
                    const startTime = new Date(currentProgram.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const endTime = new Date(currentProgram.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    programsHtml += `
                        <div class="epg-program current">
                            <div class="epg-program-time">${startTime} - ${endTime}</div>
                            <div class="epg-program-title">▶ ${this.escapeHtml(currentProgram.title)}</div>
                            ${currentProgram.description ? `<div class="epg-program-desc">${this.escapeHtml(currentProgram.description)}</div>` : ''}
                        </div>
                    `;
                }

                // Show upcoming programs (next 5)
                const now = Date.now();
                const upcoming = programs
                    .filter(p => new Date(p.start).getTime() > now)
                    .slice(0, 5);

                upcoming.forEach(prog => {
                    const startTime = new Date(prog.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const endTime = new Date(prog.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    programsHtml += `
                        <div class="epg-program">
                            <div class="epg-program-time">${startTime} - ${endTime}</div>
                            <div class="epg-program-title">${this.escapeHtml(prog.title)}</div>
                        </div>
                    `;
                });

                programsHtml += '</div>';
            }
        }

        modalBody.innerHTML = `
            <div class="epg-info-modal">
                <div class="channel-details">
                    <img class="channel-logo" src="${this.getProxiedImageUrl(channel.tvgLogo)}" 
                         onerror="this.onerror=null;this.src='img/placeholder.png'" />
                    <div class="channel-meta">
                        <p><strong>Group:</strong> ${this.escapeHtml(channel.groupTitle || 'Uncategorized')}</p>
                        <p><strong>Source:</strong> ${channel.sourceType}</p>
                        ${channel.tvgId ? `<p><strong>TVG ID:</strong> ${this.escapeHtml(channel.tvgId)}</p>` : ''}
                    </div>
                </div>
                <h4>Program Schedule</h4>
                ${programsHtml}
            </div>
        `;

        modal.classList.add('active');
    }

    /**
     * Sync favorite status from external source (e.g. EPG) without API call
     */
    syncFavorite(sourceId, channelId, isFavorite) {
        const key = `${sourceId}:${channelId}`;
        const currentlyFav = this.visibleFavorites.has(key);

        if (currentlyFav === isFavorite) return; // No change needed

        // Update State
        if (isFavorite) {
            this.visibleFavorites.add(key);
        } else {
            this.visibleFavorites.delete(key);
        }

        if (this.boundedMode) {
            const channel = this.channels.find(c =>
                String(c.sourceId) === String(sourceId) && String(c.id) === String(channelId)
            );
            if (channel) this.updateFavoritesGroup(channel, isFavorite);
            return;
        }

        // Update DOM (All instances)
        const btns = document.querySelectorAll(`.channel-item[data-channel-id="${channelId}"][data-source-id="${sourceId}"] .favorite-btn`);

        btns.forEach(btn => {
            if (isFavorite) {
                btn.classList.add('active');
                btn.innerHTML = '❤️';
                btn.title = 'Remove from Favorites';
            } else {
                btn.classList.remove('active');
                btn.innerHTML = '♡';
                btn.title = 'Add to Favorites';
            }
        });

        // Update Favorites Group
        const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
        if (channel) {
            this.updateFavoritesGroup(channel, isFavorite);
        }
    }

    /**
     * Select next channel in the current list
     */
    selectNextChannel() {
        if (!this.currentChannel || !this.renderedChannels || this.renderedChannels.length === 0) return;

        let currentIndex = -1;

        // Try to find by render ID first (strict visual order)
        if (this.currentRenderId) {
            currentIndex = this.renderedChannels.findIndex(c => c._renderId === this.currentRenderId);
        }

        // Fallback: Find matching channel ID, prioritizing same render group
        if (currentIndex === -1) {
            // First try to find in same group (for Favorites containing duplicates)
            if (this.currentRenderGroup) {
                currentIndex = this.renderedChannels.findIndex(c =>
                    c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId && c._renderGroup === this.currentRenderGroup
                );
            }
            // Final fallback: any matching channel
            if (currentIndex === -1) {
                currentIndex = this.renderedChannels.findIndex(c =>
                    c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId
                );
            }
        }

        if (currentIndex === -1) return;

        const nextIndex = (currentIndex + 1) % this.renderedChannels.length;
        const nextChannel = this.renderedChannels[nextIndex];

        this.selectChannel({
            channelId: nextChannel.id,
            sourceId: nextChannel.sourceId,
            sourceType: nextChannel.sourceType,
            streamId: nextChannel.streamId,
            url: nextChannel.url,
            renderId: nextChannel._renderId // Pass the unique render ID
        });
    }

    /**
     * Select previous channel in the current list
     */
    selectPrevChannel() {
        if (!this.currentChannel || !this.renderedChannels || this.renderedChannels.length === 0) return;

        let currentIndex = -1;

        if (this.currentRenderId) {
            currentIndex = this.renderedChannels.findIndex(c => c._renderId === this.currentRenderId);
        }

        // Fallback: Find matching channel ID, prioritizing same render group
        if (currentIndex === -1) {
            // First try to find in same group (for Favorites containing duplicates)
            if (this.currentRenderGroup) {
                currentIndex = this.renderedChannels.findIndex(c =>
                    c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId && c._renderGroup === this.currentRenderGroup
                );
            }
            // Final fallback: any matching channel
            if (currentIndex === -1) {
                currentIndex = this.renderedChannels.findIndex(c =>
                    c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId
                );
            }
        }

        if (currentIndex === -1) return;

        const prevIndex = (currentIndex - 1 + this.renderedChannels.length) % this.renderedChannels.length;
        const prevChannel = this.renderedChannels[prevIndex];

        this.selectChannel({
            channelId: prevChannel.id,
            sourceId: prevChannel.sourceId,
            sourceType: prevChannel.sourceType,
            streamId: prevChannel.streamId,
            url: prevChannel.url,
            renderId: prevChannel._renderId
        });
    }

    /**
     * Show EPG info for channel
     */
    async showEpgInfo(channelId) {
        const channel = this.channels.find(c => c.id === channelId);
        if (!channel) return;

        // This would show a modal with EPG info
        console.log('Show EPG for:', channel);
    }

    /**
     * Get list of visible (non-hidden) channels in display order
     */
    getVisibleChannels() {
        const showHidden = this.showHiddenCheckbox?.checked ?? false;
        return this.channels.filter(ch => {
            if (showHidden) return true;
            const channelHidden = this.isHidden('channel', ch.sourceId, ch.id);
            const groupHidden = this.isHidden('group', ch.sourceId, ch.groupTitle);
            return !channelHidden && !groupHidden;
        });
    }
}

// Export
window.ChannelList = ChannelList;
