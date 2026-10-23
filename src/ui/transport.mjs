// Use the carrier owned by Harness, which follows Host/plugin restarts.
// Never retain a loopback address or bearer from the page's boot payload.
export const PANEL_CHANNEL = '/api';
export const PANEL_ENDPOINT = 'deepseek-delegate/request';

export function createPanelApi(getConnection) {
  return async (endpoint, data, method) => {
    let result;
    try {
      result = await getConnection().rpc.call(PANEL_CHANNEL, PANEL_ENDPOINT, {
        endpoint, method: method || (data ? 'POST' : 'GET'), data,
      }, AbortSignal.timeout(12000));
    } catch {
      throw new Error('委派服务暂不可用，正在重新连接。请确认插件已启用。');
    }
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
}
