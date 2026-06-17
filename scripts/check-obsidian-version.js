#!/usr/bin/env node
'use strict';

/**
 * check-obsidian-version.js
 *
 * Dependency-free "is there a newer Obsidian renderer?" check.
 *
 * It compares the version currently extracted into vendor/obsidian/ against the
 * latest release published to the obsidianmd/obsidian-releases GitHub repo, and
 * reports whether an update is available. It NEVER downloads or applies the
 * update — that stays a deliberate, manual step:
 *
 *     node scripts/update-obsidian.js              # latest
 *     node scripts/update-obsidian.js --version X  # a specific version
 *
 * Usage (CLI):
 *   node scripts/check-obsidian-version.js          # human-readable status
 *   node scripts/check-obsidian-version.js --json   # machine-readable JSON
 *
 * Usage (module):
 *   const { checkObsidianVersion } = require('./check-obsidian-version');
 *   const result = await checkObsidianVersion();
 *   // { installed, latest, pinned, updateAvailable, checked, reason }
 *
 * Environment:
 *   OBSIDIAN_VERSION       Pin to a specific version (e.g. 1.12.7). When set,
 *                          the check compares the installed version against the
 *                          pin instead of GitHub's latest, and never reports a
 *                          newer release as "available".
 *   OBSIDIAN_UPDATE_CHECK  Set to "false"/"0"/"off" to disable the network
 *                          check entirely (the server still calls it but it
 *                          short-circuits). Default: enabled.
 *   OBSIDIAN_CHECK_TIMEOUT Network timeout in ms for the GitHub request.
 *                          Default: 5000.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const VENDOR_PKG = path.join(PROJECT_ROOT, 'vendor', 'obsidian', 'package.json');
const GITHUB_LATEST_API =
  'https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest';
const USER_AGENT = 'obsidian-web-updater';
const DEFAULT_TIMEOUT = 5000;

function isCheckDisabled() {
  const raw = (process.env.OBSIDIAN_UPDATE_CHECK || '').trim().toLowerCase();
  return raw === 'false' || raw === '0' || raw === 'off' || raw === 'no';
}

function pinnedVersion() {
  const raw = (process.env.OBSIDIAN_VERSION || '').trim();
  return raw ? raw.replace(/^v/i, '') : null;
}

/**
 * Read the version actually extracted into vendor/obsidian/. Falls back to the
 * server's config APP_VERSION when the vendor dir has not been populated yet
 * (e.g. before the first-run download), and finally to null.
 */
function readInstalledVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(VENDOR_PKG, 'utf8'));
    if (pkg && pkg.version) return String(pkg.version).replace(/^v/i, '');
  } catch (_) {
    /* vendor not populated yet */
  }
  try {
    // Lazy require so this script stays usable outside the server tree.
    const cfg = require(path.join(PROJECT_ROOT, 'src', 'server', 'config'));
    if (cfg && cfg.appVersion) return String(cfg.appVersion).replace(/^v/i, '');
  } catch (_) {
    /* config not importable in this context */
  }
  return null;
}

/**
 * Compare two dotted version strings numerically.
 * Returns 1 if a > b, -1 if a < b, 0 if equal. Non-numeric / missing parts
 * are treated as 0, so "1.12" === "1.12.0".
 */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function fetchLatestTag(timeout) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      GITHUB_LATEST_API,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': USER_AGENT,
        },
        timeout,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          // The latest endpoint shouldn't redirect, but follow once to be safe.
          https
            .get(
              res.headers.location,
              { headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT }, timeout },
              (r2) => collect(r2, resolve, reject),
            )
            .on('error', reject);
          return;
        }
        collect(res, resolve, reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`GitHub request timed out after ${timeout}ms`)));
    req.on('error', reject);
  });
}

function collect(res, resolve, reject) {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    reject(new Error(`GitHub API returned HTTP ${res.statusCode}`));
    return;
  }
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => {
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const tag = data.tag_name || data.name;
      if (!tag) {
        reject(new Error('GitHub response did not include a tag_name'));
        return;
      }
      resolve(String(tag).replace(/^v/i, ''));
    } catch (err) {
      reject(err);
    }
  });
  res.on('error', reject);
}

/**
 * Perform the check. Always resolves (never throws) so callers can fire it at
 * startup without guarding. Network / parse failures are reported via
 * `checked: false` + `reason`.
 */
async function checkObsidianVersion(opts = {}) {
  const installed = readInstalledVersion();
  const pinned = pinnedVersion();
  const timeout = Number(process.env.OBSIDIAN_CHECK_TIMEOUT) || opts.timeout || DEFAULT_TIMEOUT;

  if (isCheckDisabled()) {
    return { installed, latest: null, pinned, updateAvailable: false, checked: false, reason: 'disabled' };
  }

  // Pinned mode: compare installed against the pin, no network needed.
  if (pinned) {
    const updateAvailable = installed ? compareVersions(pinned, installed) > 0 : true;
    return { installed, latest: pinned, pinned, updateAvailable, checked: true, reason: 'pinned' };
  }

  let latest = null;
  try {
    latest = await fetchLatestTag(timeout);
  } catch (err) {
    return {
      installed,
      latest: null,
      pinned,
      updateAvailable: false,
      checked: false,
      reason: err.message || String(err),
    };
  }

  const updateAvailable = installed ? compareVersions(latest, installed) > 0 : true;
  return { installed, latest, pinned, updateAvailable, checked: true, reason: 'ok' };
}

function formatNotice(result) {
  if (!result.checked) {
    if (result.reason === 'disabled') return '[update-check] Obsidian update check disabled (OBSIDIAN_UPDATE_CHECK).';
    return `[update-check] Could not check for a newer Obsidian release: ${result.reason}`;
  }
  if (result.updateAvailable) {
    const from = result.installed || 'unknown';
    return [
      '==========================================',
      `  Obsidian update available: ${from} -> ${result.latest}`,
      '  Apply it with:',
      '    node scripts/update-obsidian.js',
      '    node scripts/update-obsidian-mobile.js   # mobile renderer',
      '==========================================',
    ].join('\n');
  }
  return `[update-check] Obsidian renderer is up to date (${result.installed || result.latest}).`;
}

async function main() {
  const asJson = process.argv.includes('--json');
  const result = await checkObsidianVersion();
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatNotice(result));
  }
  // Exit 0 when up to date / not checkable, 10 when an update is available, so
  // CI / cron can branch on it without parsing stdout.
  process.exitCode = result.updateAvailable ? 10 : 0;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exitCode = 1;
  });
}

module.exports = { checkObsidianVersion, compareVersions, formatNotice };
