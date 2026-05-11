/**
 * Capacitor shim for the obsidian-web mobile runtime (`/mobile`).
 *
 * Loaded before `native-bridge.js` and `obsidian-mobile/app.js`. Installs an
 * `androidBridge.postMessage` transport up front, then (after native-bridge
 * has constructed `window.Capacitor`) replaces the key entry points so that
 * all Capacitor plugin calls are served by our HTTP API + WebSocket instead
 * of a native Android process.
 *
 * THE CRITICAL DETAIL — PluginHeaders:
 *   `Capacitor.Plugins.<Name>` is a Proxy that consults `c.PluginHeaders`
 *   to find each method. WITHOUT a matching header entry, every call throws
 *   "<plugin> is not implemented on android" — long before our nativePromise
 *   is ever invoked. We therefore declare PluginHeaders for every plugin +
 *   method below. See `docs/investigations.md` → "PluginHeaders mechanism".
 *
 * PLUGIN INVENTORY (13 plugins shipped in obsidian-mobile 1.12.7 APK):
 *
 *   Real implementations (route to HTTP API):
 *     Filesystem  — readFile, writeFile, appendFile, stat, readdir, mkdir,
 *                   rmdir, rename, copy, deleteFile, trash, getUri,
 *                   startWatch, stopWatch, watchAndStatAll, addListener
 *                   (FS over /api/fs/*, watch over /api/watch WebSocket)
 *
 *   Browser-native (delegate to Web APIs):
 *     Clipboard      — navigator.clipboard.{readText,writeText}
 *     Browser        — window.open(url, '_blank', 'noopener')
 *     Preferences    — localStorage with `cap:` prefix
 *     SecureStorage  — localStorage with `sec:` prefix (NOT encrypted!)
 *
 *   Identity stubs (return realistic info):
 *     Device  — getInfo returns { platform:'android', osVersion:'12', ... }
 *     App     — getInfo returns { name:'Obsidian', version:'1.12.7', ... }
 *
 *   Noop stubs (return success, do nothing — irrelevant on web):
 *     SplashScreen, StatusBar, Keyboard, KeepAwake, Haptics, RateApp
 *
 *   TODO / known limitations:
 *     App.requestUrl — currently returns {}. Needs a real fetch() impl
 *                      for LiveSync support (depends on target CORS).
 *                      See PLAN.md → "Updated approach (2026-05-11): direct
 *                      fetch + CORS".
 *
 * Vault path: read from localStorage / URL params (same mechanism as desktop).
 * All FS calls get ?vault=<id> query param so the server routes to the right vault.
 *
 * Call flow is documented inline below at the "Android bridge" comment block
 * (~line 488). See also docs/investigations.md → "Capacitor plugin inventory".
 */
