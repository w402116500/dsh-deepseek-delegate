export const TOOLS = [
  { name: 'delegate_to_deepseek', description: 'Delegate work to the configured DeepSeek Harness route. Returns a task ID immediately. Use wait_task to collect the answer. Tasks may use tools according to the permissions selected in the manager; failures are never automatically retried.', inputSchema: { type: 'object', properties: {
    prompt: { type: 'string', description: 'Self-contained task and expected output.' },
    cwd: { type: 'string', description: 'Existing absolute workspace path; defaults to manager settings.' },
    continueTaskId: { type: 'string', description: 'A completed task ID to resume its native session in the same workspace and model.' },
  }, required: ['prompt'], additionalProperties: false } },
  { name: 'get_task', description: 'Get task state, final answer, session ID, billable token usage, context occupancy and redacted diagnostics.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false } },
  { name: 'wait_task', description: 'Wait up to 30 seconds for a task. A queued/running result means call again; only completed is successful.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 0, maximum: 30000, default: 10000 } }, required: ['taskId'], additionalProperties: false } },
  { name: 'cancel_task', description: 'Cancel a queued or running task and stop its owned process tree.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false } },
  { name: 'retry_task', description: 'Manually retry a failed or interrupted task. Returns a new task ID; the original record is kept. The new attempt copies the original prompt, workspace, model and permission snapshot but starts a fresh session, so it never continues the old one. Any other status is rejected. Nothing is retried automatically.', inputSchema: { type: 'object', properties: { taskId: { type: 'string', description: 'ID of a failed or interrupted task.' } }, required: ['taskId'], additionalProperties: false } },
  { name: 'list_tasks', description: 'List recent tasks with reported billable token usage; use get_task for full results and context occupancy.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_deepseek_settings', description: 'Read the active model route, workspace and permission settings. Contains no saved login keys.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
export async function callTool(manager, name, args = {}) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`未知工具：${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是对象');
  for (const key of Object.keys(args)) if (!Object.hasOwn(tool.inputSchema.properties, key)) throw new Error(`未知参数：${key}`);
  for (const key of tool.inputSchema.required || []) if (typeof args[key] !== 'string' || !args[key]) throw new Error(`缺少参数：${key}`);
  switch (name) {
    case 'delegate_to_deepseek': return manager.delegate(args);
    case 'get_task': return manager.publicTask(manager.get(args.taskId));
    case 'wait_task': return manager.wait(args.taskId, args.timeoutMs ?? 10000);
    case 'cancel_task': return manager.cancel(args.taskId);
    case 'retry_task': return manager.retry(args.taskId);
    case 'list_tasks': return manager.list();
    case 'get_deepseek_settings': return manager.settings();
  }
}
