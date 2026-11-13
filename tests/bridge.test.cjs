const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBridge, validateQuiz, makeAnswers, codexArguments } = require('../bridge/server.cjs');
const quiz = { url: 'https://www.coursera.org/learn/demo/quiz/a/title', questions: [{ id: 1, question: '2 + 2?', type: 'radio', options: ['3', '4'] }] };
const solved = { status: 'solved', answers: [{ id: 1, choices: [2], text: '' }] };
const token = 'a'.repeat(64);

test('quiz feedback is preserved as bounded untrusted task data',()=>{
  assert.equal(validateQuiz({...quiz,feedback:'Previous answer was incorrect.'}).feedback,'Previous answer was incorrect.');
  for(const feedback of [null,{},'x'.repeat(32001)])assert.throws(()=>validateQuiz({...quiz,feedback}));
});

test('both solver task types pin the requested model and non-reasoning mode instead of CLI defaults',()=>{
  const args=codexArguments('/tmp/schema.json','/tmp/answer.json');
  assert.equal(args[args.indexOf('--model')+1],'gpt-6-sol');
  assert.equal(args.filter(arg=>arg==='--model').length,1);
  assert.equal(args.filter(arg=>arg==='model_reasoning_effort="none"').length,1);
  assert(args.includes('--ignore-user-config'));
  assert(args.includes('forced_login_method="chatgpt"'));
});

test('quiz validation rejects foreign URLs, oversized data and unsupported shapes', () => {
  assert.deepEqual(validateQuiz(quiz), quiz);
  for (const invalid of [
    { ...quiz, url: 'https://evil.example/learn/a/quiz/a/a' },
    { ...quiz, questions: [] },
    { ...quiz, questions: Array(41).fill(quiz.questions[0]) },
    { ...quiz, questions: [{ ...quiz.questions[0], question: 'a'.repeat(9000) }] },
    { ...quiz, questions: [{ ...quiz.questions[0], type: 'code' }] },
    { ...quiz, questions: [{ ...quiz.questions[0], options: [] }] }
  ]) assert.throws(() => validateQuiz(invalid));
});

test('model output cannot replace questions and must contain valid complete answers', () => {
  const answers = makeAnswers(solved, quiz.questions);
  assert.deepEqual(answers.answers[0], { id: 1, question: '2 + 2?', options: ['3', '4'], choices: [2] });
  for (const invalid of [
    { status: 'uncertain', answers: [] },
    { status: 'solved', answers: [] },
    { status: 'solved', answers: [{ id: 1, choices: [9], text: '' }] },
    { status: 'solved', answers: [{ id: 2, choices: [2], text: '' }] }
  ]) assert.throws(() => makeAnswers(invalid, quiz.questions));
  const args = codexArguments('/tmp/schema.json', '/tmp/answer.json');
  assert(args.includes('--ignore-user-config'));
  assert(args.includes('shell_tool'));
  assert(args.includes('apps'));
  assert(args.includes('plugins'));
  assert(args.includes('project_doc_max_bytes=0'));
  assert(args.includes('forced_login_method="chatgpt"'));
  assert(!args.some(arg => arg.includes('dangerously')));
});

test('HTTP bridge authenticates before invoking solver and rejects webpage origins', async t => {
  let calls = 0;
  const server = createBridge({ token, solve: async () => { calls++; return solved; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: `chrome-extension://${'a'.repeat(32)}` };
  assert.equal((await fetch(`${base}/jobs`, { method: 'POST', body: JSON.stringify(quiz) })).status, 401);
  assert.equal((await fetch(`${base}/jobs`, { method: 'POST', headers: { ...headers, origin: 'https://www.coursera.org' }, body: JSON.stringify(quiz) })).status, 403);
  assert.equal(calls, 0);
  const created = await fetch(`${base}/jobs`, { method: 'POST', headers, body: JSON.stringify(quiz) });
  assert.equal(created.status, 202);
  const { id } = await created.json();
  const result = await (await fetch(`${base}/jobs/${id}`, { headers })).json();
  assert.equal(result.status, 'done');
  assert.equal(result.result.answers[0].choices[0], 2);
  assert.equal(calls, 1);
  assert.equal((await fetch(`${base}/jobs`, { method: 'POST', headers, body: 'x'.repeat(210000) })).status, 413);
});

test('jobs have one active solver, support cancellation, and hide internal errors', async t => {
  let activeSignal;
  const server = createBridge({ token, solve: async (quiz, signal) => new Promise((resolve, reject) => {
    activeSignal = signal;
    signal.addEventListener('abort', () => reject(new Error('private stderr must not leak')));
  }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const request = () => fetch(`${base}/jobs`, { method: 'POST', headers, body: JSON.stringify(quiz) });
  const first = await (await request()).json();
  assert.equal((await request()).status, 409);
  assert.equal((await fetch(`${base}/jobs/${first.id}`, { method: 'DELETE', headers })).status, 200);
  assert.equal(activeSignal.aborted, true);
  const job = await (await fetch(`${base}/jobs/${first.id}`, { headers })).json();
  assert.equal(job.status, 'cancelled');
  assert.equal(JSON.stringify(job).includes('private stderr'), false);
});

test('model uncertainty and temporary job failures retain structured queue reasons',async t=>{
  const server=createBridge({token,solve:async q=>{if(q.questions[0].question==='uncertain')return {status:'uncertain',answers:[]};throw Object.assign(Error('private diagnostic'),{status:503,publicMessage:'Temporary solver failure'});}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  for(const [question,code]of [['uncertain','SOLVER_UNCERTAIN'],['temporary','SOLVER_TEMPORARY']]){
    const created=await(await fetch(base+'/jobs',{method:'POST',headers,body:JSON.stringify({...quiz,questions:[{...quiz.questions[0],question}]})})).json();
    let job;for(let i=0;i<20;i++){job=await(await fetch(base+'/jobs/'+created.id,{headers})).json();if(job.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(job.status,'error');assert.equal(job.code,code);assert(!JSON.stringify(job).includes('private diagnostic'));
  }
});