(function () {
  'use strict';

  // ── helpers ──────────────────────────────────────────────────────────────

  function getVaultId() {
    const params = new URLSearchParams(location.search);
    return params.get('vault') || localStorage.getItem('obsidian-web:lastVaultId') || '';
  }

  function vaultQuery() {
    const id = getVaultId();
    return id ? 'vault=' + encodeURIComponent(id) + '&' : '';
  }

  function encodePath(p) {
    return encodeURIComponent(p);
  }

  // Map Capacitor directory enum → path prefix for our FS API.
  // Android vault root is EXTERNAL; we map all vault-relative paths from there.
  function resolvePrefix(dir) {
    switch (dir) {
      case 'EXTERNAL':
      case 'DOCUMENTS':
        return '';                 // vault root
      case 'CACHE':
        return '.cache/';
      case 'DATA':
      case 'LIBRARY':
        return '.app-data/';
      default:
        return '';
    }
  }

  function fullPath(opts) {
    const prefix = opts.directory ? resolvePrefix(opts.directory) : '';
    let p = opts.path || '';
    // The mobile bundle uses the vault ID as its "base path" for the vault.
    // Strip it so paths resolve correctly against our HTTP API.
    const vaultId = getVaultId();
    if (vaultId) {
      if (p === vaultId) {
        p = '';                              // vault root stat/list
      } else if (p.startsWith(vaultId + '/')) {
        p = p.slice(vaultId.length + 1);    // vault-relative path
      }
    }
    return prefix + p;
  }

  function capError(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }

  // Convert our server's readdir array to Capacitor's expected format.
  function toCapacitorDirEntry(e) {
    return {
      name: e.name,
      type: e.isDirectory ? 'directory' : 'file',
      size: e.size,
      mtime: e.mtime,
      uri:   '',
      ctime: e.mtime,
    };
  }

  // ── Filesystem plugin ──────────────────────────────────────────────────

  const Filesystem = {

    async readFile(opts) {
      const p = fullPath(opts);
      const encoding = opts.encoding;   // 'utf8' | undefined (binary = base64)
      const url = '/api/fs/read?' + vaultQuery() + 'path=' + encodePath(p) +
        (encoding ? '&encoding=' + encoding : '');
      const res = await fetch(url);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw capError(json.code || 'ENOENT', json.error || 'readFile failed: ' + p);
      }
      if (encoding) {
        const data = await res.text();
        return { data };
      } else {
        // Binary: return base64
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let b64 = '';
        // btoa on large arrays
        const CHUNK = 8192;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return { data: btoa(b64) };
      }
    },

    async writeFile(opts) {
      const p = fullPath(opts);
      const encoding = opts.encoding;
      let body;
      let contentType = 'application/octet-stream';
      if (encoding) {
        body = opts.data;
        contentType = 'text/plain;charset=UTF-8';
      } else {
        // data is base64
        const bin = atob(opts.data || '');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        body = bytes.buffer;
      }
      const url = '/api/fs/write?' + vaultQuery() + 'path=' + encodePath(p) +
        (encoding ? '&encoding=' + encoding : '');
      const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': contentType }, body });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw capError(json.code || 'EIO', json.error || 'writeFile failed: ' + p);
      }
      return { uri: '' };
    },

    async appendFile(opts) {
      const p = fullPath(opts);
      // data is base64 (used for large binary chunk writes)
      const bin = atob(opts.data || '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = '/api/fs/append?' + vaultQuery() + 'path=' + encodePath(p);
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes.buffer,
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw capError(json.code || 'EIO', json.error || 'appendFile failed: ' + p);
      }
      return {};
    },

    async deleteFile(opts) {
      const p = fullPath(opts);
      const res = await fetch('/api/fs/unlink?' + vaultQuery() + 'path=' + encodePath(p), { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw capError(json.code || 'ENOENT', json.error || 'deleteFile failed: ' + p);
      }
      return {};
    },

    async mkdir(opts) {
      const p = fullPath(opts);
      const res = await fetch('/api/fs/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p, recursive: opts.recursive || false, vault: getVaultId() }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw capError(json.code || 'EIO', json.error || 'mkdir failed: ' + p);
      }
      return {};
    },

    async rmdir(opts) {
      const p = fullPath(opts);
      const res = await fetch('/api/fs/rmdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p, recursive: opts.recursive || false, vault: getVaultId() }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw capError(json.code || 'ENOENT', json.error || 'rmdir failed: ' + p);
      }
      return {};
    },

    async readdir(opts) {
      const p = fullPath(opts);
      const res = await fetch('/api/fs/readdir?' + vaultQuery() + 'path=' + encodePath(p));
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw capError(json.code || 'ENOENT', json.error || 'readdir failed: ' + p);
      }
      const entries = await res.json();
      return { files: entries.map(toCapacitorDirEntry) };
    },

    async stat(opts) {
      const p = fullPath(opts);
      const res = await fetch('/api/fs/stat?' + vaultQuery() + 'path=' + encodePath(p));
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw capError(json.code || 'ENOENT', json.error || 'stat failed: ' + p);
      }
      const s = await res.json();
      return {
        type:  s.isDirectory ? 'directory' : 'file',
        size:  s.size,
        mtime: s.mtime,
        ctime: s.mtime,
        uri:   '',
      };
    },

    async rename(opts) {
      const from = fullPath({ path: opts.from, directory: opts.directory });
      const to   = fullPath({ path: opts.to,   directory: opts.toDirectory || opts.directory });
      const res = await fetch('/api/fs/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath: from, newPath: to, vault: getVaultId() }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw capError(json.code || 'EIO', json.error || 'rename failed');
      }
      return {};
    },

    async copy(opts) {
      const from = fullPath({ path: opts.from, directory: opts.directory });
      const to   = fullPath({ path: opts.to,   directory: opts.toDirectory || opts.directory });
      const res = await fetch('/api/fs/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ src: from, dest: to, vault: getVaultId() }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw capError(json.code || 'EIO', json.error || 'copy failed');
      }
      return {};
    },

    async trash(opts) {
      // Map to deleteFile — we don't have a real trash on the server
      return Filesystem.deleteFile(opts);
    },

    async setTimes() { return {}; },       // no-op — server doesn't expose utimes
    async verifyIcloud() { return {}; },   // iOS iCloud check — not applicable
    async open() { return {}; },           // Android file opener — not applicable

    async checkPerms()        { return { publicStorage: 'granted' }; },
    async requestPermissions(){ return { publicStorage: 'granted' }; },
    async requestPerms()      { return { publicStorage: 'granted' }; },
    async choose()            { return null; },  // Android file picker — not supported

    async getUri(opts) {
      const p = fullPath(opts);
      const id = getVaultId();
      // Return an HTTP URL the app can fetch directly for large binary files
      const url = '/api/fs/read?' + (id ? 'vault=' + encodeURIComponent(id) + '&' : '') + 'path=' + encodePath(p);
      return { uri: location.origin + url };
    },

    // Watch API — Obsidian mobile uses these to detect external file changes.
    // We bridge to our existing WebSocket at /api/watch.
    async startWatch(opts) {
      const vaultId = getVaultId();
      if (!window.__owCapacitorWatcher) {
        const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') +
          '//' + location.host + '/api/watch?vault=' + encodeURIComponent(vaultId);
        const ws = new WebSocket(wsUrl);
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'change' || msg.type === 'add' || msg.type === 'unlink') {
              window.__owCapacitorWatcher._listeners.forEach((cb) => {
                cb({ path: msg.path });
              });
            }
          } catch (_) {}
        };
        ws.onclose = () => { window.__owCapacitorWatcher = null; };
        window.__owCapacitorWatcher = { ws, _listeners: new Set() };
      }
      return {};
    },

    async stopWatch() {
      if (window.__owCapacitorWatcher) {
        window.__owCapacitorWatcher.ws.close();
        window.__owCapacitorWatcher = null;
      }
      return {};
    },

    async watchAndStatAll(opts) {
      // Custom Obsidian API: returns full file tree snapshot + activates watcher.
      // We use our bootstrap endpoint which already has the full tree.
      await Filesystem.startWatch(opts);
      const vaultId = getVaultId();
      const res = await fetch('/api/bootstrap?vault=' + encodeURIComponent(vaultId) + '&full=1',
        { headers: { 'Accept-Encoding': 'br, gzip' } });
      if (!res.ok) throw capError('EIO', 'watchAndStatAll failed');
      const data = await res.json();
      // Convert bootstrap dirs/fs format to Capacitor's expected { children: [...] }
      const children = [];
      const dirs = data.dirs || {};
      const fsCache = data.fs || {};
      const rootEntries = dirs[''] || [];
      for (const e of rootEntries) {
        children.push({
          name: e.name,
          type: e.isDirectory ? 'directory' : 'file',
          size: e.size || 0,
          mtime: e.mtime || 0,
          uri: '',
          ctime: e.mtime || 0,
          children: e.isDirectory ? [] : undefined,
        });
      }
      return { children };
    },

    // addListener — used for file change events
    addListener(eventName, callback) {
      if (eventName === 'change') {
        if (!window.__owCapacitorWatcher) {
          Filesystem.startWatch({}).catch(() => {});
        }
        // Defer until watcher is ready
        setTimeout(() => {
          if (window.__owCapacitorWatcher) {
            window.__owCapacitorWatcher._listeners.add(callback);
          }
        }, 100);
      }
      return Promise.resolve({
        remove: () => {
          if (window.__owCapacitorWatcher) {
            window.__owCapacitorWatcher._listeners.delete(callback);
          }
        },
      });
    },
  };

  // ── Stubs for non-critical plugins ────────────────────────────────────

  function noop() { return Promise.resolve({}); }

  const Device = {
    getInfo: () => Promise.resolve({
      name: 'obsidian-web',
      model: 'Browser',
      platform: 'android',
      operatingSystem: 'android',
      osVersion: '12',
      manufacturer: 'obsidian-web',
      isVirtual: true,
    }),
    getId: () => Promise.resolve({ identifier: 'obsidian-web-id' }),
    getLanguageCode: () => Promise.resolve({ value: navigator.language || 'en' }),
  };

  const Clipboard = {
    write: ({ string }) => navigator.clipboard.writeText(string || '').then(() => ({})),
    read: () => navigator.clipboard.readText().then((value) => ({ type: 'text/plain', value })),
  };

  const Preferences = {
    get: ({ key }) => Promise.resolve({ value: localStorage.getItem('cap:' + key) }),
    set: ({ key, value }) => { localStorage.setItem('cap:' + key, value); return Promise.resolve({}); },
    remove: ({ key }) => { localStorage.removeItem('cap:' + key); return Promise.resolve({}); },
    clear: () => { /* leave localStorage alone */ return Promise.resolve({}); },
    keys: () => Promise.resolve({ keys: [] }),
  };

  const App = {
    getInfo:              () => Promise.resolve({ name: 'Obsidian', id: 'md.obsidian', build: '0', version: '1.12.7' }),
    getState:             () => Promise.resolve({ isActive: true }),
    getLaunchUrl:         () => Promise.resolve(null),
    addListener:          (opts) => Promise.resolve({ remove: noop }),
    removeAllListeners:   noop,
    exitApp:              noop,
    minimizeApp:          noop,
    setQuickActions:      noop,
    getFonts:             () => Promise.resolve({ fonts: [] }),
    takeScreenshot:       () => Promise.resolve({ base64String: '' }),
    isInstalledFromStore: () => Promise.resolve({ isFromStore: false }),
    requestUrl:           () => Promise.resolve({}),
    setBackgroundColor:   noop,
  };

  const SplashScreen = {
    hide: noop,
    show: noop,
  };

  const StatusBar = {
    setStyle: noop,
    setBackgroundColor: noop,
    show: noop,
    hide: noop,
    getInfo: () => Promise.resolve({ visible: false, style: 'DARK', color: '#000000', overlays: false }),
  };

  const Keyboard = {
    show: noop,
    hide: noop,
    addListener: (event, cb) => Promise.resolve({ remove: noop }),
    removeAllListeners: noop,
    setAccessoryBarVisible: noop,
    setScroll: noop,
    setResizeMode: noop,
    getResizeMode: () => Promise.resolve({ mode: 'none' }),
  };

  const KeepAwake = {
    keepAwake: noop,
    allowSleep: noop,
    isKeptAwake: () => Promise.resolve({ isKeptAwake: false }),
  };

  const Haptics = {
    impact: noop,
    notification: noop,
    vibrate: noop,
    selectionStart: noop,
    selectionChanged: noop,
    selectionEnd: noop,
  };

  const Browser = {
    open: ({ url }) => { window.open(url, '_blank', 'noopener'); return Promise.resolve({}); },
    close: noop,
    addListener: (event, cb) => Promise.resolve({ remove: noop }),
    removeAllListeners: noop,
  };

  const SecureStorage = {
    get: ({ key }) => Promise.resolve({ value: localStorage.getItem('sec:' + key) }),
    set: ({ key, value }) => { localStorage.setItem('sec:' + key, value); return Promise.resolve({}); },
    remove: ({ key }) => { localStorage.removeItem('sec:' + key); return Promise.resolve({}); },
    getPlatformSupportLevel: () => Promise.resolve({ value: 'none' }),
    isKeyExists: ({ key }) => Promise.resolve({ value: localStorage.getItem('sec:' + key) !== null }),
  };

  const RateApp = {
    requestReview: noop,
  };

  // ── Plugin registry ───────────────────────────────────────────────────

  const plugins = {
    Filesystem,
    Device,
    Clipboard,
    Preferences,
    App,
    SplashScreen,
    StatusBar,
    Keyboard,
    KeepAwake,
    Haptics,
    Browser,
    SecureStorage,
    RateApp,
  };

  // ── Android bridge (MUST be set before native-bridge.js runs) ────────────
  //
  // The mobile app.js checks `window.androidBridge` at module level to decide
  // the platform (not window.Capacitor.getPlatform).  If androidBridge exists,
  // getPlatformId() returns 'android', Em becomes true, and Capacitor code paths
  // are active.
  //
  // We implement the postMessage protocol so native-bridge.js routes all plugin
  // calls through androidBridge → our HTTP implementations → fromNative callback.
  //
  // Call flow:
  //   app.js plugin call
  //   → native-bridge cap.nativePromise / cap.toNative
  //   → androidBridge.postMessage(JSON.stringify({callbackId, pluginId, methodName, options}))
  //   → our router (below) → plugins[pluginId][methodName](options)
  //   → window.Capacitor.fromNative({callbackId, success, data|error})
  //   → resolves/rejects the original Promise in app.js

  function routeNativeCall(callDataJson) {
    let callData;
    try { callData = JSON.parse(callDataJson); } catch (_) { return; }

    const { callbackId, pluginId, methodName, options } = callData;

    function respond(success, dataOrError) {
      const cap = window.Capacitor;
      if (cap && typeof cap.fromNative === 'function') {
        cap.fromNative({
          callbackId,
          pluginId,
          methodName,
          success,
          data:  success ? dataOrError : undefined,
          error: success ? undefined : { message: dataOrError && dataOrError.message || String(dataOrError), code: dataOrError && dataOrError.code },
          save: false,
        });
      }
    }

    const plugin = plugins[pluginId];
    if (!plugin) {
      console.warn('[capacitor-shim] unknown plugin:', pluginId);
      respond(false, { message: 'Plugin not available: ' + pluginId });
      return;
    }
    const method = plugin[methodName];
    if (typeof method !== 'function') {
      // Silently return empty for unknown methods (e.g. optional API calls)
      respond(true, {});
      return;
    }

    Promise.resolve()
      .then(() => method.call(plugin, options || {}))
      .then((data) => respond(true, data || {}))
      .catch((err) => respond(false, err));
  }

  // Set androidBridge BEFORE native-bridge.js so getPlatformId() returns 'android'.
  if (!window.androidBridge) {
    window.androidBridge = { postMessage: routeNativeCall };
  }

  // ── Post-native-bridge overrides ──────────────────────────────────────
  // After native-bridge.js runs we patch a few more things for robustness.

  function patchCapacitor() {
    const cap = window.Capacitor;
    if (!cap) return;

    // Belt-and-suspenders: also override nativePromise in case app.js
    // calls it directly instead of via the bridge protocol.
    const _origNP = cap.nativePromise;
    cap.nativePromise = (pluginName, methodName, options) => {
      const plugin = plugins[pluginName];
      if (!plugin) return _origNP ? _origNP(pluginName, methodName, options) : Promise.resolve({});
      const method = plugin[methodName];
      if (typeof method !== 'function') return Promise.resolve({});
      return Promise.resolve().then(() => method.call(plugin, options || {}));
    };

    cap.isPluginAvailable = (name) => name in plugins;

    // convertFileSrc: large binary files (>5MB) fetched via HTTP URL
    cap.convertFileSrc = (fileUri) => {
      if (fileUri.startsWith('http')) return fileUri;
      const id = getVaultId();
      return '/api/fs/read?' + (id ? 'vault=' + encodeURIComponent(id) + '&' : '') +
        'path=' + encodeURIComponent(fileUri.replace(/^file:\/\//, ''));
    };

    // Expose plugins map
    if (!cap.Plugins) cap.Plugins = {};
    Object.assign(cap.Plugins, plugins);

    // ── PluginHeaders ────────────────────────────────────────────────────────
    // Capacitor's registerPlugin() Proxy checks c.PluginHeaders to decide which
    // methods to route to nativePromise. Without headers, every method call
    // throws "not implemented on android". We declare all methods we implement
    // (plus stubs) so the Proxy routes them to our nativePromise override.
    // rtype 'promise' = single-arg (options obj) → nativePromise
    // rtype 'callback' = two-arg (options, callback) → nativeCallback
    function pm(name) { return { name, rtype: 'promise' }; }

    cap.PluginHeaders = [
      {
        name: 'App',
        methods: [
          pm('getInfo'), pm('getState'), pm('getLaunchUrl'),
          pm('addListener'), pm('removeAllListeners'),
          pm('exitApp'), pm('minimizeApp'),
          pm('getFonts'), pm('takeScreenshot'),
          pm('isInstalledFromStore'), pm('requestUrl'),
          pm('setBackgroundColor'), pm('setQuickActions'),
        ],
      },
      {
        name: 'Filesystem',
        methods: [
          pm('readFile'), pm('writeFile'), pm('appendFile'),
          pm('deleteFile'), pm('mkdir'), pm('rmdir'),
          pm('readdir'), pm('stat'), pm('rename'), pm('copy'),
          pm('getUri'), pm('startWatch'), pm('stopWatch'),
          pm('watchAndStatAll'), pm('addListener'),
          pm('requestPermissions'), pm('requestPerms'), pm('checkPerms'),
          pm('choose'), pm('trash'), pm('setTimes'),
          pm('verifyIcloud'), pm('open'),
        ],
      },
      {
        name: 'Device',
        methods: [pm('getInfo'), pm('getId'), pm('getLanguageCode')],
      },
      {
        name: 'SplashScreen',
        methods: [pm('hide'), pm('show')],
      },
      {
        name: 'Clipboard',
        methods: [pm('read'), pm('write')],
      },
      {
        name: 'Haptics',
        methods: [
          pm('impact'), pm('notification'), pm('vibrate'),
          pm('selectionStart'), pm('selectionChanged'), pm('selectionEnd'),
        ],
      },
      {
        name: 'Keyboard',
        methods: [
          pm('show'), pm('hide'), pm('addListener'),
          pm('removeAllListeners'), pm('setAccessoryBarVisible'),
          pm('setScroll'), pm('setResizeMode'), pm('getResizeMode'),
        ],
      },
      {
        name: 'Browser',
        methods: [pm('open'), pm('close'), pm('addListener'), pm('removeAllListeners')],
      },
      {
        name: 'Preferences',
        methods: [pm('get'), pm('set'), pm('remove'), pm('clear'), pm('keys')],
      },
      {
        name: 'KeepAwake',
        methods: [pm('keepAwake'), pm('allowSleep'), pm('isKeptAwake')],
      },
      {
        name: 'SecureStorage',
        methods: [
          pm('get'), pm('set'), pm('remove'),
          pm('getPlatformSupportLevel'), pm('isKeyExists'),
        ],
      },
      {
        name: 'StatusBar',
        methods: [
          pm('setStyle'), pm('setBackgroundColor'),
          pm('show'), pm('hide'), pm('getInfo'),
        ],
      },
      {
        name: 'RateApp',
        methods: [pm('requestReview')],
      },
    ];
  }

  // Run immediately (in case native-bridge already ran) and also after DOMContentLoaded
  patchCapacitor();
  document.addEventListener('DOMContentLoaded', patchCapacitor, { once: true });

  console.log('[capacitor-shim] androidBridge installed — platform=android');
})(window);
