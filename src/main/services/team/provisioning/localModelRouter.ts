import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';

/**
 * A local model router (clauderipple today) keeps Claude Code working without an
 * Anthropic subscription: the CLI talks to a loopback proxy that borrows another
 * provider's subscription, and the router ignores the credential the CLI sends.
 * The CLI still refuses to start with an empty one, so a marker token is supplied.
 */
export interface LocalModelRouter {
  readonly kind: 'clauderipple';
  readonly proxyUrl: string;
  readonly caPath: string | null;
  readonly markerToken: string;
  readonly models: readonly string[];
}

export interface DetectLocalModelRouterInput {
  readonly homeDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly readTextFile?: (filePath: string) => Promise<string | null>;
  readonly isPortOpen?: (host: string, port: number) => Promise<boolean>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function loopbackAddress(url: string | null | undefined): { host: string; port: number } | null {
  const text = url?.trim();
  if (!text) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK_HOSTS.has(host) && !LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  return Number.isSafeInteger(port) && port > 0 && port < 65536 ? { host, port } : null;
}

async function defaultReadTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function defaultIsPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/** Settings the user already gave Claude Code, which the CLI applies to its own runs. */
async function readClaudeSettingsEnv(
  homeDir: string,
  read: (filePath: string) => Promise<string | null>
): Promise<Record<string, string>> {
  const text = await read(path.join(homeDir, '.claude', 'settings.json'));
  if (!text) return {};
  try {
    const env = record(record(JSON.parse(text))?.env);
    if (!env) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string' && value.trim()) out[key] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

async function readRouterModels(
  homeDir: string,
  read: (filePath: string) => Promise<string | null>
): Promise<{ models: string[]; listen: string | null; configured: boolean }> {
  const text = await read(path.join(homeDir, '.clauderipple', 'config.json'));
  if (!text) return { models: [], listen: null, configured: false };
  try {
    const config = record(JSON.parse(text));
    if (!config) return { models: [], listen: null, configured: false };
    const listen = record(config.listen);
    const host = typeof listen?.host === 'string' ? listen.host : null;
    const port = typeof listen?.port === 'number' ? listen.port : null;
    const models: string[] = [];
    const providers = record(config.providers);
    for (const provider of Object.values(providers ?? {})) {
      const list = record(provider)?.models;
      if (!Array.isArray(list)) continue;
      for (const model of list) {
        const id = record(model)?.id;
        if (typeof id === 'string' && id.trim()) models.push(id.trim());
      }
    }
    return {
      models: [...new Set(models)],
      listen: host && port ? `http://${host}:${port}` : null,
      configured: true,
    };
  } catch {
    return { models: [], listen: null, configured: false };
  }
}

/**
 * Reports the loopback router only when it is actually reachable: a configured but dead
 * router must not make a launch look healthy.
 */
export async function detectLocalModelRouter(
  input: DetectLocalModelRouterInput
): Promise<LocalModelRouter | null> {
  const read = input.readTextFile ?? defaultReadTextFile;
  const isPortOpen = input.isPortOpen ?? defaultIsPortOpen;
  const env = input.env ?? process.env;
  const settings = await readClaudeSettingsEnv(input.homeDir, read);
  const router = await readRouterModels(input.homeDir, read);
  // Any process can listen on loopback, so a proxy address alone proves nothing. The
  // router's own configuration is the evidence that this egress belongs to it.
  if (!router.configured) return null;

  const candidates = [settings.HTTPS_PROXY, env.HTTPS_PROXY, router.listen];
  for (const candidate of candidates) {
    const address = loopbackAddress(candidate);
    if (!address) continue;
    if (!(await isPortOpen(address.host, address.port))) continue;
    const caCandidate = settings.NODE_EXTRA_CA_CERTS ?? env.NODE_EXTRA_CA_CERTS;
    const caPath = caCandidate && existsSync(caCandidate) ? caCandidate : null;
    return Object.freeze({
      kind: 'clauderipple',
      proxyUrl: candidate!.trim(),
      caPath,
      markerToken: 'local-model-router',
      models: Object.freeze(router.models),
    });
  }
  return null;
}

/**
 * The router sits between the CLI and the API, so the CLI must see it as its egress
 * proxy, keep loopback control traffic out of it, and trust the router's CA.
 */
export function applyLocalModelRouterEnv(
  env: NodeJS.ProcessEnv,
  router: Readonly<LocalModelRouter>
): NodeJS.ProcessEnv {
  if (!env.HTTPS_PROXY?.trim()) env.HTTPS_PROXY = router.proxyUrl;
  if (!env.HTTP_PROXY?.trim()) env.HTTP_PROXY = router.proxyUrl;
  // The control API and the MCP bridge live on loopback; routing them through the
  // router would break the very connection the launch depends on. An existing list is
  // kept and only extended, so a user's own exclusions survive.
  const existingNoProxy = (env.NO_PROXY ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const loopback = ['127.0.0.1', 'localhost', '::1'];
  const merged = [
    ...existingNoProxy,
    ...loopback.filter((entry) => !existingNoProxy.includes(entry)),
  ];
  env.NO_PROXY = merged.join(',');
  if (router.caPath && !env.NODE_EXTRA_CA_CERTS?.trim()) env.NODE_EXTRA_CA_CERTS = router.caPath;
  return env;
}

/** Without a credential the CLI exits before its first turn; the router accepts any value. */
export function applyLocalModelRouterCredential(
  env: NodeJS.ProcessEnv,
  router: Readonly<LocalModelRouter>
): NodeJS.ProcessEnv {
  const hasCredential = [
    env.ANTHROPIC_API_KEY,
    env.ANTHROPIC_AUTH_TOKEN,
    env.CLAUDE_CODE_OAUTH_TOKEN,
  ].some((value) => typeof value === 'string' && value.trim().length > 0);
  if (!hasCredential) env.ANTHROPIC_AUTH_TOKEN = router.markerToken;
  return env;
}
