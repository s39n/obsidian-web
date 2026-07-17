/**
 * File watcher over WebSocket.
 *
 * Bridges chokidar events on the vault to clients. Used by the original-fs
 * shim to implement fs.watch().
 *
 * On filesystems that do not support inotify (rclone/FUSE, NFS, SMB, …)
 * set WATCH_POLLING=true so chokidar falls back to stat-based polling.
 * Set WATCH_POLL_INTERVAL to control the poll interval in ms (default 3000).
 *
 * Each unique vault root gets exactly ONE shared chokidar watcher, regardless
 * of how many WebSocket connections (browser tabs) are open. Events are
 * fanned out to all active clients. When the last client for a vault
 * disconnects the watcher is closed, freeing OS resources (inotify watches
 * or polling timers).
 */

const chokidar = require('chokidar');
const path = require('path');
const { WebSocketServer } = require('ws');
const config = require('../config');

function attachWatchServer(httpServer, vaultRegistry, fallbackVaultRoot, isAuthenticated) {
  // WebSocket upgrades never pass through Express middleware, so when TOTP
  // auth is enabled the session cookie must be verified here — otherwise an
  // unauthenticated client could subscribe to file-change events (vault file
  // and folder names). Rejected upgrades get a plain HTTP 401.
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/api/watch',
    verifyClient: (info) => !isAuthenticated || isAuthenticated(info.req),
  });

  // Shared watchers: vaultRoot → { watcher, clients: Set<ws> }
  const sharedWatchers = new Map();

  if (config.watchPolling) {
    console.log(`[watch] polling mode enabled (interval ${config.watchPollInterval}ms)`);
  }

  function getVaultRoot(req) {
    const url = new URL(req.url, 'http://localhost');
    const vaultId = url.searchParams.get('vault');
    if (vaultId) {
      const vault = vaultRegistry.get(vaultId);
      return vault ? vault.path : null;
    }
    return fallbackVaultRoot;
  }

  function send(ws, message) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }

  function getOrCreateWatcher(vaultRoot) {
    if (sharedWatchers.has(vaultRoot)) {
      return sharedWatchers.get(vaultRoot);
    }

    const clients = new Set();
    const watcher = chokidar.watch(vaultRoot, {
      ignored: (p) => path.basename(p).startsWith('.'),
      ignoreInitial: true,
      persistent: true,
      usePolling: config.watchPolling,
      interval: config.watchPolling ? config.watchPollInterval : undefined,
      binaryInterval: config.watchPolling ? config.watchPollInterval : undefined,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });

    function broadcast(message) {
      const json = JSON.stringify(message);
      for (const ws of clients) {
        if (ws.readyState === 1) ws.send(json);
      }
    }

    function broadcastEvent(eventType, absolutePath) {
      const relative = path.relative(vaultRoot, absolutePath).split(path.sep).join('/');
      broadcast({ type: eventType, path: relative });
    }

    watcher.on('ready', () => broadcast({ type: 'ready' }));
    watcher.on('add', (p) => broadcastEvent('add', p));
    watcher.on('change', (p) => broadcastEvent('change', p));
    watcher.on('unlink', (p) => broadcastEvent('unlink', p));
    watcher.on('addDir', (p) => broadcastEvent('addDir', p));
    watcher.on('unlinkDir', (p) => broadcastEvent('unlinkDir', p));
    watcher.on('error', (err) => {
      console.error('[watch] error:', err);
      broadcast({ type: 'error', message: err.message });
    });

    const entry = { watcher, clients };
    sharedWatchers.set(vaultRoot, entry);
    console.log(`[watch] started watcher for ${vaultRoot}`);
    return entry;
  }

  wss.on('connection', (ws, req) => {
    const vaultRoot = getVaultRoot(req);
    if (!vaultRoot) {
      send(ws, { type: 'error', message: 'unknown vault' });
      ws.close();
      return;
    }

    const entry = getOrCreateWatcher(vaultRoot);
    entry.clients.add(ws);
    console.log(`[watch] client connected for ${vaultRoot} (${entry.clients.size} total)`);

    ws.on('close', () => {
      entry.clients.delete(ws);
      console.log(`[watch] client disconnected for ${vaultRoot} (${entry.clients.size} remaining)`);
      if (entry.clients.size === 0) {
        entry.watcher.close();
        sharedWatchers.delete(vaultRoot);
        console.log(`[watch] closed watcher for ${vaultRoot} (no more clients)`);
      }
    });
  });

  httpServer.on('close', () => {
    for (const { watcher } of sharedWatchers.values()) {
      watcher.close();
    }
    sharedWatchers.clear();
    wss.close();
  });

  return { wss, sharedWatchers };
}

module.exports = attachWatchServer;
