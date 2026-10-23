import { DATA, redact } from './config.mjs';
import { startServer } from './server.mjs';
import { PANEL_CHANNEL, PANEL_ENDPOINT } from './ui/transport.mjs';

export const name = 'deepseek-delegate';
export const inject = ['connection'];

export async function apply(ctx, config = {}) {
  let disposed = false;
  const starting = startServer(config.dataDir || DATA);
  // Register cleanup before awaiting the listener so disabling during startup
  // cannot leak a server or a directory lock.
  ctx.effect(() => async () => {
    disposed = true;
    const app = await starting.catch(() => null);
    await app?.close();
  }, 'deepseek-delegate: stop tasks and loopback transport');
  const app = await starting;
  if (disposed) return;
  try {
    // The native carrier authenticates each request and survives plugin reloads.
    // External MCP clients continue to use the private loopback transport.
    // Exact /api routes inherit Connection's Host, Origin, cookie and owner checks.
    // The registry also removes this route when our plugin fiber is disposed.
    ctx.connection.fetch.register({
      path: `${PANEL_CHANNEL}/${PANEL_ENDPOINT}`, methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 });
        }
        let message;
        try { message = await request.json(); }
        catch { return new Response('body is not JSON', { status: 400 }); }
        let result;
        try {
          const payload = message?.payload;
          if (message?.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== PANEL_ENDPOINT
            || !payload || !['GET', 'POST', 'PUT'].includes(payload.method) || typeof payload.endpoint !== 'string') {
            throw new Error('无效的委派请求');
          }
          const { value, status } = await app.dispatch(payload.method, payload.endpoint, payload.data);
          if (status >= 400) throw new Error(value.error);
          result = { ok: true, value };
        } catch (e) {
          result = { ok: false, error: { code: 'delegate/request-failed', message: redact(e.message), details: {} } };
        }
        return Response.json({ type: 'server-response', rpcId: typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request', result }, {
          headers: { 'Cache-Control': 'no-store' },
        });
      },
    });
    ctx.logger.info('DeepSeek 委派已启动，管理入口：侧边栏 → DeepSeek 委派');
  } catch (e) { await app.close(); throw e; }
}
