import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { atomicJSON, loadJSON, validateConfig, DEFAULTS, redact } from './config.mjs';
import { buildOverlay, spawnHarness, stopTree } from './harness.mjs';

export const ACTIVE = new Set(['queued', 'running']);
// Only terminal states that never produced a definitive answer may be retried,
// and only when a human asks for it. Nothing retries automatically.
export const RETRYABLE = new Set(['failed', 'interrupted']);
const MAX_OUTPUT = 16 * 1024 * 1024;
const RETRY_REJECT = { queued: '任务还在排队中', running: '任务正在运行中', completed: '任务已完成，请使用续聊', cancelled: '任务已被取消' };
const USAGE_FIELDS = ['totalTokens', 'inputTokens', 'outputTokens', 'thoughtTokens', 'cachedReadTokens', 'cachedWriteTokens'];
const USAGE_ALIASES = {
  totalTokens: ['totalTokens', 'total_tokens'],
  inputTokens: ['inputTokens', 'input_tokens', 'uncachedInputTokens', 'uncached_input_tokens'],
  outputTokens: ['outputTokens', 'output_tokens'],
  thoughtTokens: ['thoughtTokens', 'thought_tokens', 'reasoningTokens', 'reasoning_tokens'],
  cachedReadTokens: ['cachedReadTokens', 'cached_read_tokens', 'cacheReadTokens', 'cache_read_tokens'],
  cachedWriteTokens: ['cachedWriteTokens', 'cached_write_tokens', 'cacheWriteTokens', 'cache_write_tokens'],
};

// Harness currently forwards ACP usage as camelCase integer token counts. Keep
// this parser deliberately tolerant of partial updates because older/newer
// Harness releases may omit optional counters or wrap usage in another event.
export function normalizeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = {};
  for (const key of USAGE_FIELDS) {
    const valueForKey = USAGE_ALIASES[key].map(alias => value[alias]).find(item => item !== undefined);
    if (Number.isSafeInteger(valueForKey) && valueForKey >= 0) usage[key] = valueForKey;
  }
  return Object.keys(usage).length ? usage : null;
}

function addUsage(previous, next) {
  if (!next) return previous || null;
  const usage = {};
  for (const key of USAGE_FIELDS) {
    const a = previous?.[key], b = next[key];
    if (Number.isSafeInteger(a) && Number.isSafeInteger(b) && a + b <= Number.MAX_SAFE_INTEGER) usage[key] = a + b;
    else if (Number.isSafeInteger(b)) usage[key] = b;
    else if (Number.isSafeInteger(a)) usage[key] = a;
  }
  return Object.keys(usage).length ? usage : null;
}

function normalizeContextUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const used = value.used, size = value.size;
  if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(size) || size < 0) return null;
  return { used, size };
}

