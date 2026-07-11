# NodeCast TV Plus Plugin System

This directory allows you to extend the functionality of **NodeCast TV Plus** without modifying the core source code. The server automatically detects and loads any `.js` file placed in this folder at startup.

---

## How It Works

The plugin loader in `server/index.js` scans this directory at startup and loads plugins in **alphabetical order** (sorted by filename). Each plugin file should export either:
- A function (sync or async) that will be called during initialization
- An object with `init()` and optionally `shutdown()` methods for lifecycle management

When the server starts, it calls your plugin's initialization code and passes:
- `app` - The Express application instance
- `services` - A **frozen** (read-only) object containing all internal services

---

## Plugin Patterns

### Pattern 1: Simple Function Export

The simplest plugin pattern - just export a function:

```javascript
/**
 * @param {Object} app - The Express application instance
 * @param {Object} services - Frozen object containing all internal services
 */
module.exports = function(app, services) {
    // Register routes, middleware, etc.
    app.get('/api/my-route', (req, res) => {
        res.json({ message: 'Hello from plugin!' });
    });
};
```

### Pattern 2: Async Function Export

For plugins that need to perform async initialization (database connections, API calls, etc.):

```javascript
module.exports = async function(app, services) {
    // Async initialization
    await someAsyncSetup();
    
    // Access services
    if (services.syncService) {
        console.log('Sync service available');
    }
    
    // Register routes
    app.get('/api/my-route', (req, res) => {
        res.json({ status: 'ready' });
    });
};
```

### Pattern 3: Lifecycle Hooks (Advanced)

For plugins that need cleanup on shutdown:

```javascript
module.exports = {
    /**
     * Called during server startup
     */
    init: async (app, services) => {
        // Setup code
        this.interval = setInterval(() => {
            console.log('Background task running...');
        }, 60000);
        
        app.get('/api/status', (req, res) => {
            res.json({ uptime: process.uptime() });
        });
    },
    
    /**
     * Called on SIGTERM (graceful shutdown)
     */
    shutdown: async () => {
        // Cleanup code
        if (this.interval) {
            clearInterval(this.interval);
        }
        console.log('Plugin cleaned up');
    }
};
```

---

## Security & Permissions

> [!WARNING]
> Plugins run with **full Node.js permissions** and have access to the Express app and all services. Only install plugins from trusted sources.

**Important notes:**
- The `services` object is **frozen** - you cannot modify or delete services
- Plugins can still mutate properties of service objects (e.g., `services.cache.set()`)
- Plugins can register routes, middleware, and access the file system
- This is appropriate for self-hosted applications where you control what plugins are installed

---

## Available Services

The `services` object contains all modules from `server/services/`:

| Service | Description |
|---------|-------------|
| `cache` | Caching utilities |
| `epgParser` | EPG/XMLTV parsing |
| `hwDetect` | Hardware acceleration detection |
| `m3uParser` | M3U playlist parsing |
| `m3uXtreamAdapter` | Xtream API adapter |
| `syncService` | Channel/EPG synchronization |
| `transcodeSession` | Transcoding session management |
| `xtreamApi` | Xtream API client |

**Example:**
```javascript
module.exports = async function(app, services) {
    // Use the EPG parser service
    const epgData = await services.epgParser.fetchAndParse('http://example.com/epg.xml');
    console.log(`Loaded ${epgData.programmes.length} programmes`);
};
```

---

## Load Order

Plugins are loaded in **alphabetical order** by filename. If you need specific ordering:

```
plugins/
  01-database.js      # Loads first
  02-api-client.js    # Loads second
  99-cleanup.js       # Loads last
```

---

## Testing Your Plugin

1. Place your `.js` file in `server/plugins/`
2. Restart the NodeCast TV Plus server
3. Check the console for plugin loading messages:
   - `✓ Loaded plugin: your-plugin.js` - Success
   - `⚠ Plugin your-plugin.js does not export...` - Wrong export format
   - `✗ Failed to load plugin your-plugin.js` - Error during initialization

---

## Example Use Cases

- **Custom scrapers** - Add support for new streaming sources
- **Notification systems** - Send alerts when new content is available
- **Analytics** - Track viewing patterns
- **Custom APIs** - Expose additional endpoints for integrations
- **Middleware** - Add authentication, logging, or rate limiting
