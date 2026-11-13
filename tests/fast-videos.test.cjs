const {test}=require('node:test'),assert=require('node:assert/strict');
const {complete,lectures}=require('../extension/fast-videos.js');
const url='https://www.coursera.org/learn/demo/lecture/a/title';
const links=Array.from({length:20},(_,i)=>`https://www.coursera.org/learn/demo/lecture/v${i}/title`);
const response=(body,status=200)=>({ok:status===200,status,text:async()=>JSON.stringify(body)});
test('only current-course lecture links become bounded video events, with no grade writes',async()=>{
  assert.deepEqual(lectures(url,[...links,links[0],'https://evil.test/learn/demo/lecture/b/title','https://www.coursera.org/learn/other/lecture/a/title','https://www.coursera.org/learn/demo/quiz/q/title']),links.map((_,i)=>'v'+i));
  let live=0,peak=0;const posts=[];
  const result=await complete({url,links,request:async(target,options)=>{
    assert.equal(options.credentials,'include');
    if(options.method==='GET')return response({elements:[{id:123}]});
    live++;peak=Math.max(peak,live);posts.push(target);
    assert.deepEqual(JSON.parse(options.body),{contentRequestBody:{}});
    await new Promise(resolve=>setImmediate(resolve));live--;return response({});
  }});
  assert(peak>1&&peak<=8);assert.equal(posts.length,20);assert.equal(new Set(posts).size,20);
  assert(posts.every(target=>/^https:\/\/www\.coursera\.org\/api\/opencourse\.v1\/user\/123\/course\/demo\/item\/v\d+\/lecture\/videoEvents\/ended\?autoEnroll=false$/.test(target)));
  assert.equal(result.accepted.length,20);assert.equal(result.completed,undefined);
});
test('invalid identity, unsupported endpoint and cancellation never authorize more writes',async()=>{
  let writes=0;
  const invalid=await complete({url,links,request:async(target,options)=>{if(options.method==='POST')writes++;return response({elements:[{id:'../other'}]});}});
  assert.equal(invalid.accepted.length,0);assert.equal(writes,0);
  await complete({url,links,request:async(target,options)=>{if(options.method==='GET')return response({elements:[{id:'123'}]});writes++;return response({},404);}});
  assert(writes>0&&writes<=8);
  const controller=new AbortController();controller.abort();writes=0;
  await assert.rejects(complete({url,links,signal:controller.signal,request:async()=>{writes++;return response({});}}),/abort/i);
  assert.equal(writes,0);
});
test('Stop during a batch prevents the remaining queued requests and does not report completion',async()=>{
  const controller=new AbortController();let writes=0;
  await assert.rejects(complete({url,links,signal:controller.signal,request:async(target,options)=>{
    if(options.method==='GET')return response({elements:[{id:'123'}]});
    writes++;controller.abort();return response({});
  }}),/abort/i);
  assert.equal(writes,1);
});
