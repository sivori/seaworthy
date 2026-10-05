// A minimal App Store Connect client: an ES256 JWT and a fetch wrapper.
//
// Dependency-free on purpose: a plugin that needs `npm install` before its
// first run is a plugin that breaks on first run. Apple's tokens are ES256 over
// the .p8, and Node's crypto signs them directly as long as
// `dsaEncoding: 'ieee-p1363'` is passed; the default DER encoding is silently
// rejected by Apple as a malformed signature.

import { readFileSync, existsSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = 'https://api.appstoreconnect.apple.com';

/**
 * Empty strings count as unset, and so does an unsubstituted placeholder:
 * an unfilled userConfig can arrive as "" or as the literal "${user_config.x}".
 */
const pick = (...vals) => vals.find((v) => typeof v === 'string' && v.trim() !== '' && !v.includes('${'))?.trim();

/**
 * Credentials come from the plugin's userConfig (SHIPWRIGHT_* env for the MCP
 * server, CLAUDE_PLUGIN_OPTION_* for hooks), then the ASC_* variables other
 * App Store Connect tooling already uses.
 * @returns {{ keyId: string, issuer: string, keyPath: string } | { error: string }}
 */
export function resolveCreds(env = process.env) {
  const keyId = pick(env.SHIPWRIGHT_KEY_ID, env.CLAUDE_PLUGIN_OPTION_KEY_ID, env.ASC_KEY_ID);
  const issuer = pick(env.SHIPWRIGHT_ISSUER_ID, env.CLAUDE_PLUGIN_OPTION_ISSUER_ID, env.ASC_ISSUER_ID);
  if (!keyId || !issuer) {
    return { error: 'App Store Connect API key not configured. Set key_id and issuer_id in the shipwright plugin settings (/plugin → shipwright → Configure), or ASC_KEY_ID / ASC_ISSUER_ID in the environment.' };
  }
  const expand = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
  const keyPath = expand(
    pick(env.SHIPWRIGHT_KEY_PATH, env.CLAUDE_PLUGIN_OPTION_KEY_PATH, env.ASC_KEY_PATH) ||
      `~/.appstoreconnect/private_keys/AuthKey_${keyId}.p8`,
  );
  if (!existsSync(keyPath)) return { error: `API key file not found at ${keyPath}. Set key_path in the plugin settings.` };
  return { keyId, issuer, keyPath };
}

/**
 * @param {{ keyId: string, issuer: string, keyPath: string }} creds
 * @param {{ timeoutMs?: number }} [opts]
 */
export function ascClient({ keyId, issuer, keyPath }, { timeoutMs = 30000 } = {}) {
  const pk = readFileSync(keyPath, 'utf8');
  const b64 = (b) => Buffer.from(b).toString('base64url');

  // Minted per request rather than cached: a token is good for 20 minutes and
  // the post-push watcher outlives one.
  const jwt = () => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
    const claims = b64(JSON.stringify({ iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }));
    const s = createSign('SHA256');
    s.update(`${head}.${claims}`);
    return `${head}.${claims}.${b64(s.sign({ key: pk, dsaEncoding: 'ieee-p1363' }))}`;
  };

  /** @returns {Promise<{ok: boolean, status: number, json: any}>} */
  async function api(method, path, body) {
    // Paths only: the bearer token must never reach a host other than Apple's.
    if (!path.startsWith('/')) throw new Error(`refusing non-path request: ${path.slice(0, 40)}`);
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${jwt()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 500) }; }
    return { ok: r.ok, status: r.status, json };
  }

  /** GET that throws with Apple's reasons, for read paths where failure is fatal. */
  api.get = async (path) => {
    const r = await api('GET', path);
    if (!r.ok) throw new Error(`GET ${path.split('?')[0]}: ${describeErrors(r)}`);
    return r.json;
  };

  return api;
}

/**
 * Apple returns its reasons in `errors[]`, and a 409 on a relationship write
 * hides the real blocker one level down in `meta.associatedErrors`, keyed by
 * resource path. A bare status code says nothing, so flatten all of it.
 */
export function describeErrors(res) {
  const errs = res.json?.errors || [];
  if (!errs.length) return `HTTP ${res.status}`;
  const lines = [];
  for (const e of errs) {
    lines.push(`${e.title}${e.detail ? ` — ${e.detail}` : ''}`);
    for (const [where, nested] of Object.entries(e.meta?.associatedErrors || {})) {
      for (const n of nested) lines.push(`  ↳ ${where}: ${n.detail || n.title || n.code}`);
    }
  }
  return lines.join('\n');
}
