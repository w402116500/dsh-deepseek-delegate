import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';
import { request } from '../src/client.mjs';
import { TOOLS } from '../src/protocol.mjs';

const fixture = fileURLToPath(new URL('./fixture-harness.mjs', import.meta.url));

async function finish(manager, id) {
  for (let i = 0; i < 10; i++) {
    const task = await manager.wait(id, 1000);
    if (!['running', 'queued'].includes(task.status)) return task;
  }
  throw new Error('fixture did not finish');
}

test('MCP may override the saved thinking strength and can follow the model default', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-delegate-reasoning-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runs = [];
  const app = await startServer(dir, { launch: (config, overlay, session) => {
    runs.push({ config, patch: JSON.parse(fs.readFileSync(overlay, 'utf8')) });
    return spawn(process.execPath, [fixture, 'ok', ...(session ? [session] : [])], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } });
  t.after(() => app.close());

  const tool = TOOLS.find(candidate => candidate.name === 'delegate_to_deepseek');
  assert.deepEqual(tool.inputSchema.properties.reasoningEffort.enum, ['default', 'off', 'low', 'medium', 'high', 'max']);
  await request(app.runtime, '/api/config', {
    cwd: dir, reuseProviders: false, reasoningEffort: 'high',
  }, 'PUT');

  const override = await request(app.runtime, '/api/tool', {
    name: 'delegate_to_deepseek', arguments: { prompt: 'one task', reasoningEffort: 'low' },
  });
  const overrideDone = await finish(app.manager, override.id);
  assert.equal(overrideDone.reasoningEffort, 'low');
  assert.equal(runs[0].config.reasoningEffort, 'low');
  assert.equal(runs[0].patch.find(entry => entry.id === 'agent-default-model').config.reasoningEffort, 'low');

  const inherited = await request(app.runtime, '/api/tool', {
    name: 'delegate_to_deepseek', arguments: { prompt: 'use manager setting' },
  });
  await finish(app.manager, inherited.id);
  assert.equal(inherited.reasoningEffort, 'high');
  assert.equal(runs[1].patch.find(entry => entry.id === 'agent-default-model').config.reasoningEffort, 'high');

  const modelDefault = await request(app.runtime, '/api/tool', {
    name: 'delegate_to_deepseek', arguments: { prompt: 'follow model', reasoningEffort: 'default' },
  });
  await finish(app.manager, modelDefault.id);
  assert.equal(modelDefault.reasoningEffort, 'default');
  assert.equal(Object.hasOwn(runs[2].patch.find(entry => entry.id === 'agent-default-model').config, 'reasoningEffort'), false);

  await assert.rejects(request(app.runtime, '/api/tool', {
    name: 'delegate_to_deepseek', arguments: { prompt: 'invalid', reasoningEffort: 'ultra' },
  }), /思考强度无效/);
});