export class TaskManager extends EventEmitter {
  constructor(dir, { launch = spawnHarness } = {}) {
    super();
    this.dir = dir; this.launch = launch; this.children = new Map(); this.closing = false;
    fs.mkdirSync(dir, { recursive: true });
    this.config = validateConfig(loadJSON(path.join(dir, 'config.json'), DEFAULTS));
    this.tasks = loadJSON(path.join(dir, 'tasks.json'), []);
    for (const t of this.tasks) {
      if (t.usage) t.usage = normalizeUsage(t.usage);
      if (!t.contextUsage) t.contextUsage = null;
      if (!ACTIVE.has(t.status)) continue;
      t.status = 'interrupted'; t.error = '服务重启，任务状态不确定。请检查工作目录后再决定是否重新派发。'; t.endedAt = new Date().toISOString();
    }
    this.persist();
  }
  persist() { atomicJSON(path.join(this.dir, 'tasks.json'), this.tasks); }
  changed(t, persist = true) {
    if (persist) this.persist();
    this.emit('change', t?.id);
  }
  settings(input) {
    if (!input) return this.config;
    const next = validateConfig({ ...this.config, ...input });
    atomicJSON(path.join(this.dir, 'config.json'), next); this.config = next;
    this.emit('change'); this.pump(); return next;
  }
  get(id) { const t = this.tasks.find(t => t.id === id); if (!t) throw new Error('任务不存在'); return t; }
  list() { return [...this.tasks].reverse().map(({ events, answer, stderr, config, ...t }) => ({ ...t, preview: (answer || '').slice(0, 140) })); }
  usageSummary() {
    const totals = Object.fromEntries(USAGE_FIELDS.map(key => [key, 0]));
    let reportedTaskCount = 0;
    for (const task of this.tasks) {
      if (!task.usage) continue;
      reportedTaskCount++;
      for (const key of USAGE_FIELDS) if (Number.isSafeInteger(task.usage[key])) totals[key] += task.usage[key];
    }
    return { taskCount: this.tasks.length, reportedTaskCount, ...totals };
  }
  delegate(input) {
    if (this.closing) throw new Error('服务正在关闭');
    const { prompt, continueTaskId } = input;
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 65536) throw new Error('请输入任务，最大 64 KiB');
    this.assertCapacity();
    const config = validateConfig({
      ...this.config,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    });
    let sessionId;
    if (continueTaskId) {
      const parent = this.get(continueTaskId);
      if (parent.status !== 'completed' || !parent.sessionId) throw new Error('只能续聊已完成且有会话 ID 的任务');
      if (path.resolve(parent.cwd).toLowerCase() !== path.resolve(config.cwd).toLowerCase()) throw new Error('续聊必须使用原任务的工作目录');
      if (parent.modelRoute !== config.modelRoute) throw new Error('续聊必须使用原任务的模型路由');
      if (this.tasks.some(t => ACTIVE.has(t.status) && t.sessionId === parent.sessionId)) throw new Error('此会话已有未结束任务');
      sessionId = parent.sessionId;
    }
    const t = this.create({ prompt, config, sessionId, continueTaskId: continueTaskId || null });
    return this.publicTask(t);
  }
  // A manual retry is a brand-new execution attempt: it copies the recorded
  // execution snapshot of the failed task, never inherits its session, and
  // leaves the original record untouched so history stays auditable.
  retry(id) {
    if (this.closing) throw new Error('服务正在关闭');
    const source = this.get(id);
    if (!RETRYABLE.has(source.status)) {
      throw new Error(`只有失败或已中断的任务可以重试（当前状态：${RETRY_REJECT[source.status] || source.status}）`);
    }
    this.assertCapacity();
    const config = validateConfig(source.config);
    const t = this.create({
      prompt: source._prompt ?? source.prompt, config,
      sessionId: null, continueTaskId: null,
      retryOf: source.id, attempt: (source.attempt || 1) + 1,
    });
    return this.publicTask(t);
  }
  assertCapacity() {
    if (this.tasks.filter(t => ACTIVE.has(t.status)).length >= 100) throw new Error('任务队列已满');
  }
  create({ prompt, config, sessionId = null, continueTaskId = null, retryOf = null, attempt = 1 }) {
    const t = { id: randomUUID(), prompt: redact(prompt), cwd: config.cwd, modelRoute: config.modelRoute,
      reasoningEffort: config.reasoningEffort,
      permissionMode: config.permissionMode, status: 'queued', createdAt: new Date().toISOString(),
      continueTaskId, sessionId, answer: '', stderr: '', events: [], config,
      exitCode: null, error: null, usage: null, contextUsage: null, retryOf, attempt };
    // Keep the literal prompt only in memory until delivered; persisted task records are redacted.
    Object.defineProperty(t, '_prompt', { value: prompt, configurable: true });
    this.tasks.push(t); this.changed(t); queueMicrotask(() => this.pump());
    return t;
  }
  publicTask(t) { const { config, ...visible } = t; return visible; }
  event(t, type, text) {
    t.events.push({ at: new Date().toISOString(), type, text: redact(text).slice(0, 4000) });
    if (t.events.length > 250) t.events.shift();
    this.emit('change', t.id);
  }
  pump() {
    if (this.closing) return;
    for (const t of this.tasks) {
      if (this.children.size >= this.config.maxConcurrent) break;
      if (t.status === 'queued') this.run(t);
    }
  }
  run(t) {
    t.status = 'running'; t.startedAt = new Date().toISOString();
    const overlayPath = path.join(this.dir, `${t.id}.patch.json`);
    let child;
    try {
      atomicJSON(overlayPath, buildOverlay(t.config));
      child = this.launch(t.config, overlayPath, t.sessionId);
    } catch (e) {
      t.status = 'failed'; t.error = redact(e.message); t.endedAt = new Date().toISOString(); this.changed(t);
      fs.rmSync(overlayPath, { force: true }); queueMicrotask(() => this.pump()); return;
    }
    this.children.set(t.id, child); this.changed(t);
    let line = '', bytes = 0, errBytes = 0, completed = false, final = '', failure = '', stopReason;
    const decoder = new StringDecoder('utf8'); const errDecoder = new StringDecoder('utf8');
    const stop = reason => { if (!stopReason) { stopReason = reason; stopTree(child); } };
    child._stop = stop;
    const handleLine = raw => {
      raw = raw.replace(/\r$/, ''); if (!raw.trim()) return;
      let ev;
      try { ev = JSON.parse(raw); } catch {
        if (/^\[llm-deepseek-account\] model listing from https?:\/\/\S+ loaded \d+ model\(s\), skipped \d+ row\(s\)$/.test(raw)) return;
        failure ||= `CLI 输出不是有效 JSON：${redact(raw).slice(0, 600)}`; return;
      }
      if (!ev || typeof ev !== 'object') { failure ||= 'CLI 返回无效事件'; return; }
      if (ev.type === 'session') t.sessionId = ev.sessionId || ev.session_id || t.sessionId;
      const usageEvent = ev.usage ?? ev.result?.usage ?? ev.data?.usage ?? ev.update?.usage ?? ev.reason?.usage ?? ev.event?.usage ?? (ev.type === 'usage' ? ev : null);
      const usage = normalizeUsage(usageEvent);
      if (usage) { t.usage = addUsage(t.usage, usage); this.emit('change', t.id); }
      const contextUsage = normalizeContextUsage(ev.sessionUpdate === 'usage_update' || ev.type === 'usage_update' ? ev : null);
      if (contextUsage) { t.contextUsage = contextUsage; this.emit('change', t.id); }
      if (ev.type === 'text') this.event(t, 'text', ev.text || '');
      if (ev.type === 'tool_call') this.event(t, 'tool', ev.name || ev.toolName || ev.tool?.name || '工具调用');
      if (ev.type === 'status') {
        this.event(t, 'status', `${ev.phase || ''} ${ev.reason?.kind || ''}`);
        if (ev.phase === 'turn_end' && ev.reason?.kind === 'completed') completed = true;
        if (ev.phase === 'turn_end' && ev.reason?.kind === 'error') failure ||= ev.reason.error?.message || 'Harness 执行失败';
      }
      if (ev.type === 'final') {
        if (typeof ev.text !== 'string') failure ||= 'CLI final 事件没有文本';
        else if (Buffer.byteLength(ev.text) > 262144) failure ||= '最终回答超过 256 KiB';
        else { final = redact(ev.text); t.answer = final; this.emit('change', t.id); }
      }
      if (ev.type === 'error') failure ||= ev.message || ev.error?.message || 'CLI 返回错误';
    };
    const consume = data => {
      line += data;
      let pos;
      while ((pos = line.indexOf('\n')) >= 0) { handleLine(line.slice(0, pos)); line = line.slice(pos + 1); }
    };
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { stop('输出超过 16 MiB'); return; }
      consume(decoder.write(chunk));
    });
    child.stderr.on('data', chunk => {
      errBytes += chunk.length;
      t.stderr = (t.stderr + redact(errDecoder.write(chunk))).slice(-8192);
      if (errBytes > 2 * 1024 * 1024) stop('错误日志超过 2 MiB');
    });
    child.on('error', e => { failure ||= e.message; });
    child.stdin.on('error', e => { if (e.code !== 'EPIPE') failure ||= e.message; });
    const timeout = setTimeout(() => stop('运行超时'), t.config.timeoutSeconds * 1000);
    child.once('close', (code, signal) => {
      clearTimeout(timeout); consume(decoder.end()); if (line) handleLine(line);
      t.stderr = redact(t.stderr + errDecoder.end()).slice(-8192);
      t.exitCode = code; t.signal = signal; t.endedAt = new Date().toISOString();
      if (t.status === 'cancelled' || t.status === 'interrupted') { /* Preserve intentional terminal status. */ }
      else if (stopReason || failure || code !== 0 || !completed || !final.trim()) {
        t.status = 'failed';
        t.error = redact(stopReason || failure || (code !== 0 ? `CLI 退出码 ${code}${signal ? ` (${signal})` : ''}` : !completed ? 'CLI 退出前未收到完成事件' : 'CLI 返回空回答'));
        if (t.stderr.trim()) t.error += `\n${t.stderr}`;
      } else { t.status = 'completed'; t.error = null; }
      this.children.delete(t.id); fs.rmSync(overlayPath, { force: true }); this.changed(t); this.pump();
    });
    child.stdin.end(t._prompt ?? t.prompt);
    delete t._prompt;
  }
  cancel(id) {
    const t = this.get(id);
    if (!ACTIVE.has(t.status)) return this.publicTask(t);
    t.status = 'cancelled'; t.endedAt = new Date().toISOString(); t.error = '任务已取消';
    this.children.get(id)?._stop('任务已取消'); delete t._prompt; this.changed(t); return this.publicTask(t);
  }
  async wait(id, timeoutMs = 10000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000) throw new Error('等待时间范围为 0–30000 毫秒');
    const t = this.get(id);
    if (!ACTIVE.has(t.status) || timeoutMs === 0) return this.publicTask(t);
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.off('change', onChange); resolve(); };
      const onChange = changedId => { if (changedId === id && !ACTIVE.has(t.status)) done(); };
      const timer = setTimeout(done, timeoutMs); this.on('change', onChange);
    });
    return this.publicTask(t);
  }
  async close() {
    this.closing = true;
    const children = [...this.children.values()];
    const drained = Promise.all(children.map(child => new Promise(resolve => child.once('close', resolve))));
    for (const t of this.tasks) if (ACTIVE.has(t.status)) {
      t.status = 'interrupted'; t.error = '服务已关闭，请检查任务结果后再决定是否重新派发。'; t.endedAt = new Date().toISOString();
      this.children.get(t.id)?._stop('服务已关闭');
    }
    this.persist();
    await drained;
  }
}
