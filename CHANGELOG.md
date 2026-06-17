# Changelog

All notable changes to this project are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **Obsidian update notifications (notify-only).** The server now checks
  `obsidianmd/obsidian-releases` at startup and logs a notice when a newer
  renderer is available. It never downloads or applies the update
  automatically; applying stays the deliberate `node scripts/update-obsidian.js`
  step. (2026-06-17)
- `scripts/check-obsidian-version.js` — dependency-free, offline-safe version
  check usable both as a module (called by the server at boot) and as a CLI
  (`--json` for machine output; exit code 10 when an update is available).
- Environment variables `OBSIDIAN_UPDATE_CHECK` (disable the check),
  `OBSIDIAN_VERSION` (pin a version / compare without network), and
  `OBSIDIAN_CHECK_TIMEOUT` (GitHub request timeout). See README.
