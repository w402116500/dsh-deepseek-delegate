import { DATA, redact } from './config.mjs';
import { ensureServer, request } from './client.mjs';
import { serveStdio } from './mcp.mjs';
import { integrationConfig } from './server.mjs';

async function main() {
  const mode = process.argv[2] || 'status';
  if (mode === 'mcp') return serveStdio();
  if (mode === 'config') { console.log(integrationConfig(DATA).toml); return; }
  if (mode !== 'status') throw new Error('用法：node src/cli.mjs mcp | config | status');
  const runtime = await ensureServer();
  const state = await request(runtime, '/api/state');
  console.log(JSON.stringify({ running: true, modelRoute: state.config.modelRoute, tasks: state.tasks.length, dataDir: DATA }, null, 2));
}
main().catch(e => { console.error(redact(e.message)); process.exitCode = 1; });
