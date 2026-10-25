const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const resources = path.join(path.dirname(process.execPath), 'resources');
  const roots = [
    path.join(resources, 'app.asar/dsh/node_modules'),
    path.join(resources, 'app.asar/node_modules'),
    path.join(resources, 'app/dsh/node_modules'),
    path.join(resources, 'app/node_modules'),
  ];
  const root = roots.find(candidate => fs.existsSync(path.join(candidate, '@deepseek-ai/cordis/lib/index.js')))
    || (fs.existsSync(path.join(resources, 'app.asar')) ? roots[0] : undefined);
  if (!root) throw new Error(`无法在 ${resources} 下找到 Harness 运行时依赖`);
  const load = name => import(pathToFileURL(path.join(root, name)));
  const { Context } = await load('@deepseek-ai/cordis/lib/index.js');
  const { default: WebServer } = await load('@deepseek-ai/dsh-host-webserver/lib/index.js');
  const connectionPlugin = await load('@deepseek-ai/dsh-client-connection/lib/index.js');
  const { installConnection } = await load('@deepseek-ai/dsh-client-connection/lib/client.node.js');
  const plugin = await import('../src/plugin.mjs');
  const { createPanelApi, PANEL_CHANNEL, PANEL_ENDPOINT } = await import('../src/ui/transport.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-lifecycle-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ cwd: dir, reuseProviders: false }));
  let app, cookie, origin, clientConnection;
  const connect = async () => {
    app = new Context();
    await app.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await();
    origin = app.webServer.getOrigin();
    // Credentials stay in memory in this isolated Host; no user files are read.
    const records = new Map();
    app.reflect.provide('credentials', { modifyRecord: async (key, update) => {
      const next = await update(records.get(key));
      if (next !== undefined) records.set(key, next);
      return records.get(key);
    } });
    await app.plugin(connectionPlugin).await();
    app.webServer.registerFallback((req, res) => {
      if (app.connection.authorizeIndex(req, res)) res.end('test Host');
    });
    const auth = await fetch(app.connection.authenticatedUrl(origin), { redirect: 'manual' });
    assert.equal(auth.status, 303);
    cookie = auth.headers.get('set-cookie').split(';')[0];
  };
  // Keep the official client RPC encoder/decoder alive throughout. Only its
  // desktop carrier is replaced: relative URLs follow the current test Host
  // and the carrier supplies that Host's private in-memory browser cookie.
  installConnection({ provide: (name, value) => {
    assert.equal(name, 'connection'); clientConnection = value;
  } }, { transport: { fetch: (input, init) => {
    const headers = new Headers(init.headers); headers.set('Cookie', cookie);
    return fetch(new URL(input, origin + '/'), { ...init, headers });
  } } });
  const api = createPanelApi(() => clientConnection);
  try {
    await connect();
    for (let cycle = 0; cycle < 3; cycle++) {
      const fiber = app.plugin(plugin, { dataDir: dir }); await fiber.await();
      const state = await api('/api/state'); assert.equal(state.dataDir, dir);
      assert.equal((await api('/api/config', { maxConcurrent: 2 }, 'PUT')).maxConcurrent, 2);
      await assert.rejects(api('/api/missing'), /接口不存在/);
      await assert.rejects(api('/api/config', { maxConcurrent: 9 }, 'PUT'), /并发范围/);
      const route = origin + PANEL_CHANNEL + '/' + PANEL_ENDPOINT;
      assert.equal((await fetch(route, { method: 'POST', body: '{}' })).status, 401);
      assert.equal((await fetch(route, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
      const previous = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
      await fiber.restart();
      assert.equal((await api('/api/state')).config.maxConcurrent, 2);
      const next = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
      assert.notEqual(next.token, previous.token);
      await fiber.dispose();
      await assert.rejects(api('/api/state'), /正在重新连接/);
      assert.equal(fs.existsSync(path.join(dir, 'runtime.json')), false);
      assert.equal(fs.existsSync(path.join(dir, 'server.lock')), false);
      console.log('PASS: native plugin enable / restart / disable, cycle ' + (cycle + 1));
      if (cycle === 1) {
        await app.fiber.dispose(); await connect();
        console.log('PASS: Host replacement with retained official client RPC');
      }
    }
  } finally {
    await app?.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
