import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

export function config(env = process.env) {
  const home = join(homedir(), '.gmail-mcp');
  return {
    clientFile: resolve(env.GMAIL_CLIENT_FILE || join(home, 'client-credentials.json')),
    tokenFile: resolve(env.GMAIL_TOKEN_FILE || join(home, 'credentials.json')),
    downloadDir: resolve(env.GMAIL_DOWNLOAD_DIR || join(home, 'downloads')),
    pendingFile: resolve(env.GMAIL_PENDING_FILE || join(home, 'pending-auth.json')),
  };
}

export async function credentials(cfg, env = process.env) {
  if (env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN) {
    return { client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET, refresh_token: env.GMAIL_REFRESH_TOKEN };
  }
  let data;
  try { data = JSON.parse(await readFile(cfg.tokenFile, 'utf8')); }
  catch { throw new Error('Gmail credentials unavailable. Run npm run auth or configure the three GMAIL credential environment variables.'); }
  for (const name of ['client_id', 'client_secret', 'refresh_token']) {
    if (typeof data[name] !== 'string' || !data[name].trim()) throw new Error('Invalid Gmail credential configuration.');
  }
  return data;
}
