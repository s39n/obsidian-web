# obsidian-web

Run Obsidian's desktop app in a standard browser — no Electron needed.

**[Live Demo →](https://obsidian-web.tzlev.ovh)**

obsidian-web loads Obsidian's original renderer (`app.js`) completely unmodified and replaces every Node.js / Electron dependency with lightweight HTTP shims. The result is real Obsidian running in any modern browser.

### What works

- Full Markdown editing and preview (CodeMirror + Obsidian's renderer)
- File tree, tabs, split panes, graph view
- Bidirectional links and backlinks
- Search and command palette
- Core plugins (file explorer, tags, bookmarks, outgoing links, etc.)
- Real-time sync across tabs via WebSocket
- RTL / Unicode support

### Fast bootstrap

The browser version can load faster than the desktop app. Instead of Obsidian reading dozens of config files one by one from disk, everything is served in a single HTTP request (`/api/bootstrap`) — all files, directories, and metadata arrive at once, before Obsidian even starts running. When it calls `statSync` or `readFileSync`, the answer is already waiting in memory.

### Two deployment modes

| | **Node.js server** | **Cloudflare Workers** |
|---|---|---|
| Path | `server/` | `cf/` |
| Storage | Real filesystem | Durable Object (in-memory) |
| Persistence | Full | R2 (optional) or reset every N hours |
| Use case | Personal use, self-hosted | Public demo, zero-maintenance |
| URL | `http://localhost:3000` | [obsidian-web.tzlev.ovh](https://obsidian-web.tzlev.ovh) |

---

## Setup (Node.js server)

Download and extract the latest Obsidian renderer files:

```bash
node scripts/update-obsidian.js
```

Install and run the backend:

```bash
cd server
npm install
npm run dev   # auto-reloads on file changes (uses node --watch)
```

For production (no reload overhead):
```bash
npm start
```

Open `http://127.0.0.1:3000`.

Open `http://127.0.0.1:3000/starter` to manage recent vaults and add a
server folder path as a vault.

## Obsidian Version

`obsidian/` is generated from the official `obsidianmd/obsidian-releases` GitHub releases and is intentionally ignored by Git.

Useful commands:

```bash
# latest stable release
node scripts/update-obsidian.js

# specific release
node scripts/update-obsidian.js --version 1.12.7

# re-download even if cached
node scripts/update-obsidian.js --force

# remove cached .asar.gz/.asar after a successful extraction
node scripts/update-obsidian.js --no-cache
```

The updater uses the official `obsidian-<version>.asar.gz` release asset, verifies the SHA-256 digest when GitHub provides one, extracts it locally, validates required renderer files, then replaces `obsidian/`.

### Mobile bundle (`obsidian-mobile/`)

The project ships **two runtimes** — a desktop one at `/` and a mobile one at `/mobile`. The mobile runtime needs the Obsidian Android APK bundle, extracted into `obsidian-mobile/`. Like `obsidian/`, this directory is gitignored and downloaded on demand:

```bash
# extract obsidian-mobile/ from the latest Android APK release
node scripts/update-obsidian-mobile.js

# specific version
node scripts/update-obsidian-mobile.js --version 1.12.7
```

This script downloads the official APK, unpacks the `assets/public/` tree to `obsidian-mobile/`, and **applies three build-time patches** to `obsidian-mobile/app.js` (via `scripts/patch-obsidian-mobile.js`) that expose `window.__owPlatform` and merge `window.__owPlatformOverrides` so the layout switcher plugin works. If a patch fails to match, the script aborts loudly — that's our signal that the Obsidian minifier changed.

Both runtimes share the same server. Run **both updater scripts** if you want `/` and `/mobile` to work. If you only want one of them, you can run just the corresponding script.

| Runtime URL | Updater | Notes |
|---|---|---|
| `/` (desktop) | `node scripts/update-obsidian.js` | Required for legacy fallback |
| `/mobile` | `node scripts/update-obsidian-mobile.js` | **Preferred runtime.** Applies patches automatically. |

## Configuration

Server environment variables:

- `PORT`: HTTP port, default `3000`.
- `HOST`: bind address, default `127.0.0.1`.
- `VAULT_PATH`: vault path relative to the project root or absolute, default `test-vault`.
- `VAULT_REGISTRY`: recent-vault registry JSON path, default `data/vaults.json`.

## Deployment

## Cloudflare Workers demo (`cf/`)

A standalone deployment that runs entirely on Cloudflare's edge — no server to maintain.

```bash
cd cf
npm install
npm run deploy
```

### Architecture

```
Browser → CF Worker → Durable Object (VaultDO)
             ↓
       /api/* → DO (vault in memory)
       other  → static assets (CF CDN)
```

The Durable Object holds the entire vault in a `Map<path, {content, mtime, size}>`. A single `/api/bootstrap` call preloads all files and directory listings so Obsidian can boot with minimal latency.

### Demo mode (`DEMO_MODE=true`)

- Vault is initialized from a template on cold start
- Resets automatically every N hours via DO alarm
- Core template files (Welcome, How It Works, etc.) are protected from deletion
- No auth required — anyone can visit and try it

### Personal mode (`DEMO_MODE=false`)

- Writes persist to R2
- Requires `API_KEY` secret for access
- No automatic reset

### Configuration

Environment variables in `wrangler.toml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `DEMO_MODE` | `"true"` | Enable demo mode (in-memory, auto-reset) |
| `RESET_INTERVAL_HOURS` | `"4"` | Hours between automatic vault resets |
| `API_KEY` | — | Required when `DEMO_MODE=false` (set via `wrangler secret put API_KEY`) |

### Key files

| File | Purpose |
|------|---------|
| `cf/src/index.js` | Worker entry: routes `/api/*` to DO, else to CDN |
| `cf/src/vault-do.js` | Durable Object: vault state, WebSocket, alarm reset |
| `cf/src/template.js` | Demo vault content (loaded on cold start / reset) |
| `cf/src/api/bootstrap.js` | Single-shot preload: electron IPC + fs + dirs |
| `cf/src/api/fs.js` | REST file system (stat, read, write, readdir, etc.) |
| `cf/src/api/electron.js` | IPC channel stubs |
| `cf/public/client/boot.js` | Installs `window.require`, fetches bootstrap, injects scripts |
| `cf/public/client/shims/*` | Browser shims for Node/Electron modules |

---

## Node.js deployment

The Node.js server (`server/`) can be deployed to any Linux box. A typical setup:

1. Clone the repo and run `node scripts/update-obsidian.js` to get Obsidian's renderer files
2. `cd server && npm install && npm start`
3. Put it behind a reverse proxy (nginx, Caddy, Cloudflare Tunnel) with HTTPS
4. Do not expose the server directly to the internet without auth — there is no application-level authentication

## Notes

- Obsidian's extracted files are treated as third-party artifacts. Do not edit files under `obsidian/`; update wrappers/shims instead.
- The default test vault is `test-vault/`.
- The current starter folder picker is prompt-based: enter an absolute server path.
- Do not bind the server to a public IP without a tunnel or auth layer in front.
- Current architecture and roadmap are in `PLAN.md`.

## Disclaimer

This is an **educational proof-of-concept** exploring how Electron-based apps can run in a standard browser. It is not affiliated with, endorsed by, or associated with [Obsidian](https://obsidian.md) or Dynalist Inc.

This repository does **not** include Obsidian's source code. The `obsidian/` directory is gitignored — users must download Obsidian's renderer themselves using the provided setup script. Obsidian's code remains the property of Dynalist Inc. under their [Terms of Service](https://obsidian.md/terms).

If the Obsidian team has any concerns about this project, please [open an issue](https://github.com/MusiCode1/obsidian-web/issues) and we will address them promptly.

## Credits

Built by [MusiCode1](https://github.com/MusiCode1) and [Claude Code](https://claude.ai/code).
