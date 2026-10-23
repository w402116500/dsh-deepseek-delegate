const mode = process.argv[2];
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
const emit = object => process.stdout.write(JSON.stringify(object) + '\n');
emit({ type: 'session', sessionId: process.argv[3] || 'fixture-session' });
if (mode === 'hang') { setInterval(() => {}, 1000); }
else if (mode === 'error') {
  emit({ type: 'status', phase: 'turn_end', reason: { kind: 'error', error: { message: 'provider rejected' } } });
  emit({ type: 'final', text: '' });
  setTimeout(() => { process.stderr.write('late diagnostic'); process.exitCode = 1; }, 50);
} else if (mode === 'incomplete') {
  emit({ type: 'final', text: 'plausible answer without completion' });
} else {
  emit({ type: 'text', text: '正在处理中文 🐳' });
  emit({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } });
  emit({ type: 'final', text: `answer:${prompt}` });
}
