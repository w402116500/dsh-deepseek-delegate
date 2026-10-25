import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveLauncher } from '../src/harness.mjs';

// Use the installed desktop runtime so ASAR packages and Cordis are real.
// The child creates an isolated Host and never opens the user's profile.
const launcher = resolveLauncher();
if (launcher.env.ELECTRON_RUN_AS_NODE !== '1') {
  throw new Error('此测试需要 Harness 桌面运行时，请将 DSH_EXECUTABLE 指向 DeepSeek Harness.exe、DSH Desktop.exe 或官方 dsh.cmd。');
}
const child = spawn(launcher.command, ['--expose-internals', fileURLToPath(new URL('./lifecycle-host.cjs', import.meta.url))], {
  shell: false, windowsHide: true, stdio: 'inherit', env: { ...process.env, ...launcher.env },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
