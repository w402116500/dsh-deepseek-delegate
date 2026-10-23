import path from 'node:path';
import { DATA, loadJSON } from './config.mjs';

export async function request(runtime, endpoint, data, method) {
  const response = await fetch(runtime.origin + endpoint, {
    method: method || (data ? 'POST' : 'GET'),
    headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' },
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(35000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
export async function ensureServer() {
  try {
    const runtime = loadJSON(path.join(DATA, 'runtime.json'), null);
    if (runtime && /^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.origin)) {
      const result = await request(runtime, '/api/ping');
      if (result.pid === runtime.pid) return runtime;
    }
  } catch { /* Report one actionable plugin error instead of a stale endpoint. */ }
  throw new Error('DeepSeek 委派插件未运行。请启动 DeepSeek Harness，并在「插件」中启用 dsh-deepseek-delegate。');
}
