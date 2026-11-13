const {test}=require('node:test'),assert=require('node:assert/strict');
const {watch,until}=require('../extension/activity.js');
test('media and DOM notifications coalesce and queued work is inert after cleanup',async()=>{
  const listeners=new Map();let notify,disconnected=false,wakes=0;
  const document={documentElement:{},addEventListener:(name,callback)=>listeners.set(name,callback),removeEventListener:name=>listeners.delete(name)};
  class Observer{constructor(callback){notify=callback;}observe(){}disconnect(){disconnected=true;}}
  const stop=watch(()=>wakes++,document,Observer);
  listeners.get('canplay')();notify();listeners.get('ended')();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(wakes,1);
  notify();stop();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(wakes,1);assert.equal(listeners.size,0);assert.equal(disconnected,true);
});
test('module readiness observes delayed content and cancellation cleans up',async()=>{
  let changed,ready=false,disconnected=0;
  const document={documentElement:{}};
  class Observer{constructor(callback){changed=callback;}observe(){}disconnect(){disconnected++;}}
  const loaded=until(()=>ready,{document,Observer,timeout:1000});ready=true;changed();assert.equal(await loaded,true);
  ready=false;const controller=new AbortController();const cancelled=until(()=>ready,{document,Observer,signal:controller.signal,timeout:1000});controller.abort();await assert.rejects(cancelled,/Aborted/);assert.equal(disconnected,2);
});
