const {test}=require('node:test'),assert=require('node:assert/strict');
const {solveQuizBatches}=require('../bridge/quiz-batches.cjs');
const quiz={questions:Array.from({length:12},(_,i)=>({id:i+1,question:'Question '+(i+1),type:'radio',options:['A','B']}))};
test('only an uncertain long quiz falls back once to small batches with unchanged question IDs',async()=>{
  const calls=[];
  const result=await solveQuizBatches(quiz,async batch=>{calls.push(batch.questions.map(q=>q.id));return batch.questions.length>5?{status:'uncertain',reason:'Need smaller context',answers:[]}:{status:'solved',answers:batch.questions.map(q=>({id:q.id,choices:[2],text:''}))};});
  assert.deepEqual(calls,[quiz.questions.map(q=>q.id),[1,2,3,4,5],[6,7,8,9,10],[11,12]]);
  assert.equal(result.status,'solved');assert.deepEqual(result.answers.map(a=>a.id),quiz.questions.map(q=>q.id));
});
test('a solved quiz is never requested again; uncertainty in a small batch never becomes a fabricated complete result',async()=>{
  let calls=0;const solved={status:'solved',answers:[]};assert.equal(await solveQuizBatches(quiz,async()=>{calls++;return solved;}),solved);assert.equal(calls,1);
  calls=0;const result=await solveQuizBatches(quiz,async batch=>{calls++;return {status:'uncertain',reason:'Question requires unavailable course context',answers:[]};});
  assert.equal(result.status,'uncertain');assert.match(result.reason,/unavailable/);assert.equal(calls,2);
  const controller=new AbortController();controller.abort();await assert.rejects(()=>solveQuizBatches(quiz,async()=>solved,controller.signal));
});
