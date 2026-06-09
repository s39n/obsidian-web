'use strict';

/**
 * Optional API-key authentication middleware.
 * Activated when AUTH_KEY env var is set.
 *
 * The key can be supplied via:
 *   - Cookie:               obsidian-web-key=<AUTH_KEY>
 *   - Query param + login:  /__auth?key=<AUTH_KEY>
 *   - Authorization header: Bearer <AUTH_KEY>  (for API clients)
 *
 * Browser requests go to a login page; /api/* gets a 401 JSON response.
 */

const AUTH_KEY   = process.env.AUTH_KEY || '';
const COOKIE     = 'obsidian-web-key';
const MAX_AGE    = 7 * 24 * 60 * 60; // 7 days (seconds)

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';')
      .map(c => c.trim().split('='))
      .filter(p => p.length >= 2)
      .map(([k, ...v]) => [k.trim(), v.join('=')])
  );
}

function isAuthenticated(req) {
  if (parseCookies(req)[COOKIE] === AUTH_KEY) return true;
  if (req.query?.key === AUTH_KEY) return true;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ') && auth.slice(7) === AUTH_KEY) return true;
  return false;
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Obsidian Web — Sign in</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         background:#1e2127;color:#abb2bf;
         display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:#282c34;border-radius:8px;padding:2rem;
          width:100%;max-width:340px;box-shadow:0 4px 24px rgba(0,0,0,.4)}
    h1{color:#e06c75;font-size:1.2rem;margin-bottom:1.5rem;text-align:center}
    label{display:block;font-size:.82rem;margin-bottom:.35rem;color:#7f848e}
    input[type=password]{width:100%;padding:.6rem .75rem;border-radius:4px;
          border:1px solid #3e4451;background:#1e2127;color:#abb2bf;
          font-size:1rem;margin-bottom:1rem}
    button{width:100%;padding:.65rem;border:none;border-radius:4px;
           background:#e06c75;color:#fff;font-size:1rem;cursor:pointer}
    button:hover{background:#be5046}
    .err{color:#e06c75;font-size:.82rem;margin-bottom:.9rem;display:none}
    .err.show{display:block}
  </style>
</head>
<body>
  <div class="card">
    <h1>🔒 Obsidian Web</h1>
    <p class="err" id="err">Invalid key — try again.</p>
    <form id="f">
      <label for="k">Access key</label>
      <input id="k" type="password" placeholder="Enter your access key" autofocus/>
      <button type="submit">Sign in</button>
    </form>
  </div>
  <script>
    const p=new URLSearchParams(location.search);
    if(p.get('error'))document.getElementById('err').classList.add('show');
    document.getElementById('f').addEventListener('submit',e=>{
      e.preventDefault();
      const dest=p.get('next')||'/';
      location.href='/__auth?key='+encodeURIComponent(document.getElementById('k').value)
                   +'&next='+encodeURIComponent(dest);
    });
  </script>
</body>
</html>`;

/**
 * Returns an Express middleware if AUTH_KEY is set, otherwise null.
 */
function createAuthMiddleware() {
  if (!AUTH_KEY) return null;

  return function authMiddleware(req, res, next) {
    // ── Auth callback: verify key, set cookie, redirect ──
    if (req.path === '/__auth') {
      const key  = req.query?.key  || '';
      const dest = req.query?.next || '/';
      if (key === AUTH_KEY) {
        res.setHeader('Set-Cookie',
          `${COOKIE}=${AUTH_KEY}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Strict`);
        return res.redirect(dest);
      }
      return res.redirect(`/__login?error=1&next=${encodeURIComponent(dest)}`);
    }

    // ── Login page: always accessible ──
    if (req.path === '/__login') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(LOGIN_HTML);
    }

    // ── Authenticated: pass through ──
    if (isAuthenticated(req)) return next();

    // ── Unauthenticated ──
    const wantsJson = req.path.startsWith('/api/') ||
                      (req.headers.accept || '').includes('application/json');
    if (wantsJson) {
      return res.status(401).json({ error: 'Unauthorized — provide a valid Bearer token or cookie' });
    }
    res.redirect(`/__login?next=${encodeURIComponent(req.originalUrl)}`);
  };
}

module.exports = { createAuthMiddleware };
