import React, { useEffect, useRef, useState } from 'react';
import { createPanelApi } from './transport.mjs';

const PANEL = 'deepseek-delegate';
const statuses = { queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const active = task => ['queued', 'running'].includes(task?.status);
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';

function Icon({ size = 20 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/><path d="M14 6h3a1 1 0 0 1 1 1v3M10 18H7a1 1 0 0 1-1-1v-3M15 8l3 3 3-3M9 16l-3-3-3 3"/></svg>;
}
function Badge({ task }) { return <span className={`dd-badge dd-${task.status}`}>{active(task) && <i/>}{statuses[task.status] || task.status}</span>; }
function Field({ label, hint, children }) { return <label className="dd-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }

function Settings({ state, onSave, busy }) {
  const [form, setForm] = useState(state.config);
  const change = (key, value) => setForm(p => ({ ...p, [key]: value }));
  return <form className="dd-settings" onSubmit={e => { e.preventDefault(); onSave(form); }}>
    <div className="dd-section-head"><h2>委派设置</h2><p>新任务使用这里的配置。正在执行的任务保留派发时的配置。</p></div>
    <Field label="模型路由" hint="格式：供应商 / 模型。支持在下方填写自己的路由。"><input required list="dd-routes" value={form.modelRoute} onChange={e => change('modelRoute', e.target.value)}/><datalist id="dd-routes">{state.routes.map(r => <option key={r} value={r}/>)}</datalist></Field>
    <Field label="默认工作目录"><input required value={form.cwd} onChange={e => change('cwd', e.target.value)}/></Field>
    <div className="dd-grid">
      <Field label="任务权限" hint="自动执行时不会弹出交互审批；需要审批的操作会失败。"><select value={form.permissionMode} onChange={e => change('permissionMode', e.target.value)}><option value="read-only">只读</option><option value="workspace-write">允许修改工作目录</option><option value="danger-full-access">完全访问</option></select></Field>
      <Field label="同时执行任务数"><input type="number" min="1" max="4" required value={form.maxConcurrent} onChange={e => change('maxConcurrent', Number(e.target.value))}/></Field>
      <Field label="任务超时（秒）"><input type="number" min="10" max="3600" required value={form.timeoutSeconds} onChange={e => change('timeoutSeconds', Number(e.target.value))}/></Field>
    </div>
    <h3>Harness 连接</h3>
    <Field label="CLI 或桌面程序路径" hint={`留空自动检测${state.launcher ? `：${state.launcher}` : '。支持官方 dsh.cmd 或 DeepSeek Harness.exe。'}`}><input value={form.executable} placeholder="自动检测" onChange={e => change('executable', e.target.value)}/></Field>
    <label className="dd-check"><input type="checkbox" checked={form.reuseSavedAuth} onChange={e => change('reuseSavedAuth', e.target.checked)}/>复用 Harness 已保存的登录与凭据</label>
    <label className="dd-check"><input type="checkbox" checked={form.reuseProviders} onChange={e => change('reuseProviders', e.target.checked)}/>复用桌面配置中的第三方供应商</label>
    <Field label="供应商配置文件" hint="读取其中的供应商声明，凭据仍由 Harness 管理。"><input disabled={!form.reuseProviders} value={form.providerConfigPath} onChange={e => change('providerConfigPath', e.target.value)}/></Field>
    {(state.launcherError || state.providerError) && <pre className="dd-error">{state.launcherError || state.providerError}</pre>}
    <button className="dd-primary" disabled={busy} type="submit">保存设置</button>
    <p className="dd-subtle">数据目录：{state.dataDir}</p>
  </form>;
}

function Integration({ state, onNotice }) {
  const [format, setFormat] = useState('toml');
  const copy = async () => {
    try { await navigator.clipboard.writeText(state.integration[format]); onNotice('已复制连接配置'); }
    catch { onNotice('无法访问剪贴板，请选中下面的配置手动复制。'); }
  };
  return <div className="dd-settings">
    <div className="dd-section-head"><h2>连接 Codex</h2><p>添加一次 MCP 配置，之后可直接在 Codex 中委派任务。</p></div>
    <ol className="dd-steps"><li>保持 Harness 运行，并启用本插件。</li><li>将下面的配置加入 Codex 的 <code>config.toml</code>。</li><li>重新加载 Codex 的 MCP 连接，在新对话中测试工具。</li></ol>
    <div className="dd-code-head"><div className="dd-switch"><button aria-pressed={format === 'toml'} onClick={() => setFormat('toml')}>Codex · TOML</button><button aria-pressed={format === 'json'} onClick={() => setFormat('json')}>通用 JSON</button></div><button onClick={copy}>复制配置</button></div>
    <pre className="dd-code" tabIndex="0">{state.integration[format]}</pre>
    <h3>可用工具</h3><div className="dd-tools">{[['delegate_to_deepseek', '派发任务或续聊'], ['wait_task', '等待任务完成'], ['get_task', '读取回答与日志'], ['cancel_task', '取消任务'], ['list_tasks', '查看任务列表'], ['get_deepseek_settings', '读取当前设置']].map(([name, label]) => <div key={name}><code>{name}</code><span>{label}</span></div>)}</div>
    <p className="dd-subtle">MCP 与这里共用任务记录。关闭 Harness 会中断任务，连接程序会在下次调用时重新寻找插件。</p>
  </div>;
}

function Page({ api }) {
  const [state, setState] = useState(null), [tab, setTab] = useState('tasks');
  const [selected, setSelected] = useState(null), [detail, setDetail] = useState(null);
  const [prompt, setPrompt] = useState(''), [cwd, setCwd] = useState(''), [parent, setParent] = useState(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const selection = useRef(null); selection.current = selected;
  useEffect(() => {
    let disposed = false, pending = false;
    async function refresh() {
      if (pending) return; pending = true;
      try {
        const next = await api('/api/state');
        const taskId = selection.current;
        const task = taskId ? await api(`/api/tasks/${taskId}`) : null;
        if (!disposed) { setState(next); setError(''); if (selection.current === taskId) setDetail(task); }
      } catch (e) { if (!disposed) setError(e.message); }
      finally { pending = false; }
    }
    refresh(); const timer = setInterval(refresh, 1500);
    return () => { disposed = true; clearInterval(timer); };
  }, [api]);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(timer); } }, [notice]);
  async function action(fn) {
    setBusy(true); setError('');
    try { await fn(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  const choose = task => { setSelected(task.id); setDetail(null); setParent(null); };
  const newTask = () => { setSelected(null); setDetail(null); setParent(null); setPrompt(''); setCwd(''); setTab('tasks'); };
  const submit = e => {
    e.preventDefault(); action(async () => {
      const task = await api('/api/tasks', { prompt, ...(cwd ? { cwd } : {}), ...(parent ? { continueTaskId: parent.id } : {}) });
      setDetail(task); setSelected(task.id); setParent(null); setPrompt('');
      setState(p => ({ ...p, tasks: [task, ...p.tasks] }));
    });
  };
  const resume = () => { setParent(detail); setCwd(detail.cwd); setSelected(null); setDetail(null); setPrompt(''); };
  const testConnection = () => action(async () => {
    const task = await api('/api/tasks', { prompt: '连通性测试：不要调用工具，不要读取或修改文件。请只回复 DEEPSEEK_PLUGIN_OK。' });
    setTab('tasks'); setSelected(task.id); setDetail(task); setParent(null);
    setState(p => ({ ...p, tasks: [task, ...p.tasks] }));
  });
  return <section className="dd-root" aria-label="DeepSeek 委派管理">
    <header className="dd-header"><div className="dd-heading"><div className="dd-logo"><Icon size={23}/></div><div><h1>DeepSeek 委派</h1><p>把任务交给 DeepSeek，进度留在这里。</p></div></div><span className={`dd-connection ${state && !error ? 'dd-online' : ''}`}><i/>{state && !error ? '插件已连接' : '等待连接'}</span></header>
    <nav className="dd-nav" aria-label="委派管理导航">{[['tasks', '任务'], ['settings', '设置'], ['integration', 'MCP 连接']].map(([id, name]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{name}</button>)}<span/>{state && <button disabled={busy} onClick={testConnection}>连通性测试 ↗</button>}</nav>
    {error && <div role="alert" className="dd-alert">{error}</div>}{notice && <div role="status" className="dd-notice">{notice}</div>}
    {!state ? <div className="dd-loading">正在连接委派服务…</div> : tab === 'settings' ? <Settings state={state} busy={busy} onSave={form => action(async () => { const config = await api('/api/config', form, 'PUT'); setState(p => ({ ...p, config })); setNotice('设置已保存'); })}/> : tab === 'integration' ? <Integration state={state} onNotice={setNotice}/> : <div className="dd-workspace">
      <aside className="dd-tasklist"><div className="dd-list-head"><span>全部任务 <b>{state.tasks.length}</b></span><button onClick={newTask} aria-label="新建任务">＋ 新建</button></div>
        {!state.tasks.length && <p className="dd-empty-list">还没有任务。<br/>从右侧派发第一个任务。</p>}
        {state.tasks.map(task => <button className={`dd-task ${selected === task.id ? 'dd-selected' : ''}`} key={task.id} onClick={() => choose(task)}><div><Badge task={task}/><small>{new Date(task.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small></div><strong>{task.prompt}</strong><p>{task.preview || task.modelRoute}</p></button>)}
      </aside>
      <main className="dd-content">
        {!selected ? <form className="dd-compose" onSubmit={submit}><div className="dd-section-head"><span className="dd-eyebrow">{parent ? '继续原生会话' : '新任务'}</span><h2>{parent ? '继续这项工作' : '让 DeepSeek 帮你完成任务'}</h2><p>清楚描述目标、上下文和期望结果。</p></div>
          {parent && <div className="dd-parent"><span>接续：{parent.prompt.slice(0, 100)}</span><button type="button" onClick={newTask}>取消续聊</button></div>}
          <Field label="任务内容"><textarea required rows={9} maxLength={65536} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="例如：分析当前项目的目录结构，说明入口和主要模块，不修改文件。"/></Field>
          <Field label="工作目录" hint={parent ? '续聊沿用原任务的工作目录和模型路由。' : '留空使用设置中的默认目录。'}><input value={cwd} disabled={!!parent} placeholder={state.config.cwd} onChange={e => setCwd(e.target.value)}/></Field>
          <div className="dd-compose-footer"><div><code>{state.config.modelRoute}</code><small>{({ 'read-only': '只读', 'workspace-write': '可修改工作目录', 'danger-full-access': '完全访问' })[state.config.permissionMode]}</small></div><button className="dd-primary" disabled={busy || !prompt.trim()} type="submit">{busy ? '正在派发…' : parent ? '续聊 →' : '派发任务 →'}</button></div>
        </form> : !detail || detail.id !== selected ? <div className="dd-loading">读取任务…</div> : <div className="dd-detail"><div className="dd-detail-head"><Badge task={detail}/><span/>{active(detail) && <button disabled={busy} onClick={() => action(async () => setDetail(await api(`/api/tasks/${detail.id}/cancel`, {})))}>取消任务</button>}{detail.status === 'completed' && detail.sessionId && <button onClick={resume}>继续对话 →</button>}</div>
          <h2>任务详情</h2><pre className="dd-prompt">{detail.prompt}</pre><div className="dd-metadata"><span>模型 <code>{detail.modelRoute}</code></span><span>目录 <code>{detail.cwd}</code></span><span>创建于 {time(detail.createdAt)}</span><span>结束于 {time(detail.endedAt)}</span></div>
          <h3>回答</h3><pre className="dd-answer">{detail.answer || (active(detail) ? 'DeepSeek 正在处理任务，结果会自动更新。' : '没有最终回答。')}</pre>
          {detail.error && <pre className="dd-error" role="alert">{detail.error}</pre>}
          <details><summary>执行日志 · {detail.events.length} 条</summary><div className="dd-events">{detail.events.map((event, i) => <div key={i}><small>{new Date(event.at).toLocaleTimeString('zh-CN')}</small><code>{event.type}</code><pre>{event.text}</pre></div>)}{detail.stderr && <pre>{detail.stderr}</pre>}</div></details>
          <div className="dd-ids">任务 {detail.id}<br/>会话 {detail.sessionId || '尚未建立'}</div>
        </div>}
      </main>
    </div>}
  </section>;
}

export const inject = ['slots', 'layout', 'connection'];
export function apply(ctx) {
  const api = createPanelApi(() => ctx.connection);
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = __DELEGATE_CSS__; document.head.append(style);
    return () => style.remove();
  }, 'deepseek-delegate: styles');
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, inject: () => ({ api }) }, Page));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 20, label: 'DeepSeek 委派' }, Icon));
}
