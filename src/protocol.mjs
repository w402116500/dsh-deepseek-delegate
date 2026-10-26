import { TASK_STATUSES } from './tasks.mjs';

const taskSchema = { type: 'object', properties: {
  id: { type: 'string' }, status: { type: 'string', enum: TASK_STATUSES },
  answer: { type: 'string' }, error: { type: ['string', 'null'] },
}, required: ['id', 'status'] };
const pageSchema = { type: 'object', properties: {
  tasks: { type: 'array', items: taskSchema }, total: { type: 'integer', minimum: 0 },
  limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 },
  hasMore: { type: 'boolean' }, nextOffset: { type: ['integer', 'null'] },
}, required: ['tasks', 'total', 'limit', 'offset', 'hasMore', 'nextOffset'] };

export const TOOLS = [
  { name: 'delegate_to_deepseek', description: 'Delegate work to the configured DeepSeek Harness route. Returns a task ID immediately. Use wait_task to collect the answer. Tasks may use tools according to the permissions selected in the manager; failures are never automatically retried.', inputSchema: { type: 'object', properties: {
    prompt: { type: 'string', description: 'Self-contained task and expected output.' },
    cwd: { type: 'string', description: 'Existing absolute workspace path; defaults to manager settings.' },
    continueTaskId: { type: 'string', description: 'A completed task ID to resume its native session in the same workspace and model.' },
    reasoningEffort: { type: 'string', enum: ['default', 'off', 'low', 'medium', 'high', 'max'], description: 'Per-task thinking strength. Omit to use the manager setting; default follows the selected model/provider setting.' },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$', description: 'Reuse this key with identical arguments after a transport failure to return the original task, even after restart. Different arguments with the same key are rejected. Keys expire when their task is removed by history retention.' },
  }, required: ['prompt'], additionalProperties: false } },
  { name: 'get_task', description: 'Get task state, final answer, session ID, billable token usage, context occupancy and redacted diagnostics.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false } },
  { name: 'wait_task', description: 'Wait up to 30 seconds (default 30 seconds) for a task. A queued/running result means call again; only completed is successful. Returns progress and the final answer; full logs are omitted unless requested.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 0, maximum: 30000, default: 30000 }, includeLogs: { type: 'boolean', default: false, description: 'Include all retained task logs. Usually use get_task for diagnostics instead.' } }, required: ['taskId'], additionalProperties: false } },
  { name: 'cancel_task', description: 'Cancel a queued or running task and stop its owned process tree.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false } },
  { name: 'retry_task', description: 'Manually retry a failed or interrupted task. Returns a new task ID; the original record is kept. The new attempt copies the original prompt, workspace, model, reasoning effort and permission snapshot but starts a fresh session, so it never continues the old one. Any other status is rejected. Nothing is retried automatically.', inputSchema: { type: 'object', properties: { taskId: { type: 'string', description: 'ID of a failed or interrupted task.' } }, required: ['taskId'], additionalProperties: false } },
  { name: 'list_tasks', description: 'List task summaries newest first, with pagination metadata. Defaults to 50 tasks, maximum 100 per page. Use get_task for the full prompt, answer and diagnostics.', inputSchema: { type: 'object', properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    offset: { type: 'integer', minimum: 0, default: 0 },
    status: { type: 'string', enum: TASK_STATUSES, description: 'Only list tasks in this state.' },
  }, additionalProperties: false } },
  { name: 'get_deepseek_settings', description: 'Read the active model route, default reasoning effort, workspace and permission settings. Contains no saved login keys.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
].map(tool => ({ ...tool, outputSchema: tool.name === 'list_tasks' ? pageSchema : tool.name === 'get_deepseek_settings' ? {
  type: 'object', properties: { modelRoute: { type: 'string' }, reasoningEffort: { type: 'string' }, cwd: { type: 'string' }, permissionMode: { type: 'string' }, historyLimit: { type: 'integer' } }, required: ['modelRoute', 'reasoningEffort', 'cwd', 'permissionMode', 'historyLimit'],
} : taskSchema }));
export async function callTool(manager, name, args = {}) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`未知工具：${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是对象');
  for (const key of Object.keys(args)) if (!Object.hasOwn(tool.inputSchema.properties, key)) throw new Error(`未知参数：${key}`);
  for (const key of tool.inputSchema.required || []) if (typeof args[key] !== 'string' || !args[key]) throw new Error(`缺少参数：${key}`);
  for (const [key, value] of Object.entries(args)) {
    const schema = tool.inputSchema.properties[key];
    if (schema.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== schema.type) throw new Error(`参数类型无效：${key}`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(key === 'reasoningEffort' ? '思考强度无效' : `参数值无效：${key}`);
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) throw new Error(`参数超出范围：${key}`);
    if (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength || schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`参数格式无效：${key}`);
  }
  switch (name) {
    case 'delegate_to_deepseek': return manager.delegate(args);
    case 'get_task': return manager.publicTask(manager.get(args.taskId));
    case 'wait_task': {
      const task = await manager.wait(args.taskId, args.timeoutMs ?? 30000);
      const { events, stderr, ...result } = task;
      const queued = manager.tasks.filter(t => t.status === 'queued');
      return { ...result, ...(args.includeLogs ? { events, stderr } : {}), progress: {
        eventCount: events.length, latestEvent: events.at(-1) || null,
        queuePosition: task.status === 'queued' ? queued.findIndex(t => t.id === task.id) + 1 : null,
      } };
    }
    case 'cancel_task': return manager.cancel(args.taskId);
    case 'retry_task': return manager.retry(args.taskId);
    case 'list_tasks': return manager.listPage(args);
    case 'get_deepseek_settings': return manager.settings();
  }
}
