import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, resolve, join } from 'node:path';
import { defaultAttachmentRoots } from './gmail.mjs';

/** GMAIL_ATTACHMENT_ROOTS: unset keeps the safe default folders; `*` disables
 *  the attachment-path check; a path-delimiter separated list replaces it. */
export function attachmentRoots(env = process.env) {
  const raw = env.GMAIL_ATTACHMENT_ROOTS;
  if (raw === undefined) return defaultAttachmentRoots();
  if (raw.trim() === '*') return null;
  return raw.split(delimiter).map(part => part.trim()).filter(Boolean).map(part => resolve(part));
}

export function config(env = process.env) {
  const home = join(homedir(), '.gmail-mcp');
  return {
    clientFile: resolve(env.GMAIL_CLIENT_FILE || join(home, 'client-credentials.json')),
    tokenFile: resolve(env.GMAIL_TOKEN_FILE || join(home, 'credentials.json')),
    downloadDir: resolve(env.GMAIL_DOWNLOAD_DIR || join(home, 'downloads')),
    pendingFile: resolve(env.GMAIL_PENDING_FILE || join(home, 'pending-auth.json')),
    attachmentRoots: attachmentRoots(env),
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
