# obsidian-web — developer context for Claude

## What this project is

obsidian-web loads Obsidian's original renderer (`app.js`) unmodified inside a
standard browser. Every Node.js / Electron dependency is replaced with HTTP
shims. The Node.js server provides a REST + WebSocket API that the browser-side
shims call. There is no bundling step — the browser loads `app.js` directly from
the server.

## Key files

| Path | Role |
|------|------|
| `src/client/boot.js` | Runs first. Installs polyfills (`crypto.subtle`, `crypto.randomUUID`), a defensive Capacitor `App` shim (so plugins calling `App.getLaunchUrl()` don't crash boot), then fetches the bootstrap cache and injects Obsidian's scripts. |
| `src/client/shims/original-fs.js` | Replaces Node's `fs` module. Async ops use `fetch`; sync ops use synchronous XHR via `__owSyncRequest`. |
| `src/client/shims/sync-http.js` | Implements `__owSyncRequest` / `__owSyncJson` using synchronous `XMLHttpRequest`. |
| `src/server/index.js` | Express + HTTP server. Registers all API routers. |
| `src/server/api/fs.js` | File-system REST API (`/api/fs/*`). Includes write coalescing and `mkdirRepair` for ENOTDIR vault corruption. |
| `src/server/api/pbkdf2.js` | `POST /api/pbkdf2` — offloads PBKDF2 key derivation to Node's native crypto (100k iterations in pure JS would freeze the browser for ~10 s). |
| `src/server/api/keytar.js` | `safeStorage` shim — stores plugin secrets server-side (Electron's `safeStorage` is unavailable in the browser). |
| `src/server/api/localstorage.js` | Server-backed `window.localStorage` store (`user-data/.localstorage.json`). Pairs with `src/client/shims/remote-localstorage.js`. |
| `src/client/shims/remote-localstorage.js` | Replaces `window.localStorage` with the server-backed store before app.js runs, so safeStorage tokens and app state roam across devices/origins. Keys prefixed `obsidian-web:` stay device-local. |
| `src/server/api/bootstrap.js` | `/api/bootstrap` — serves the entire vault's file tree and metadata in one compressed response so Obsidian's sync `statSync`/`readFileSync` calls hit an in-memory cache. |
| `src/server/middleware/auth.js` | Optional TOTP authentication middleware. Enabled by setting `TOTP_SECRET`. |

## Running locally (Node.js)

```bash
node scripts/update-obsidian.js   # download Obsidian's renderer into vendor/
cd src/server && npm install
npm run dev                        # auto-reload; open http://127.0.0.1:3000
```

## Docker / NAS deployment

```bash
docker compose up -d
```

### Vault path

Inside the container, the working root is `/app/user-data/`. The
`docker-compose.yml` mounts the host directory `${USER_DATA:-./user-data}` to
that path. **Vaults must live under this mount.** Place your vault at
`${USER_DATA}/<VaultName>/` on the host; it appears at
`/app/user-data/<VaultName>/` inside the container. Set `VAULT_PATH=user-data/<VaultName>`
to open it on boot.

Example `.env` for a Synology NAS:
```
USER_DATA=/volume1/obsidian
VAULT_PATH=user-data/BrainTrust
TOTP_SECRET=JBSWY3DPEHPK3PXP
PORT=3005
WATCH_POLLING=true
```

## Plain-HTTP polyfills (`src/client/boot.js`)

Browsers restrict `crypto.subtle` (SubtleCrypto) to HTTPS/localhost. On plain
HTTP (common on LAN NAS setups) the entire `crypto.subtle` object is `undefined`.
`boot.js` polyfills it in pure JS:

- **SHA-256** — pure-JS implementation used by `crypto.subtle.digest('SHA-256', ...)`
- **SHA-1** — pure-JS implementation used by `crypto.subtle.digest('SHA-1', ...)` (ion-sync `getSHA`)
- **AES-256 + AES-GCM** — forward S-box, key expansion, CTR mode, GHASH auth tag
- **PBKDF2** — offloaded to `/api/pbkdf2` (Node's native `crypto.pbkdf2`) to avoid ~10 s browser freeze for 100k iterations
- **`crypto.randomUUID`** — polyfilled using `crypto.getRandomValues`

The polyfill only activates when `crypto.subtle` is absent (`!crypto.subtle`),
so HTTPS deployments use the native browser implementation.

## Binary write fix (`src/client/shims/original-fs.js`)

`fetch(url, { body: ArrayBuffer })` sends no `Content-Type` header. Express's
`body-parser` (used by `express.raw({ type: '*/*' })`) calls `type-is` to match
the content type; `type-is` returns `false` for requests with **no** Content-Type
even when the wildcard `*/*` is specified, so the body is left unparsed and
`req.body` defaults to `{}`. Node's `fs.writeFile` then throws:

> TypeError: The 'data' argument must be … Received an instance of Object

**Fix:** `writeFileAsync` and `syncRequest` always set
`Content-Type: application/octet-stream` on PUT requests so body-parser
always parses.

## Capacitor App-plugin shim (`src/client/boot.js`)

Some community plugins bundle `@capacitor/app` and call
`Capacitor.Plugins.App.getLaunchUrl()` at startup to detect an `obsidian://`
deeplink (e.g. the **Homepage** plugin's `hasUrlParams()` →
`runOpeningBehavior()`). In the browser, `@capacitor/core` initialises with
platform `"web"` and no native `App` plugin, so `Capacitor.Plugins.App` is
`undefined`, the call throws
`TypeError: Cannot read properties of undefined (reading 'getLaunchUrl')`, and
Obsidian's loader turns it into the "An error occurred while loading Obsidian"
crash screen — one plugin takes down the whole boot.

`boot.js` installs a minimal defensive `App` stub (`getLaunchUrl` resolves to
`{ url: undefined }`, plus noop `getInfo`/`getState`/`addListener`/… ). Because
`window.Capacitor` doesn't exist at boot (the plugin's own `@capacitor/core`
bundle creates it later via `win.Capacitor = createCapacitor(win)`), the shim
intercepts assignment to `window.Capacitor` with a setter that (re)injects
`Plugins.App` the moment Capacitor is built. `@capacitor/core` preserves an
existing `cap.Plugins`, and nothing registers a real `App`, so the stub is what
plugins read. The mobile client's fuller equivalent lives in
`src/client-mobile/shims/capacitor-shim.js`.

## ENOTDIR self-repair (`src/server/api/fs.js` — `mkdirRepair`)

Sync plugins can leave a regular file at a path that should be a directory
(e.g. a previous partial sync writes `Atlas/Books` as a file before the
directory structure is created). Later, `fs.stat('Atlas/Books/note.md')`
throws `ENOTDIR`.

Two mitigations:
1. `handleError` remaps `ENOTDIR` → `ENOENT` in the JSON `code` field so
   callers treat it as "not found" and attempt a write.
2. `mkdirRepair` walks the target directory path, unlinks the first non-directory
   component it finds, then retries `mkdir -p`. The write then succeeds and the
   correct directory structure is created.

## ion-sync specifics

ion-sync is a community sync plugin using AES-GCM-256 with PBKDF2 key derivation.
On plain HTTP all of the following must be polyfilled / shimmed:

| Operation | Where handled |
|-----------|---------------|
| `crypto.subtle.importKey('raw', pw, 'PBKDF2', ...)` | boot.js polyfill |
| `crypto.subtle.deriveKey({ name: 'PBKDF2', ... })` | boot.js → `/api/pbkdf2` |
| `crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)` | boot.js polyfill |
| `crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)` | boot.js polyfill |
| `crypto.subtle.digest('SHA-256', data)` | boot.js polyfill |
| `crypto.subtle.digest('SHA-1', data)` | boot.js polyfill |
| `safeStorage.encryptString` / `decryptString` | `/api/keytar` |
| `crypto.randomUUID()` | boot.js polyfill |

## Secrets / auth

- **Never commit a real `TOTP_SECRET`** — `.env` is gitignored.
- Auth is disabled when `TOTP_SECRET` is empty.
- Generate a secret: `node -e "const {authenticator}=require('otplib');console.log(authenticator.generateSecret())"`
- Scan QR code: visit `/__totp-setup?token=YOUR_SECRET` after starting the server.
- Sessions are random per-login tokens persisted in `user-data/.sessions.json`
  (7-day expiry). Failed TOTP attempts (login and `/__totp-setup` token
  guesses) are rate-limited to 5 per IP per 15 min.
- Set `TRUST_PROXY=true` only behind a reverse proxy/tunnel so rate limiting
  keys on the `X-Forwarded-For` client IP; on a directly exposed port the
  header is client-forgeable and is ignored.
- The `/api/watch` WebSocket upgrade bypasses Express middleware; it runs the
  same session check via `verifyClient` (see `attachWatchServer`).
- `/api/vaults/open` only accepts paths under `VAULTS_ROOT` (default
  `user-data/`). Set `VAULTS_ROOT=*` to disable the restriction.
