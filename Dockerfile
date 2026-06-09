# ── Stage 1: download Obsidian renderer files ─────────────────────────────────
# Both scripts use only Node built-ins (https, zlib, crypto, fs) — no npm install needed.
FROM node:20-alpine AS obsidian-dl
WORKDIR /app
# unzip is required by update-obsidian-mobile.js (extracts assets from the APK)
RUN apk add --no-cache unzip
COPY scripts/ scripts/
RUN node scripts/update-obsidian.js \
 && node scripts/update-obsidian-mobile.js

# ── Stage 2: production image ──────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# App source and default vault
COPY src/ src/
COPY user-data/ user-data/

# Pre-downloaded Obsidian renderer bundles (not in git, built in stage 1)
COPY --from=obsidian-dl /app/vendor/ vendor/

# Install server dependencies (production only, no devDeps)
RUN cd src/server && npm ci --omit=dev

EXPOSE 3000

# HOST must be 0.0.0.0 inside a container — 127.0.0.1 would refuse outside connections
ENV HOST=0.0.0.0
ENV PORT=3000
ENV VAULT_PATH=user-data/demo-vault
# Optional auth (see docker-compose.auth-key.yml):
# ENV AUTH_KEY=change-me

# Run from repo root so PROJECT_ROOT resolves correctly via __dirname
CMD ["node", "src/server/index.js"]
