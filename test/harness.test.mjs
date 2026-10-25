import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLauncher } from '../src/harness.mjs';

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}

test('resolves unpacked DSH Desktop resources/app layout', t => {
  const install = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-'));
  t.after(() => fs.rmSync(install, { recursive: true, force: true }));
  const executable = path.join(install, 'DSH Desktop.exe');
  const entry = path.join(install, 'resources', 'app', 'lib', 'desktop-cli.js');
  touch(executable); touch(entry);
  assert.deepEqual(resolveLauncher(executable), {
    command: executable,
    prefix: ['--expose-internals', entry],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    detected: executable,
  });
});

test('keeps resolving legacy DeepSeek Harness app.asar layout', t => {
  const install = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-harness-'));
  t.after(() => fs.rmSync(install, { recursive: true, force: true }));
  const executable = path.join(install, 'DeepSeek Harness.exe');
  const archive = path.join(install, 'resources', 'app.asar');
  touch(executable); touch(archive);
  assert.deepEqual(resolveLauncher(executable), {
    command: executable,
    prefix: ['--expose-internals', path.join(archive, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    detected: executable,
  });
});
