import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { parseRoute } from './config.mjs';
import { parseDocument } from 'yaml';

function exists(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
export function resolveLauncher(configured = '') {
  const candidates = configured ? [configured] : [
    process.env.DSH_EXECUTABLE,
    ...(/DeepSeek Harness\.exe$/i.test(process.execPath) ? [process.execPath] : []),
    'E:\\DeepSeekHarness\\resources\\runtime\\cli\\bin\\dsh.cmd',
    path.join(process.env.LOCALAPPDATA || os.homedir(), 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    ...(process.env.PATH || '').split(path.delimiter).flatMap(p => [path.join(p, 'dsh.cmd'), path.join(p, 'dsh')]),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    if (!exists(absolute)) continue;
    let install;
    if (/DeepSeek Harness\.exe$/i.test(absolute)) install = path.dirname(absolute);
    if (/dsh\.cmd$/i.test(absolute)) install = path.resolve(path.dirname(absolute), '../../../..');
    if (install) {
      const command = path.join(install, 'DeepSeek Harness.exe');
      const entry = path.join(install, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
      // Electron exposes ASAR archives as virtual directories; plain Node sees a file.
      if (!exists(command) || !fs.existsSync(path.join(install, 'resources/app.asar'))) continue;
      return { command, prefix: ['--expose-internals', entry], env: { ELECTRON_RUN_AS_NODE: '1' }, detected: absolute };
    }
    if (/\.(cmd|bat)$/i.test(absolute)) throw new Error('请选择官方 dsh.cmd 或 DeepSeek Harness.exe；不执行任意批处理包装器');
    return { command: absolute, prefix: [], env: {}, detected: absolute };
  }
  throw new Error('找不到 DeepSeek Harness CLI。请在设置中指定 dsh.cmd 或 DeepSeek Harness.exe 的完整路径。');
}
export function buildOverlay(config) {
  const { provider, model } = parseRoute(config.modelRoute);
  return [
    ...providerPatches(config),
    ...(config.reuseSavedAuth ? [{ id: 'credentials', disabled: false }, { id: 'authorization', disabled: false }] : []),
    ...(config.reuseSavedAuth && provider === 'deepseek-account' ? [{ id: 'deepseek-account', disabled: false }] : []),
    { id: 'agent-default-model', config: { provider, model } },
    // Unattended runs cannot answer interactive approval requests.
    // The sandbox still enforces the selected filesystem policy.
    { id: 'sandbox-policy', config: { mode: config.permissionMode, workspaceRoot: config.cwd } },
    { id: 'approval', config: { policy: 'never' } },
    { id: 'permission', config: { defaultPreset: config.permissionMode,
      presets: { [config.permissionMode]: { sandbox: config.permissionMode, approval: 'never' } } } },
  ];
}
export function providerPatches(config) {
  if (!config.reuseProviders) return [];
  if (!exists(config.providerConfigPath)) {
    if (!['deepseek-official', 'deepseek-account'].includes(parseRoute(config.modelRoute).provider))
      throw new Error('找不到桌面版供应商配置，请在设置中选择 cordis.patch.yml');
    return [];
  }
  const doc = parseDocument(fs.readFileSync(config.providerConfigPath, 'utf8'));
  if (doc.errors.length) throw new Error('桌面版供应商 YAML 配置无法解析');
  const entries = doc.toJS();
  if (!Array.isArray(entries)) throw new Error('供应商配置应为 Harness patch 数组');
  // Only import the provider adapter, never desktop UI plugins or default model/permissions.
  const adapter = entries.find(x => x?.id === 'llm-pi-ai');
  if (!adapter?.config?.providers) return [];
  return [{ id: 'llm-pi-ai', disabled: false, config: { providers: adapter.config.providers } }];
}
export function availableRoutes(config) {
  return providerPatches(config).flatMap(p => Object.entries(p.config.providers).flatMap(([provider, c]) =>
    (c.models || []).map(m => `${provider}/${m.id}`)));
}
export function spawnHarness(config, overlayPath, sessionId) {
  const launcher = resolveLauncher(config.executable);
  const args = [...launcher.prefix, '--profile', 'headless', '--patch', overlayPath, '--json'];
  if (sessionId) args.push('--session-id', sessionId);
  args.push('-');
  return spawn(launcher.command, args, {
    cwd: config.cwd, windowsHide: true, shell: false,
    detached: process.platform !== 'win32',
    env: { ...process.env, ...launcher.env, DSH_PERMISSION_MODE: config.permissionMode },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
export function stopTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
