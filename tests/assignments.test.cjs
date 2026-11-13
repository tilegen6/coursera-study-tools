const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateTask, validatePlan, updateQueue, due, safeName } = require('../extension/assignment-core.js');
const task = { kind: 'assignment', type: 'programming', url: 'https://www.coursera.org/learn/demo/programming/a/title', instructions: 'Write a function that returns 42.', fields: [{ id: 'f1', type: 'file', label: 'Upload answer.py', required: true, options: [], starter: '', accept: '.py' }] };
const plan = { status: 'ready', reason: '', values: [{ id: 'f1', text: '', choices: [], files: [{ name: 'answer.py', content: 'def answer():\n    return 42\n' }] }] };
test('generic plan binds known fields and real upload formats', () => {
  assert.equal(validateTask(task), task);
  assert.equal(validatePlan(plan, task), plan);
  for (const name of ['../answer.py', 'C:/answer.py', 'answer.pdf', 'answer.exe', '..answer.py']) assert.equal(safeName(name), false);
  assert.throws(() => validatePlan({ ...plan, values: [{ ...plan.values[0], id: 'unknown' }] }, task));
  assert.throws(() => validatePlan({ ...plan, values: [{ ...plan.values[0], files: [{ name: 'answer.json', content: '{}' }] }] }, task));
  assert.throws(() => validatePlan({ ...plan, values: [] }, task));
  assert.equal(validatePlan({ status: 'needs_input', reason: 'Missing starter data' }, task).status, 'needs_input');
});
test('pending queue backs off and never turns waiting or blocked work into completion', () => {
  let queue = updateQueue([], { key: 'p', url: task.url, status: 'pending_grade', reason: 'Submitted receipt' }, 100);
  assert.equal(queue[0].nextCheckAt, 60100);
  assert.equal(due(queue, 60099), null);
  assert.equal(due(queue, 60100).key, 'p');
  queue = updateQueue(queue, { ...queue[0], checks: 1, status: 'pending_grade' }, 60100);
  assert.equal(queue[0].nextCheckAt, 180100);
  queue = updateQueue(queue, { key: 'missing', url: task.url, status: 'needs_input', reason: 'No editable form' }, 100);
  assert.equal(queue.find(item => item.key === 'missing').nextCheckAt, null);
  assert.equal(queue.some(item => item.status === 'completed'), false);
});

test('manual recheck can recover missing input without automatic polling loops', () => {
  const queue = updateQueue([], { key: 'missing', url: task.url, status: 'needs_input', reason: 'No data' }, 0);
  assert.equal(due(queue, 1000000), null);
  const requested = [{ ...queue[0], manualCheck: true, nextCheckAt: 1 }];
  assert.equal(due(requested, 2).key, 'missing');
  const unresolved = updateQueue(requested, { ...requested[0], status: 'needs_input' }, 2);
  assert.equal(due(unresolved, 1000000), null);
});

test('source uploads accept standard MIME types and reject malformed notebooks', () => {
  const textTask = { ...task, fields: [{ ...task.fields[0], accept: 'text/plain' }] };
  assert.equal(validatePlan({ ...plan, values: [{ ...plan.values[0], files: [{ name: 'answer.txt', content: '42' }] }] }, textTask).status, 'ready');
  const notebookTask = { ...task, fields: [{ ...task.fields[0], accept: '.ipynb' }] };
  assert.throws(() => validatePlan({ ...plan, values: [{ ...plan.values[0], files: [{ name: 'answer.ipynb', content: '{"nbformat":4,"cells":[{"cell_type":"code","source":["42"]}]}' }] }] }, notebookTask));
});

test('HTTP solver supports structured assignment plans without allowing unknown fields', async t => {
  const { createBridge } = require('../bridge/server.cjs');
  const token = 'e'.repeat(64);
  const server = createBridge({ token, solve: async received => { assert.equal(received.kind, 'assignment'); return plan; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const job = await (await fetch(base + '/jobs', { method: 'POST', headers, body: JSON.stringify(task) })).json();
  const result = await (await fetch(base + '/jobs/' + job.id, { headers })).json();
  assert.equal(result.status, 'done'); assert.equal(result.result.values[0].files[0].name, 'answer.py');
});
