import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { config } from './config.mjs';

// One explicit scope list: the consent URL and the post-callback validation both
// read it, so a scope cannot be granted by accident without showing up here.
// calendar.readonly is only there so calendar_list_calendars can read metadata;
// event writes use calendar.events.
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

// A loopback redirect this server never listens on. Used by --paste-begin so a
// phone (or any browser that is not on this Mac) can approve consent: the
// browser lands on a dead port, the user copies the URL out of the address bar,
// and --paste-finish exchanges the code with the PKCE verifier kept locally.
// Loopback keeps the client a "Desktop app"; Google rejects other redirects for
// that client type.
export const PASTE_REDIRECT = 'http://127.0.0.1:53682/';

export function validCallback(url, state) {
  return url.pathname === '/' && url.searchParams.get('state') === state;
}

export async function clientCredentials(cfg = config(), env = process.env) {
  if (env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET) return { client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET };
  for (const file of [cfg.clientFile, cfg.tokenFile]) {
    try {
      const document = JSON.parse(await readFile(file, 'utf8'));
      const client = document.installed || document;
      if (typeof client.client_id === 'string' && client.client_id && typeof client.client_secret === 'string' && client.client_secret) {
        return { client_id: client.client_id, client_secret: client.client_secret };
      }
    } catch { /* try the next credential source */ }
  }
  throw new Error('Configure a Google Desktop OAuth client first.');
}

async function saveToken(cfg, client, refreshToken) {
  await mkdir(dirname(cfg.tokenFile), { recursive: true, mode: 0o700 });
  const temp = cfg.tokenFile + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    await writeFile(temp, JSON.stringify({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: refreshToken }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, cfg.tokenFile);
    await chmod(cfg.tokenFile, 0o600);
  } finally { await unlink(temp).catch(() => {}); }
}

function grantedScopes(grantedScope) {
  const granted = new Set(String(grantedScope || '').split(' ').filter(Boolean));
  const missing = SCOPES.filter(scope => !granted.has(scope));
  if (missing.length) throw new Error('Required scopes were not granted: ' + missing.map(scope => scope.split('/auth/')[1] || scope).join(', '));
  return [...granted].map(scope => scope.split('/auth/')[1] || scope);
}

function consentUrl(clientId, redirect, state, challenge) {
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params;
}

/** Interactive desktop flow: loopback listener, must run on the same machine as the browser. */
export async function authorize(cfg = config()) {
  const client = await clientCredentials(cfg);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let redirect, claimed = false;
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  redirect = `http://127.0.0.1:${server.address().port}/`;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Authorization timed out.')), 5 * 60 * 1000);
    server.on('request', async (req, res) => {
      const url = new URL(req.url || '/', redirect);
      if (req.method !== 'GET' || !validCallback(url, state) || claimed) { res.writeHead(400); res.end('Invalid OAuth callback.'); return; }
      if (url.searchParams.has('error')) { res.writeHead(400); res.end('Authorization declined.'); clearTimeout(timer); reject(new Error('Authorization declined.')); return; }
      const code = url.searchParams.get('code');
      if (!code) { res.writeHead(400); res.end('Missing authorization code.'); return; }
      claimed = true;
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Authorization received. Check the terminal for completion.');
      try {
        const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
          body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, client_secret: client.client_secret, code, redirect_uri: redirect, code_verifier: verifier }),
          signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('OAuth token exchange failed.');
        const tokens = await response.json();
        if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) throw new Error('No refresh token received; repeat authorization with consent.');
        grantedScopes(tokens.scope);
        await saveToken(cfg, client, tokens.refresh_token);
        clearTimeout(timer); resolve();
      } catch (error) { clearTimeout(timer); reject(error); }
    });
  });
  console.error('Open this URL in your browser:\n' + consentUrl(client.client_id, redirect, state, challenge));
  try { await result; console.error('Credentials saved. You can start the MCP server.'); }
  finally { server.close(); server.closeAllConnections(); }
}

/** Step 1 of the paste-back flow: print a consent URL and remember the PKCE verifier locally. */
export async function beginPasteAuth(cfg = config()) {
  const client = await clientCredentials(cfg);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  await mkdir(dirname(cfg.pendingFile), { recursive: true, mode: 0o700 });
  await writeFile(cfg.pendingFile, JSON.stringify({ state, verifier, redirect: PASTE_REDIRECT, createdAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  return { url: consentUrl(client.client_id, PASTE_REDIRECT, state, challenge), redirect: PASTE_REDIRECT, pendingFile: cfg.pendingFile };
}

/** Step 2: exchange the pasted callback URL for a refresh token (PKCE verifier stays here). */
export async function finishPasteAuth(cfg = config(), callbackUrl, fetchImpl = fetch) {
  const raw = String(callbackUrl || '').trim();
  let url;
  try { url = new URL(raw); } catch { throw new Error('Callback URL is not a valid URL.'); }
  let pending;
  try { pending = JSON.parse(await readFile(cfg.pendingFile, 'utf8')); }
  catch { throw new Error('No pending authorization found; run the begin step first.'); }
  if (url.searchParams.get('state') !== pending.state) throw new Error('Callback state does not match the pending request.');
  if (url.searchParams.has('error')) throw new Error('Authorization declined: ' + String(url.searchParams.get('error')).slice(0, 80));
  const code = url.searchParams.get('code');
  if (!code) throw new Error('Callback URL has no code parameter.');
  const client = await clientCredentials(cfg);
  const response = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, client_secret: client.client_secret, code, redirect_uri: pending.redirect, code_verifier: pending.verifier }),
    signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('OAuth token exchange failed (HTTP ' + response.status + ').');
  const tokens = await response.json();
  if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) throw new Error('No refresh token received; repeat authorization with consent.');
  const scopes = grantedScopes(tokens.scope);
  await saveToken(cfg, client, tokens.refresh_token);
  await unlink(cfg.pendingFile).catch(() => {});
  return { saved: true, scopes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] || '--loopback';
  const cfg = config();
  const run = async () => {
    if (mode === '--paste-begin') {
      const { url, redirect } = await beginPasteAuth(cfg);
      console.log(url);
      console.error(`Approve consent on any device, then finish with: npm run auth -- --paste-finish <redirected URL>\nRedirect target: ${redirect}`);
      return;
    }
    if (mode === '--paste-finish') {
      let raw = process.argv[3];
      if (!raw) {
        const reader = createInterface({ input: process.stdin });
        raw = await reader.question('Paste the full redirected URL: ');
        reader.close();
      }
      const result = await finishPasteAuth(cfg, raw);
      console.error('Credentials saved. Scopes: ' + result.scopes.join(' '));
      return;
    }
    await authorize(cfg);
  };
  run().catch(error => { console.error('Authorization failed: ' + String(error.message || error).slice(0, 300)); process.exitCode = 1; });
}
