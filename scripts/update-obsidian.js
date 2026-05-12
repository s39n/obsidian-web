#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const https = require('https');
const path = require('path');
const { pipeline } = require('stream/promises');
const zlib = require('zlib');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(PROJECT_ROOT, '.tmp', 'cache', 'obsidian-releases');
const TARGET_DIR = path.join(PROJECT_ROOT, 'vendor', 'obsidian');
const EXTRACT_WORKDIR = path.join(PROJECT_ROOT, '.tmp', 'obsidian-extract');
const GITHUB_RELEASES_API = 'https://api.github.com/repos/obsidianmd/obsidian-releases/releases';
const USER_AGENT = 'obsidian-web-updater';

const REQUIRED_FILES = [
  'app.css',
  'app.js',
  'i18n.js',
  'package.json',
  'sim.js',
  'worker.js',
];

function parseArgs(argv) {
  const opts = { version: null, force: false, keepCache: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error('--version requires a version value, e.g. --version 1.12.7');
      }
      opts.version = value;
    } else if (arg.startsWith('--version=')) {
      const value = arg.slice('--version='.length);
      if (!value) throw new Error('--version requires a version value, e.g. --version=1.12.7');
      opts.version = value;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--no-cache') {
      opts.keepCache = false;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/update-obsidian.js [options]\n\nOptions:\n  --version <version>  Download a specific Obsidian version or tag, e.g. 1.12.7 or v1.12.7\n  --force              Re-download even if the cached archive already exists\n  --no-cache           Delete the downloaded .asar.gz and .asar after extraction\n  -h, --help           Show this help\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(label, fn, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err.retryable === false || attempt === attempts) break;
      console.warn(`${label} failed (${err.message}); retrying ${attempt + 1}/${attempts}...`);
      await sleep(attempt * 1000);
    }
  }
  throw lastErr;
}

function request(url, { json = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: json ? 'application/vnd.github+json' : 'application/octet-stream',
        'User-Agent': USER_AGENT,
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(request(new URL(res.headers.location, url).toString(), { json }));
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const err = new Error(`HTTP ${res.statusCode} for ${url}: ${Buffer.concat(chunks).toString('utf8').slice(0, 500)}`);
          err.retryable = res.statusCode >= 500;
          reject(err);
        });
        return;
      }

      resolve(res);
    });
    req.on('error', (err) => {
      err.retryable = true;
      reject(err);
    });
  });
}

async function getJson(url) {
  return withRetries(`GET ${url}`, async () => {
    const res = await request(url, { json: true });
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  });
}

async function fetchRelease(version) {
  if (!version) return getJson(`${GITHUB_RELEASES_API}/latest`);
  const tag = version.startsWith('v') ? version : `v${version}`;
  return getJson(`${GITHUB_RELEASES_API}/tags/${encodeURIComponent(tag)}`);
}

function findAsarAsset(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const exact = assets.find((asset) => /^obsidian-\d+\.\d+\.\d+\.asar\.gz$/i.test(asset.name));
  if (exact) return exact;
  return assets.find((asset) => asset.name.toLowerCase().endsWith('.asar.gz'));
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadFile(asset, destination, force) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  if (!force && await fileExists(destination)) {
    console.log(`Using cached ${path.relative(PROJECT_ROOT, destination)}`);
    return;
  }

  console.log(`Downloading ${asset.name}`);
  await withRetries(`download ${asset.name}`, async () => {
    const tmp = `${destination}.download`;
    await fsp.rm(tmp, { force: true });
    try {
      const res = await request(asset.browser_download_url);
      await pipeline(res, fs.createWriteStream(tmp));
      await fsp.rename(tmp, destination);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  });
}

async function verifyDigest(asset, filePath) {
  if (!asset.digest || !asset.digest.startsWith('sha256:')) return;
  const expected = asset.digest.slice('sha256:'.length).toLowerCase();
  const actual = await sha256(filePath);
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${path.basename(filePath)}. Expected ${expected}, got ${actual}`);
  }
  console.log(`Verified SHA-256: ${actual}`);
}

async function gunzip(source, destination, force) {
  if (!force && await fileExists(destination)) {
    console.log(`Using cached ${path.relative(PROJECT_ROOT, destination)}`);
    return;
  }

  const tmp = `${destination}.tmp`;
  await fsp.rm(tmp, { force: true });
  console.log(`Decompressing ${path.basename(source)}`);
  await pipeline(
    fs.createReadStream(source),
    zlib.createGunzip(),
    fs.createWriteStream(tmp),
  );
  await fsp.rename(tmp, destination);
}

function readAsarHeader(buffer) {
  if (buffer.length < 16) throw new Error('Invalid ASAR archive: header is too small');
  const firstPicklePayloadSize = buffer.readUInt32LE(0);
  const headerSize = buffer.readUInt32LE(4);
  const headerJsonSize = buffer.readUInt32LE(12);

  if (firstPicklePayloadSize !== 4) {
    throw new Error(`Unsupported ASAR archive: expected first pickle payload size 4, got ${firstPicklePayloadSize}`);
  }

  const jsonStart = 16;
  const jsonEnd = jsonStart + headerJsonSize;
  const dataStart = 8 + headerSize;
  if (jsonEnd > buffer.length || dataStart > buffer.length) {
    throw new Error('Invalid ASAR archive: header points outside file');
  }

  return {
    header: JSON.parse(buffer.subarray(jsonStart, jsonEnd).toString('utf8')),
    dataStart,
  };
}

function safeJoin(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to extract path outside target directory: ${relativePath}`);
  }
  return resolved;
}

