const assert = require('node:assert/strict');
const { solveCodex, makeAnswers } = require('../bridge/server.cjs');
const { validatePlan } = require('../extension/assignment-core.js');
const quiz = { questions: [{ id: 1, question: 'What is 2 + 2?', type: 'radio', options: ['3', '4', '5'] }] };
(async () => {
  const result = makeAnswers(await solveCodex(quiz, new AbortController().signal), quiz.questions);
  assert.deepEqual(result.answers[0].choices, [2]);
  const task = { kind: 'assignment', type: 'programming', url: 'https://www.coursera.org/learn/demo/programming/a/title', instructions: 'Implement a Python function answer() that returns the integer 42. Preserve the function name.', fields: [{ id: 'code:1', type: 'code', label: 'Python answer.py', required: true, options: [], starter: 'def answer():\n    # TODO\n    pass', accept: '' }] };
  const generated = validatePlan(await solveCodex(task, new AbortController().signal), task);
  assert.equal(generated.status, 'ready');
  assert.match(generated.values[0].text, /def answer\(\)/); assert.match(generated.values[0].text, /return 42/);
  const dialogue={kind:'assignment',type:'generic',url:'https://www.coursera.org/learn/demo/coach/c/title',instructions:'Participate in this educational Coach dialogue as a learner. Answer the latest question concisely. Choose action 1 to reply. Action 2 is allowed only after Coach explicitly says the dialogue is complete. COACH: Why do dynamically generated IDs make Selenium locators unreliable? Do not claim personal experience.',fields:[{id:'coach:action',type:'select',label:'Next action',required:true,options:['Reply to the current question','Finish a completed dialogue'],starter:'',accept:''},{id:'coach:reply',type:'text',label:'Reply to Coach',required:false,options:[],starter:'',accept:''}]};
  const reply=validatePlan(await solveCodex(dialogue,new AbortController().signal),dialogue);
  assert.equal(reply.status,'ready');assert.deepEqual(reply.values.find(value=>value.id==='coach:action').choices,[1]);assert.match(reply.values.find(value=>value.id==='coach:reply').text,/dynamic|chang|unstable|generat/i);
  console.log('CLOUD_SOLVER_PASSED (synthetic quiz, source assignment and Coach reply; ChatGPT-authenticated Codex CLI)');
})().catch(error => { console.error(error.publicMessage || error.message); process.exitCode = 1; });
