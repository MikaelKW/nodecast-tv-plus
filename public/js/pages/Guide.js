/**
 * Guide Page Controller
 */

class GuidePage {
    constructor(app) {
        this.app = app;
    }

    async init() {
        // EPG guide will lazy load when shown
    }

    async show() {
        // Ensure channel data is loaded before rendering EPG
        // This fixes a race condition where navigating directly to the Guide page
        // before visiting Live TV would result in an empty EPG.
        const channelList = this.app.channelList;
        await channelList.loadSources();
        if (channelList.boundedMode) {
            await channelList.loadGuideChannels();
        } else if (!channelList.channels || channelList.channels.length === 0) {
            await channelList.loadChannels();
        }

        // Startup loads only now-playing titles; the guide requires the complete
        // programme window and loads it only when this page is opened.
        if (!this.app.epgGuide.fullEpgLoaded) {
            await this.app.epgGuide.loadEpg();
        } else {
            // Just re-render with existing data (updates time position)
            this.app.epgGuide.render();
        }
    }

    hide() {
        // Page is hidden
    }
}

window.GuidePage = GuidePage;