async function extractEntry(buffer, dataStart, entry, targetRoot, relativePath, stats) {
  if (entry.files) {
    await fsp.mkdir(safeJoin(targetRoot, relativePath), { recursive: true });
    const names = Object.keys(entry.files);
    for (const name of names) {
      await extractEntry(
        buffer,
        dataStart,
        entry.files[name],
        targetRoot,
        path.join(relativePath, name),
        stats,
      );
    }
    return;
  }

  if (entry.link) {
    const target = safeJoin(targetRoot, relativePath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.symlink(entry.link, target);
    stats.files += 1;
    return;
  }

  if (entry.unpacked) {
    throw new Error(`ASAR contains unpacked file that is unavailable in .asar.gz: ${relativePath}`);
  }

  const size = Number(entry.size || 0);
  const offset = dataStart + Number(entry.offset || 0);
  const end = offset + size;
  if (!Number.isFinite(offset) || !Number.isFinite(size) || offset < dataStart || end > buffer.length) {
    throw new Error(`Invalid ASAR file entry: ${relativePath}`);
  }

  const target = safeJoin(targetRoot, relativePath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, buffer.subarray(offset, end));
  if (entry.executable) await fsp.chmod(target, 0o755);
  stats.files += 1;
  stats.bytes += size;
}

async function extractAsar(asarPath, targetRoot) {
  await fsp.rm(targetRoot, { recursive: true, force: true });
  await fsp.mkdir(targetRoot, { recursive: true });

  console.log(`Extracting ${path.basename(asarPath)}`);
  const buffer = await fsp.readFile(asarPath);
  const { header, dataStart } = readAsarHeader(buffer);
  const stats = { files: 0, bytes: 0 };
  await extractEntry(buffer, dataStart, header, targetRoot, '', stats);
  console.log(`Extracted ${stats.files} files (${stats.bytes} bytes)`);
}

async function validateObsidianDir(dir) {
  for (const file of REQUIRED_FILES) {
    const fullPath = path.join(dir, file);
    const stat = await fsp.stat(fullPath).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new Error(`Extracted Obsidian directory is missing required file: ${file}`);
    }
  }

  const packageJson = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
  if (!packageJson.version) {
    throw new Error('Extracted Obsidian package.json does not contain a version');
  }
  return packageJson.version;
}

async function replaceDirectory(source, target) {
  const backup = `${target}.prev-${Date.now()}`;
  const hasExistingTarget = await fileExists(target);

  if (hasExistingTarget) await fsp.rename(target, backup);
  try {
    await fsp.rename(source, target);
    if (hasExistingTarget) await fsp.rm(backup, { recursive: true, force: true });
  } catch (err) {
    if (await fileExists(source)) await fsp.rm(source, { recursive: true, force: true });
    if (hasExistingTarget && await fileExists(backup) && !await fileExists(target)) {
      await fsp.rename(backup, target);
    }
    throw err;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const release = await fetchRelease(opts.version);
  const asset = findAsarAsset(release);
  if (!asset) {
    throw new Error(`Release ${release.tag_name || opts.version || 'latest'} does not include an obsidian-*.asar.gz asset`);
  }

  const version = (release.tag_name || asset.name).replace(/^v/, '');
  const gzPath = path.join(CACHE_DIR, asset.name);
  const asarPath = path.join(CACHE_DIR, asset.name.replace(/\.gz$/i, ''));
  await fsp.mkdir(EXTRACT_WORKDIR, { recursive: true });
  const tmpExtractDir = path.join(EXTRACT_WORKDIR, `obsidian.tmp-${Date.now()}`);

  console.log(`Obsidian release: ${release.name || version} (${release.tag_name || 'latest'})`);
  console.log(`Selected asset: ${asset.name}`);

  await downloadFile(asset, gzPath, opts.force);
  await verifyDigest(asset, gzPath);
  await gunzip(gzPath, asarPath, opts.force);
  await extractAsar(asarPath, tmpExtractDir);

  const extractedVersion = await validateObsidianDir(tmpExtractDir);
  await replaceDirectory(tmpExtractDir, TARGET_DIR);
  console.log(`Updated ${path.relative(PROJECT_ROOT, TARGET_DIR)} to Obsidian ${extractedVersion}`);

  if (!opts.keepCache) {
    await fsp.rm(gzPath, { force: true });
    await fsp.rm(asarPath, { force: true });
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
