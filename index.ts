// SPDX-License-Identifier: MIT
// Copyright (C) Jarkko Sakkinen 2026

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  BashToolDetails,
  BashToolInput,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { type AddressInfo, connect as connectNet, createServer, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { URL } from 'node:url';

import {
  type BashOperations,
  createBashToolDefinition,
  getAgentDir,
  getShellConfig,
  isToolCallEventType,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';

interface SandboxFilesystemConfig {
  denyRead: string[];
  allowRead: string[];
  allowWrite: string[];
  denyWrite: string[];
}

interface SandboxNetworkConfig {
  allowLocalBinding: boolean;
  allowAllUnixSockets: boolean;
  allowUnixSockets: string[];
  allowedDomains: string[];
  deniedDomains: string[];
}

interface LandstripConfig {
  command: string;
  debug: boolean;
}

interface SandboxConfig {
  enabled: boolean;
  network: SandboxNetworkConfig;
  filesystem: SandboxFilesystemConfig;
  landstrip: LandstripConfig;
}

interface LandstripPolicy {
  network: {
    allowLocalBinding: boolean;
    allowAllUnixSockets: boolean;
    allowUnixSockets: string[];
    httpProxyPort: number;
  };
  filesystem: SandboxFilesystemConfig;
}

const LANDSTRIP_VERSION = [0, 8, 3] as const;
const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(['linux', 'darwin', 'win32']);

const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  network: {
    allowLocalBinding: false,
    allowAllUnixSockets: false,
    allowUnixSockets: [],
    allowedDomains: [
      'npmjs.org',
      '*.npmjs.org',
      'registry.npmjs.org',
      'registry.yarnpkg.com',
      'pypi.org',
      '*.pypi.org',
      'github.com',
      '*.github.com',
      'api.github.com',
      'raw.githubusercontent.com',
      'crates.io',
      '*.crates.io',
      'static.crates.io',
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ['/Users', '/home'],
    allowRead: ['.', '~/.config', '~/.local', '~/.cargo'],
    allowWrite: ['.', '/tmp'],
    denyWrite: ['.env', '.env.*', '*.pem', '*.key'],
  },
  landstrip: {
    command: 'landstrip',
    debug: false,
  },
};

type PermissionChoice = 'abort' | 'session' | 'project' | 'global';

interface PromptOption {
  label: string;
  key: string;
  action: PermissionChoice;
  confirm?: boolean;
  hint?: string;
}

const PERMISSION_OPTIONS: PromptOption[] = [
  { label: 'Allow for this session only', key: 's', action: 'session' },
  { label: 'Abort (keep blocked)', key: 'esc', action: 'abort' },
  {
    label: 'Allow for this project',
    key: 'P',
    action: 'project',
    confirm: true,
    hint: '-> .pi/sandbox.json',
  },
  {
    label: 'Allow for all projects',
    key: 'A',
    action: 'global',
    confirm: true,
    hint: '-> ~/.pi/agent/sandbox.json',
  },
];

function loadConfig(cwd: string): SandboxConfig {
  const projectConfigPath = join(cwd, '.pi', 'sandbox.json');
  const globalConfigPath = join(getAgentDir(), 'sandbox.json');

  let globalConfig: Partial<SandboxConfig> = {};
  let projectConfig: Partial<SandboxConfig> = {};

  if (existsSync(globalConfigPath)) {
    try {
      globalConfig = JSON.parse(readFileSync(globalConfigPath, 'utf-8'));
    } catch (error) {
      console.error(`Warning: Could not parse ${globalConfigPath}: ${error}`);
    }
  }

  if (existsSync(projectConfigPath)) {
    try {
      projectConfig = JSON.parse(readFileSync(projectConfigPath, 'utf-8'));
    } catch (error) {
      console.error(`Warning: Could not parse ${projectConfigPath}: ${error}`);
    }
  }

  return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
  return {
    enabled: overrides.enabled ?? base.enabled,
    network: {
      ...base.network,
      ...overrides.network,
    },
    filesystem: {
      ...base.filesystem,
      ...overrides.filesystem,
    },
    landstrip: {
      ...base.landstrip,
      ...overrides.landstrip,
    },
  };
}

function getConfigPaths(cwd: string): { globalPath: string; projectPath: string } {
  return {
    globalPath: join(homedir(), '.pi', 'agent', 'sandbox.json'),
    projectPath: join(cwd, '.pi', 'sandbox.json'),
  };
}

function readOrEmptyConfig(configPath: string): Partial<SandboxConfig> {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfigFile(configPath: string, config: Partial<SandboxConfig>): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function addDomainToConfig(configPath: string, domain: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.network?.allowedDomains ?? [];
  if (existing.includes(domain)) return;

  config.network = {
    ...config.network,
    allowedDomains: [...existing, domain],
    deniedDomains: config.network?.deniedDomains ?? [],
  } as SandboxNetworkConfig;
  writeConfigFile(configPath, config);
}

function addReadPathToConfig(configPath: string, pathToAdd: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.filesystem?.allowRead ?? [];
  if (existing.includes(pathToAdd)) return;

  config.filesystem = {
    ...config.filesystem,
    allowRead: [...existing, pathToAdd],
    denyRead: config.filesystem?.denyRead ?? [],
    allowWrite: config.filesystem?.allowWrite ?? [],
    denyWrite: config.filesystem?.denyWrite ?? [],
  } as SandboxFilesystemConfig;
  writeConfigFile(configPath, config);
}

function addWritePathToConfig(configPath: string, pathToAdd: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.filesystem?.allowWrite ?? [];
  if (existing.includes(pathToAdd)) return;

  config.filesystem = {
    ...config.filesystem,
    allowWrite: [...existing, pathToAdd],
    denyRead: config.filesystem?.denyRead ?? [],
    allowRead: config.filesystem?.allowRead ?? [],
    denyWrite: config.filesystem?.denyWrite ?? [],
  } as SandboxFilesystemConfig;
  writeConfigFile(configPath, config);
}

function extractDomainsFromCommand(command: string): string[] {
  const urlRegex = /https?:\/\/([^\s/:?#]+)(?::\d+)?(?:[/?#]|\s|$)/g;
  const domains = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(command)) !== null) {
    domains.add(match[1]);
  }

  return [...domains];
}

function domainMatchesPattern(domain: string, pattern: string): boolean {
  const normalizedDomain = domain.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();

  if (normalizedPattern === '*') return true;
  if (normalizedPattern.startsWith('*.')) {
    const base = normalizedPattern.slice(2);
    return normalizedDomain === base || normalizedDomain.endsWith(`.${base}`);
  }

  return normalizedDomain === normalizedPattern;
}

function domainMatchesAny(domain: string, patterns: string[]): boolean {
  return patterns.some((pattern) => domainMatchesPattern(domain, pattern));
}

function allowsAllDomains(allowedDomains: string[]): boolean {
  return allowedDomains.includes('*');
}

function shouldPromptForWrite(
  path: string,
  allowWrite: string[],
  patternMatcher: (path: string, patterns: string[]) => boolean,
): boolean {
  return allowWrite.length === 0 || !patternMatcher(path, allowWrite);
}

function expandPath(filePath: string): string {
  return resolve(filePath.replace(/^~(?=$|\/)/, homedir()));
}

function canonicalizePath(filePath: string): string {
  const abs = expandPath(filePath);

  try {
    return realpathSync.native(abs);
  } catch {
    const tail: string[] = [];
    let probe = abs;

    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) return abs;
      tail.unshift(basename(probe));
      probe = parent;
    }

    try {
      return resolve(realpathSync.native(probe), ...tail);
    } catch {
      return abs;
    }
  }
}

function matchesPattern(filePath: string, patterns: string[]): boolean {
  const abs = canonicalizePath(filePath);

  return patterns.some((pattern) => {
    const absPattern = pattern.includes('*') ? expandPath(pattern) : canonicalizePath(pattern);

    if (pattern.includes('*')) {
      const escaped = absPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${escaped}$`).test(abs);
    }

    const sep = absPattern.endsWith('/') ? '' : '/';
    return abs === absPattern || abs.startsWith(absPattern + sep);
  });
}

function normalizeBlockedPath(path: string, cwd: string): string {
  return canonicalizePath(isAbsolute(path) ? path : join(cwd, path));
}

function extractBlockedWritePath(output: string, cwd: string): string | null {
  const match = output.match(
    /(?:\/bin\/bash|bash|sh): (?:line \d+: )?([^:\n]+): (?:Operation not permitted|Permission denied)/,
  );

  return match ? normalizeBlockedPath(match[1], cwd) : null;
}

async function showPermissionPrompt(
  ctx: ExtensionContext,
  title: string,
  options: PromptOption[],
): Promise<PermissionChoice> {
  if (!ctx.hasUI) return 'abort';

  const result = await ctx.ui.custom<PermissionChoice>((tui, theme, _kb, done) => {
    let selectedIndex = 0;
    let pendingAction: PermissionChoice | null = null;

    function resolveChoice(action: PermissionChoice): void {
      done(action);
    }

    return {
      render(width: number): string[] {
        const lines: string[] = [];
        lines.push(truncateToWidth(theme.fg('warning', title), width));
        lines.push('');

        for (let i = 0; i < options.length; i++) {
          const option = options[i];
          const isSelected = i === selectedIndex;
          const isPending = pendingAction === option.action;
          const prefix = isSelected ? ' -> ' : '    ';
          const keyHint = theme.fg('accent', `[${option.key}]`);
          let label = option.label;

          if (option.hint) label += `  ${theme.fg('dim', option.hint)}`;
          if (isPending) label += `  ${theme.fg('warning', '-> press Enter to confirm')}`;

          lines.push(truncateToWidth(`${prefix}${keyHint} ${label}`, width));
        }

        lines.push('');
        lines.push(
          truncateToWidth(
            theme.fg(
              'dim',
              pendingAction
                ? 'up/down navigate  enter confirm  esc cancel'
                : 'up/down navigate  enter select  esc cancel',
            ),
            width,
          ),
        );

        return lines;
      },

      handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
          resolveChoice('abort');
          return;
        }

        if (matchesKey(data, Key.enter)) {
          resolveChoice(pendingAction ?? options[selectedIndex]?.action ?? 'abort');
          return;
        }

        if (matchesKey(data, Key.up)) {
          selectedIndex = Math.max(0, selectedIndex - 1);
          pendingAction = null;
          tui.requestRender();
          return;
        }

        if (matchesKey(data, Key.down)) {
          selectedIndex = Math.min(options.length - 1, selectedIndex + 1);
          pendingAction = null;
          tui.requestRender();
          return;
        }

        for (let i = 0; i < options.length; i++) {
          const option = options[i];

          if (data === option.key) {
            resolveChoice(option.action);
            return;
          }

          if (data.toLowerCase() === option.key.toLowerCase()) {
            if (option.confirm) {
              pendingAction = option.action;
              selectedIndex = i;
            } else {
              resolveChoice(option.action);
            }
            tui.requestRender();
            return;
          }
        }
      },

      invalidate(): void {},
    };
  });

  return result ?? 'abort';
}

function promptDomainBlock(ctx: ExtensionContext, domain: string): Promise<PermissionChoice> {
  return showPermissionPrompt(
    ctx,
    `Network blocked: "${domain}" is not in allowedDomains`,
    PERMISSION_OPTIONS,
  );
}

function promptReadBlock(ctx: ExtensionContext, filePath: string): Promise<PermissionChoice> {
  return showPermissionPrompt(
    ctx,
    `Read blocked: "${filePath}" is not in allowRead`,
    PERMISSION_OPTIONS,
  );
}

function promptWriteBlock(ctx: ExtensionContext, filePath: string): Promise<PermissionChoice> {
  return showPermissionPrompt(
    ctx,
    `Write blocked: "${filePath}" is not in allowWrite`,
    PERMISSION_OPTIONS,
  );
}

function landstripVersion(command: string): string | null {
  const result = spawnSync(command, ['--version'], { encoding: 'utf-8' });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function parseVersion(version: string): [number, number, number] | null {
  const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function hasMinimumVersion(version: string, minimum: readonly [number, number, number]): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;

  for (let i = 0; i < minimum.length; i++) {
    if (parsed[i] > minimum[i]) return true;
    if (parsed[i] < minimum[i]) return false;
  }

  return true;
}

function proxyEnv(env: NodeJS.ProcessEnv | undefined, port: number): NodeJS.ProcessEnv {
  const url = `http://127.0.0.1:${port}`;

  return {
    ...process.env,
    ...env,
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
    NO_PROXY: '',
    no_proxy: '',
  };
}

function splitHostPort(target: string, defaultPort: number): { host: string; port: number } | null {
  const bracketMatch = target.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketMatch) {
    return {
      host: bracketMatch[1],
      port: bracketMatch[2] ? Number(bracketMatch[2]) : defaultPort,
    };
  }

  const lastColon = target.lastIndexOf(':');
  if (lastColon > -1 && target.indexOf(':') === lastColon) {
    return {
      host: target.slice(0, lastColon),
      port: Number(target.slice(lastColon + 1)),
    };
  }

  return { host: target, port: defaultPort };
}

function denyProxyRequest(client: Socket, status = '403 Forbidden'): void {
  client.write(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\n\r\n`);
  client.end();
}

function pipeSockets(client: Socket, upstream: Socket, initialData?: Buffer): void {
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());

  if (initialData?.length) upstream.write(initialData);

  client.pipe(upstream);
  upstream.pipe(client);
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag('no-sandbox', {
    description: 'Disable landstrip sandboxing for bash commands',
    type: 'boolean',
    default: false,
  });

  const localCwd = process.cwd();
  const userShellPath = SettingsManager.create(localCwd).getShellPath();
  const localBash = createBashToolDefinition(localCwd, { shellPath: userShellPath });

  let sandboxEnabled = false;
  let sandboxReady = false;
  const sessionAllowedDomains: string[] = [];
  const sessionAllowedReadPaths: string[] = [];
  const sessionAllowedWritePaths: string[] = [];

  function getEffectiveAllowedDomains(cwd: string): string[] {
    const config = loadConfig(cwd);
    return [...config.network.allowedDomains, ...sessionAllowedDomains];
  }

  function getEffectiveAllowRead(cwd: string): string[] {
    const config = loadConfig(cwd);
    return [...config.filesystem.allowRead, ...sessionAllowedReadPaths];
  }

  function getEffectiveAllowWrite(cwd: string): string[] {
    const config = loadConfig(cwd);
    return [...config.filesystem.allowWrite, ...sessionAllowedWritePaths];
  }

  async function applyDomainChoice(
    choice: Exclude<PermissionChoice, 'abort'>,
    domain: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    if (!sessionAllowedDomains.includes(domain)) sessionAllowedDomains.push(domain);
    if (choice === 'project') addDomainToConfig(projectPath, domain);
    if (choice === 'global') addDomainToConfig(globalPath, domain);
  }

  async function applyReadChoice(
    choice: Exclude<PermissionChoice, 'abort'>,
    filePath: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    if (!sessionAllowedReadPaths.includes(filePath)) sessionAllowedReadPaths.push(filePath);
    if (choice === 'project') addReadPathToConfig(projectPath, filePath);
    if (choice === 'global') addReadPathToConfig(globalPath, filePath);
  }

  async function applyWriteChoice(
    choice: Exclude<PermissionChoice, 'abort'>,
    filePath: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    if (!sessionAllowedWritePaths.includes(filePath)) sessionAllowedWritePaths.push(filePath);
    if (choice === 'project') addWritePathToConfig(projectPath, filePath);
    if (choice === 'global') addWritePathToConfig(globalPath, filePath);
  }

  async function ensureDomainAllowed(
    ctx: ExtensionContext,
    domain: string,
    cwd: string,
  ): Promise<boolean> {
    const config = loadConfig(cwd);

    if (domainMatchesAny(domain, config.network.deniedDomains)) return false;
    if (domainMatchesAny(domain, getEffectiveAllowedDomains(cwd))) return true;

    const choice = await promptDomainBlock(ctx, domain);
    if (choice === 'abort') return false;

    await applyDomainChoice(choice, domain, cwd);
    return true;
  }

  function buildLandstripPolicy(cwd: string, proxyPort: number): LandstripPolicy {
    const config = loadConfig(cwd);

    return {
      network: {
        allowLocalBinding: config.network.allowLocalBinding,
        allowAllUnixSockets: config.network.allowAllUnixSockets,
        allowUnixSockets: config.network.allowUnixSockets,
        httpProxyPort: proxyPort,
      },
      filesystem: {
        denyRead: config.filesystem.denyRead,
        allowRead: [...config.filesystem.allowRead, ...sessionAllowedReadPaths],
        allowWrite: [...config.filesystem.allowWrite, ...sessionAllowedWritePaths],
        denyWrite: config.filesystem.denyWrite,
      },
    };
  }

  function writePolicyFile(cwd: string, proxyPort: number): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'pi-landstrip-'));
    const path = join(dir, 'policy.json');
    writeFileSync(
      path,
      JSON.stringify(buildLandstripPolicy(cwd, proxyPort), null, 2) + '\n',
      'utf-8',
    );

    return { dir, path };
  }

  function startProxy(
    ctx: ExtensionContext,
    cwd: string,
  ): Promise<{ port: number; stop: () => Promise<void> }> {
    const sockets = new Set<Socket>();

    async function handleConnect(client: Socket, target: string, rest: Buffer): Promise<void> {
      const endpoint = splitHostPort(target, 443);
      if (!endpoint || !Number.isFinite(endpoint.port)) {
        denyProxyRequest(client, '400 Bad Request');
        return;
      }

      if (!(await ensureDomainAllowed(ctx, endpoint.host, cwd))) {
        denyProxyRequest(client);
        return;
      }

      const upstream = connectNet(endpoint.port, endpoint.host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        pipeSockets(client, upstream, rest);
      });
    }

    async function handleHttp(client: Socket, headerText: string, rest: Buffer): Promise<void> {
      const lines = headerText.split(/\r?\n/);
      const [method, rawTarget, version] = lines[0].split(' ');

      if (!method || !rawTarget || !version) {
        denyProxyRequest(client, '400 Bad Request');
        return;
      }

      let url: URL;
      try {
        url = new URL(rawTarget);
      } catch {
        const host = lines
          .find((line) => line.toLowerCase().startsWith('host:'))
          ?.slice(5)
          .trim();
        if (!host) {
          denyProxyRequest(client, '400 Bad Request');
          return;
        }
        url = new URL(`http://${host}${rawTarget}`);
      }

      if (!(await ensureDomainAllowed(ctx, url.hostname, cwd))) {
        denyProxyRequest(client);
        return;
      }

      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      const path = `${url.pathname}${url.search}` || '/';
      lines[0] = `${method} ${path} ${version}`;

      const rewrittenHeader = lines
        .filter((line) => !line.toLowerCase().startsWith('proxy-connection:'))
        .join('\r\n');
      const upstream = connectNet(port, url.hostname, () => {
        upstream.write(`${rewrittenHeader}\r\n\r\n`);
        pipeSockets(client, upstream, rest);
      });
    }

    function handleClient(client: Socket): void {
      sockets.add(client);
      client.on('close', () => sockets.delete(client));
      client.on('error', () => sockets.delete(client));

      let buffered = Buffer.alloc(0);

      client.on('data', (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        const headerEnd = buffered.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          if (buffered.length > 65536)
            denyProxyRequest(client, '431 Request Header Fields Too Large');
          return;
        }

        client.pause();
        client.removeAllListeners('data');

        const header = buffered.subarray(0, headerEnd).toString('utf-8');
        const rest = buffered.subarray(headerEnd + 4);
        const firstLine = header.split(/\r?\n/, 1)[0];
        const [method, target] = firstLine.split(' ');

        const task =
          method?.toUpperCase() === 'CONNECT'
            ? handleConnect(client, target, rest)
            : handleHttp(client, header, rest);
        task.catch(() => denyProxyRequest(client, '502 Bad Gateway'));
      });
    }

    const server = createServer(handleClient);
    let stopped = false;

    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const address = server.address() as AddressInfo;

        resolve({
          port: address.port,
          stop: () =>
            new Promise<void>((done) => {
              if (stopped) {
                done();
                return;
              }
              stopped = true;
              for (const socket of sockets) socket.destroy();
              server.close(() => done());
            }),
        });
      });
    });
  }

  function createLandstripBashOps(ctx: ExtensionContext): BashOperations {
    return {
      async exec(command, cwd, { onData, signal, timeout, env }) {
        if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

        const config = loadConfig(cwd);
        const { shell, args } = getShellConfig(userShellPath);
        const proxy = await startProxy(ctx, cwd);
        const policy = writePolicyFile(cwd, proxy.port);
        const landstripArgs = [
          ...(config.landstrip.debug ? ['--debug'] : []),
          '-p',
          policy.path,
          shell,
          ...args,
          command,
        ];

        return new Promise((resolvePromise, reject) => {
          let timeoutHandle: NodeJS.Timeout | undefined;
          let timedOut = false;
          let cleaned = false;

          const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            if (timeoutHandle) clearTimeout(timeoutHandle);
            signal?.removeEventListener('abort', onAbort);
            void proxy.stop();
            rmSync(policy.dir, { recursive: true, force: true });
          };

          const child = spawn(config.landstrip.command, landstripArgs, {
            cwd,
            env: proxyEnv(env, proxy.port),
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          function killChild(): void {
            if (!child.pid) return;
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          }

          function onAbort(): void {
            killChild();
          }

          if (timeout !== undefined && timeout > 0) {
            timeoutHandle = setTimeout(() => {
              timedOut = true;
              killChild();
            }, timeout * 1000);
          }

          signal?.addEventListener('abort', onAbort, { once: true });
          child.stdout?.on('data', onData);
          child.stderr?.on('data', onData);

          child.on('error', (error) => {
            cleanup();
            reject(error);
          });

          child.on('close', (code) => {
            cleanup();
            if (signal?.aborted) {
              reject(new Error('aborted'));
            } else if (timedOut) {
              reject(new Error(`timeout:${timeout}`));
            } else {
              resolvePromise({ exitCode: code });
            }
          });
        });
      },
    };
  }

  async function runBashWithOptionalRetry(
    id: string,
    params: BashToolInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<BashToolDetails | undefined>> {
    const sandboxedBash = createBashToolDefinition(localCwd, {
      operations: createLandstripBashOps(ctx),
      shellPath: userShellPath,
    });

    const run = () => sandboxedBash.execute(id, params, signal, onUpdate, ctx);
    const result = await run();
    const outputText = result.content
      .filter((content) => content.type === 'text')
      .map((content) => content.text)
      .join('\n');
    const blockedPath = extractBlockedWritePath(outputText, ctx.cwd);

    if (!blockedPath || !ctx.hasUI) return result;

    const choice = await promptWriteBlock(ctx, blockedPath);
    if (choice === 'abort') return result;

    await applyWriteChoice(choice, blockedPath, ctx.cwd);

    const config = loadConfig(ctx.cwd);
    const { globalPath, projectPath } = getConfigPaths(ctx.cwd);
    if (matchesPattern(blockedPath, config.filesystem.denyWrite)) {
      ctx.ui.notify(
        `"${blockedPath}" was added to allowWrite, but denyWrite still blocks it. Check:\n  ${projectPath}\n  ${globalPath}`,
        'warning',
      );
      return result;
    }

    onUpdate?.({
      content: [
        { type: 'text', text: `\n--- Write access granted for "${blockedPath}", retrying ---\n` },
      ],
      details: {},
    });
    return run();
  }

  async function preflightCommandDomains(
    command: string,
    ctx: ExtensionContext,
  ): Promise<string | null> {
    for (const domain of extractDomainsFromCommand(command)) {
      if (!(await ensureDomainAllowed(ctx, domain, ctx.cwd))) return domain;
    }

    return null;
  }

  function warnIfAllDomainsAllowed(ctx: ExtensionContext, config: SandboxConfig): void {
    if (!allowsAllDomains(config.network.allowedDomains)) return;
    ctx.ui.notify(
      'Network sandbox allows all domains because network.allowedDomains contains "*".',
      'warning',
    );
  }

  function enableStatus(ctx: ExtensionContext, config: SandboxConfig): void {
    const networkLabel = allowsAllDomains(config.network.allowedDomains)
      ? 'all domains'
      : `${config.network.allowedDomains.length} domains`;
    ctx.ui.setStatus(
      'sandbox',
      ctx.ui.theme.fg(
        'accent',
        `Sandbox: ${networkLabel}, ${config.filesystem.allowWrite.length} write paths`,
      ),
    );
  }

  function enableSandbox(ctx: ExtensionContext): boolean {
    const config = loadConfig(ctx.cwd);

    if (!SUPPORTED_PLATFORMS.has(process.platform)) {
      sandboxEnabled = false;
      sandboxReady = false;
      ctx.ui.notify(`landstrip sandboxing is not supported on ${process.platform}`, 'warning');
      return false;
    }

    const version = landstripVersion(config.landstrip.command);
    if (!version) {
      sandboxEnabled = false;
      sandboxReady = false;
      ctx.ui.notify(`landstrip was not found. Install it with: cargo install landstrip`, 'error');
      return false;
    }

    if (!hasMinimumVersion(version, LANDSTRIP_VERSION)) {
      sandboxEnabled = false;
      sandboxReady = false;
      ctx.ui.notify(`landstrip 0.8.3 or newer is required; found: ${version}`, 'error');
      return false;
    }

    sandboxEnabled = true;
    sandboxReady = true;
    warnIfAllDomainsAllowed(ctx, config);
    enableStatus(ctx, config);
    return true;
  }

  pi.registerTool({
    ...localBash,
    label: 'bash (landstrip)',
    async execute(id, params, signal, onUpdate, ctx) {
      if (!sandboxEnabled || !sandboxReady)
        return localBash.execute(id, params, signal, onUpdate, ctx);

      return runBashWithOptionalRetry(id, params, signal, onUpdate, ctx);
    },
  });

  pi.on('user_bash', async (event, ctx) => {
    if (!sandboxEnabled || !sandboxReady) return;
    if (!loadConfig(ctx.cwd).enabled) return;

    const blockedDomain = await preflightCommandDomains(event.command, ctx);
    if (blockedDomain) {
      return {
        result: {
          output: `Blocked: "${blockedDomain}" is not allowed by the sandbox. Use /sandbox to review your config.`,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }

    return { operations: createLandstripBashOps(ctx) };
  });

  pi.on('tool_call', async (event, ctx) => {
    if (!sandboxEnabled) return;

    const config = loadConfig(ctx.cwd);
    if (!config.enabled) return;

    const { globalPath, projectPath } = getConfigPaths(ctx.cwd);

    if (sandboxReady && isToolCallEventType('bash', event)) {
      const blockedDomain = await preflightCommandDomains(event.input.command, ctx);
      if (blockedDomain) {
        return {
          block: true,
          reason: `Network access to "${blockedDomain}" is blocked by the sandbox.`,
        };
      }
    }

    if (isToolCallEventType('read', event)) {
      const filePath = canonicalizePath(event.input.path);
      if (!matchesPattern(filePath, getEffectiveAllowRead(ctx.cwd))) {
        const choice = await promptReadBlock(ctx, filePath);
        if (choice === 'abort') {
          return {
            block: true,
            reason: `Sandbox: read access denied for "${filePath}"`,
          };
        }
        await applyReadChoice(choice, filePath, ctx.cwd);
      }
    }

    if (isToolCallEventType('write', event) || isToolCallEventType('edit', event)) {
      const filePath = canonicalizePath((event.input as { path: string }).path);

      if (matchesPattern(filePath, config.filesystem.denyWrite)) {
        return {
          block: true,
          reason:
            `Sandbox: write access denied for "${filePath}" (in denyWrite). ` +
            `To change this, edit denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
        };
      }

      if (shouldPromptForWrite(filePath, getEffectiveAllowWrite(ctx.cwd), matchesPattern)) {
        const choice = await promptWriteBlock(ctx, filePath);
        if (choice === 'abort') {
          return {
            block: true,
            reason: `Sandbox: write access denied for "${filePath}" (not in allowWrite)`,
          };
        }
        await applyWriteChoice(choice, filePath, ctx.cwd);
      }
    }
  });

  pi.on('session_start', async (_event, ctx) => {
    const noSandbox = pi.getFlag('no-sandbox') as boolean;

    if (noSandbox) {
      sandboxEnabled = false;
      sandboxReady = false;
      ctx.ui.notify('Sandbox disabled via --no-sandbox', 'warning');
      return;
    }

    const config = loadConfig(ctx.cwd);
    if (!config.enabled) {
      sandboxEnabled = false;
      sandboxReady = false;
      ctx.ui.notify('Sandbox disabled via config', 'info');
      return;
    }

    enableSandbox(ctx);
  });

  pi.registerCommand('sandbox-enable', {
    description: 'Enable the landstrip sandbox for this session',
    handler: async (_args, ctx) => {
      if (sandboxEnabled) {
        ctx.ui.notify('Sandbox is already enabled', 'info');
        return;
      }

      if (enableSandbox(ctx)) ctx.ui.notify('Sandbox enabled', 'info');
    },
  });

  pi.registerCommand('sandbox-disable', {
    description: 'Disable the landstrip sandbox for this session',
    handler: async (_args, ctx) => {
      if (!sandboxEnabled) {
        ctx.ui.notify('Sandbox is already disabled', 'info');
        return;
      }

      sandboxEnabled = false;
      sandboxReady = false;
      ctx.ui.setStatus('sandbox', '');
      ctx.ui.notify('Sandbox disabled', 'info');
    },
  });

  pi.registerCommand('sandbox', {
    description: 'Show sandbox configuration',
    handler: async (_args, ctx) => {
      if (!sandboxEnabled) {
        ctx.ui.notify('Sandbox is disabled', 'info');
        return;
      }

      const config = loadConfig(ctx.cwd);
      const { globalPath, projectPath } = getConfigPaths(ctx.cwd);
      const lines = [
        'Sandbox Configuration',
        `  Project config: ${projectPath}`,
        `  Global config:  ${globalPath}`,
        `  landstrip:      ${config.landstrip.command}`,
        '',
        'Network (bash through HTTP proxy):',
        `  Allowed domains: ${config.network.allowedDomains.join(', ') || '(none)'}`,
        `  Denied domains:  ${config.network.deniedDomains.join(', ') || '(none)'}`,
        ...(sessionAllowedDomains.length > 0
          ? [`  Session allowed: ${sessionAllowedDomains.join(', ')}`]
          : []),
        '',
        'Filesystem (bash + read/write/edit tools):',
        `  Deny Read:   ${config.filesystem.denyRead.join(', ') || '(none)'}`,
        `  Allow Read:  ${config.filesystem.allowRead.join(', ') || '(none)'}`,
        `  Allow Write: ${config.filesystem.allowWrite.join(', ') || '(none)'}`,
        `  Deny Write:  ${config.filesystem.denyWrite.join(', ') || '(none)'}`,
        ...(sessionAllowedReadPaths.length > 0
          ? [`  Session read:  ${sessionAllowedReadPaths.join(', ')}`]
          : []),
        ...(sessionAllowedWritePaths.length > 0
          ? [`  Session write: ${sessionAllowedWritePaths.join(', ')}`]
          : []),
      ];

      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });
}
