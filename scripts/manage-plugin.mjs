import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { ROOT, DATA } from '../src/config.mjs';
import { resolveLauncher } from '../src/harness.mjs';

const action = process.argv[2];
const profile = process.argv[3] || 'desktop';
if (!['install', 'uninstall'].includes(action) || !/^[\w.-]+$/.test(profile)) throw new Error('用法：node scripts/manage-plugin.mjs install|uninstall [profile]');
const harnessHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profileDir = path.join(harnessHome, 'profiles', profile);
if (fs.existsSync(profileDir)) {
  const backup = path.join(profileDir, '.deepseek-delegate-backups', new Date().toISOString().replaceAll(':', '-'));
  fs.mkdirSync(backup, { recursive: true });
  for (const file of ['package.json', 'pnpm-lock.yaml']) {
    if (fs.existsSync(path.join(profileDir, file))) fs.copyFileSync(path.join(profileDir, file), path.join(backup, file));
  }
  console.log(`Profile 清单备份：${backup}`);
}
if (action === 'install') {
  // One-time migration of the earlier local prototype's non-secret records.
  fs.mkdirSync(DATA, { recursive: true });
  for (const file of ['tasks.json', 'config.json']) {
    const old = path.join(ROOT, 'data', file), dest = path.join(DATA, file);
    if (fs.existsSync(old) && !fs.existsSync(dest)) fs.copyFileSync(old, dest);
  }
}
const launcher = resolveLauncher();
const args = [...launcher.prefix, 'plugin', '--profile', profile, ...(action === 'install' ? ['add', ROOT] : ['remove', 'dsh-deepseek-delegate'])];
const child = spawn(launcher.command, args, { cwd: ROOT, shell: false, windowsHide: true, stdio: 'inherit', env: { ...process.env, ...launcher.env } });
child.on('error', e => { console.error(e.message); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; if (!code) console.log(action === 'install' ? '插件已安装。请启动或重启 Harness，侧边栏选择「DeepSeek 委派」。' : '插件已卸载，任务数据予以保留。'); });
