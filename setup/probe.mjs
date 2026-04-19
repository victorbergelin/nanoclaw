#!/usr/bin/env node
/**
 * Setup step: probe — Single upfront parallel scan for /new-setup's dynamic
 * context injection. Rendered into the SKILL.md prompt via
 * `!node setup/probe.mjs` so Claude sees the current system state before
 * generating its first response.
 *
 * This is a routing aid, NOT a replacement for per-step idempotency checks.
 * Each step keeps its own checks; probe tells the skill which steps to skip.
 *
 * Plain ESM JS (zero deps) by design: this runs BEFORE setup.sh has installed
 * pnpm and node_modules, so it can only use Node built-ins. `better-sqlite3`
 * is dynamic-imported so the probe degrades gracefully on fresh installs.
 *
 * Keep fast (<2s total). All probes swallow their own errors and report a
 * neutral state rather than failing the whole scan.
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');
const PROBE_TIMEOUT_MS = 2000;
const HEALTH_TIMEOUT_MS = 2000;
const AGENT_IMAGE = 'nanoclaw-agent:latest';
const DATA_DIR = path.resolve(process.cwd(), 'data');

function childEnv() {
  const parts = [LOCAL_BIN];
  if (process.env.PATH) parts.push(process.env.PATH);
  return { ...process.env, PATH: parts.join(path.delimiter) };
}

function getPlatform() {
  const p = os.platform();
  if (p === 'darwin') return 'macos';
  if (p === 'linux') return 'linux';
  return 'unknown';
}

function isWSL() {
  if (os.platform() !== 'linux') return false;
  try {
    const release = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

function commandExists(name) {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function emitStatus(step, fields) {
  const lines = [`=== NANOCLAW SETUP: ${step} ===`];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('=== END ===');
  console.log(lines.join('\n'));
}

function readEnvVar(name) {
  const envFile = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envFile)) return null;
  const content = fs.readFileSync(envFile, 'utf-8');
  const m = content.match(new RegExp(`^${name}=(.+)$`, 'm'));
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function probeDocker() {
  if (!commandExists('docker')) return { status: 'not_found', imagePresent: false };
  try {
    execSync('docker info', { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
  } catch {
    return { status: 'installed_not_running', imagePresent: false };
  }
  let imagePresent = false;
  try {
    execSync(`docker image inspect ${AGENT_IMAGE}`, {
      stdio: 'ignore',
      timeout: PROBE_TIMEOUT_MS,
    });
    imagePresent = true;
  } catch {
    // image not built yet
  }
  return { status: 'running', imagePresent };
}

function probeOnecliUrl() {
  const fromEnv = readEnvVar('ONECLI_URL');
  if (fromEnv) return fromEnv;
  try {
    const out = execFileSync('onecli', ['config', 'get', 'api-host'], {
      encoding: 'utf-8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT_MS,
    }).trim();
    const parsed = JSON.parse(out);
    if (typeof parsed.value === 'string' && parsed.value) return parsed.value;
  } catch {
    // onecli not installed or config not set
  }
  return null;
}

async function probeOnecliStatus(url) {
  const installed =
    commandExists('onecli') || fs.existsSync(path.join(LOCAL_BIN, 'onecli'));
  if (!installed) return 'not_found';
  if (!url) return 'installed_not_healthy';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`${url}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok ? 'healthy' : 'installed_not_healthy';
  } catch {
    return 'installed_not_healthy';
  }
}

function probeAnthropicSecret() {
  try {
    const out = execFileSync('onecli', ['secrets', 'list'], {
      encoding: 'utf-8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT_MS,
    });
    const parsed = JSON.parse(out);
    return !!(parsed.data && parsed.data.some((s) => s.type === 'anthropic'));
  } catch {
    return false;
  }
}

function probeServiceStatus() {
  const platform = getPlatform();
  if (platform === 'macos') {
    try {
      const out = execSync('launchctl list', {
        encoding: 'utf-8',
        timeout: PROBE_TIMEOUT_MS,
      });
      const line = out.split('\n').find((l) => l.includes('com.nanoclaw'));
      if (!line) return 'not_configured';
      const pid = line.trim().split(/\s+/)[0];
      return pid && pid !== '-' ? 'running' : 'stopped';
    } catch {
      return 'not_configured';
    }
  }
  if (platform === 'linux') {
    try {
      execSync('systemctl --user is-active nanoclaw', {
        stdio: 'ignore',
        timeout: PROBE_TIMEOUT_MS,
      });
      return 'running';
    } catch {
      try {
        execSync('systemctl --user cat nanoclaw', {
          stdio: 'ignore',
          timeout: PROBE_TIMEOUT_MS,
        });
        return 'stopped';
      } catch {
        return 'not_configured';
      }
    }
  }
  return 'not_configured';
}

async function probeCliAgentWired() {
  const dbPath = path.join(DATA_DIR, 'v2.db');
  if (!fs.existsSync(dbPath)) return false;
  // Dynamic-import so probe still runs before `pnpm install` has built the
  // native module. On truly fresh installs `data/v2.db` can't exist anyway,
  // so the short-circuit above handles that path.
  try {
    const mod = await import('better-sqlite3');
    const Database = mod.default ?? mod;
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare(
          `SELECT 1 FROM messaging_group_agents mga
           JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
           WHERE mg.channel_type = 'cli' LIMIT 1`,
        )
        .get();
      return !!row;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function probeInferredDisplayName() {
  const reject = (s) => !s || !s.trim() || s.trim().toLowerCase() === 'root';

  try {
    const name = execFileSync('git', ['config', '--global', 'user.name'], {
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!reject(name)) return name;
  } catch {
    // git missing or no config set
  }

  const user = process.env.USER || os.userInfo().username;
  const platform = getPlatform();

  if (platform === 'macos') {
    try {
      const fullName = execFileSync('id', ['-F', user], {
        encoding: 'utf-8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!reject(fullName)) return fullName;
    } catch {
      // id -F not supported
    }
  } else if (platform === 'linux') {
    try {
      const entry = execFileSync('getent', ['passwd', user], {
        encoding: 'utf-8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const gecos = entry.split(':')[4];
      if (gecos) {
        const fullName = gecos.split(',')[0].trim();
        if (!reject(fullName)) return fullName;
      }
    } catch {
      // getent missing
    }
  }

  if (!reject(user)) return user;
  return 'User';
}

function probeHostDeps() {
  const nodeModules = path.resolve(process.cwd(), 'node_modules');
  if (!fs.existsSync(nodeModules)) return 'missing';
  // better-sqlite3's compiled native binding is the canonical proof that
  // `pnpm install` ran AND the native build step succeeded. Cheaper than
  // actually loading the module, and unambiguous on success.
  const nativeBinding = path.join(
    nodeModules,
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  return fs.existsSync(nativeBinding) ? 'ok' : 'missing';
}

function probeTimezone() {
  const envTz = readEnvVar('TZ');
  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';

  let status;
  if (envTz && isValidTimezone(envTz)) {
    status = 'configured';
  } else if (systemTz === 'UTC' || systemTz === 'Etc/UTC') {
    status = 'utc_suspicious';
  } else if (systemTz && isValidTimezone(systemTz)) {
    status = 'autodetected';
  } else {
    status = 'needs_input';
  }

  return {
    status,
    envTz: envTz || 'none',
    systemTz: systemTz || 'unknown',
  };
}

export async function run() {
  const started = Date.now();

  const platform = getPlatform();
  const wsl = isWSL();
  const osLabel = wsl
    ? 'wsl'
    : platform === 'macos'
      ? 'macos'
      : platform === 'linux'
        ? 'linux'
        : 'unknown';
  const shell = process.env.SHELL || 'unknown';

  const docker = probeDocker();
  const oneCliUrl = probeOnecliUrl();
  const serviceStatus = probeServiceStatus();
  const displayName = probeInferredDisplayName();
  const tz = probeTimezone();
  const hostDeps = probeHostDeps();

  const [onecliStatus, cliAgentWired] = await Promise.all([
    probeOnecliStatus(oneCliUrl),
    probeCliAgentWired(),
  ]);

  const anthropicSecret =
    onecliStatus !== 'not_found' ? probeAnthropicSecret() : false;

  const elapsedMs = Date.now() - started;

  emitStatus('PROBE', {
    OS: osLabel,
    SHELL: shell,
    HOST_DEPS: hostDeps,
    DOCKER: docker.status,
    IMAGE_PRESENT: docker.imagePresent,
    ONECLI_STATUS: onecliStatus,
    ONECLI_URL: oneCliUrl || 'none',
    ANTHROPIC_SECRET: anthropicSecret,
    SERVICE_STATUS: serviceStatus,
    CLI_AGENT_WIRED: cliAgentWired,
    INFERRED_DISPLAY_NAME: displayName,
    TZ_STATUS: tz.status,
    TZ_ENV: tz.envTz,
    TZ_SYSTEM: tz.systemTz,
    ELAPSED_MS: elapsedMs,
    STATUS: 'success',
  });
}

const invokedDirectly =
  import.meta.url === `file://${path.resolve(process.argv[1] ?? '')}`;
if (invokedDirectly) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
