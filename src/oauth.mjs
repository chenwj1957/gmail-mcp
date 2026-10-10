import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.mjs';

export function validCallback(url, state) {
  return url.pathname === '/' && url.searchParams.get('state') === state;
}
export async function authorize(cfg = config()) {
  const document = JSON.parse(await readFile(cfg.clientFile, 'utf8'));
  const client = document.installed || document;
  for (const key of ['client_id', 'client_secret']) if (typeof client[key] !== 'string' || !client[key] || client[key].startsWith('YOUR_')) throw new Error('Configure a Google Desktop OAuth client first.');
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
        const granted = new Set(String(tokens.scope || '').split(' '));
        for (const scope of ['gmail.readonly', 'gmail.compose']) if (!granted.has('https://www.googleapis.com/auth/' + scope)) throw new Error('Required Gmail scopes were not granted.');
        await mkdir(dirname(cfg.tokenFile), { recursive: true, mode: 0o700 });
        const temp = cfg.tokenFile + '.' + randomBytes(8).toString('hex') + '.tmp';
        try {
          await writeFile(temp, JSON.stringify({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: tokens.refresh_token }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          await rename(temp, cfg.tokenFile); await chmod(cfg.tokenFile, 0o600);
        } finally { await unlink(temp).catch(() => {}); }
        clearTimeout(timer); resolve();
      } catch (error) { clearTimeout(timer); reject(error); }
    });
  });
  const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' });
  console.error('Open this URL in your browser:\nhttps://accounts.google.com/o/oauth2/v2/auth?' + params);
  try { await result; console.error('Gmail credentials saved. You can start the MCP server.'); }
  finally { server.close(); server.closeAllConnections(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  authorize().catch(() => { console.error('Gmail authorization failed. Check client configuration and try again.'); process.exitCode = 1; });
}
