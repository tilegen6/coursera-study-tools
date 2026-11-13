const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('late terminal poll cannot remove a replacement job after stop/restart', async () => {
  const stored = {};
  let listener, pollStarted, finishOldPoll, sequence = 0;
  const started = new Promise(resolve => pollStarted = resolve);
  const oldResponse = new Promise(resolve => finishOldPoll = resolve);
  const id = 'a'.repeat(32);
  const chrome = {
    storage: {
      local: { setAccessLevel: async () => {}, get: async () => ({ bridgeToken: 'b'.repeat(64) }) },
      session: { get: async key => structuredClone({ [key]: stored[key] }), set: async data => Object.assign(stored, structuredClone(data)), remove: async key => { delete stored[key]; } }
    },
    runtime: { id, getURL: file => `chrome-extension://${id}/${file}`, onMessage: { addListener: callback => listener = callback } },
    tabs: { sendMessage: async () => ({ ok: true, data: true }), onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} } }
  };
  const fetch = async (url, options) => {
    if (options.method === 'POST') return { ok: true, json: async () => ({ id: `job-${++sequence}` }) };
    if (options.method === 'DELETE') return { ok: true, json: async () => ({ status: 'cancelled' }) };
    if (url.endsWith('job-1')) { pollStarted(); return oldResponse; }
    return { ok: true, json: async () => ({ status: 'running' }) };
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), { CourseraStudy:require('../extension/core.js'),chrome, fetch, AbortSignal, Map, Promise, Error });
  const sender = { id, tab: { id: 7 }, url: 'https://www.coursera.org/learn/demo/quiz/a/title' };
  const nonce1 = 'a'.repeat(36), nonce2 = 'b'.repeat(36);
  function send(action, nonce) {
    return new Promise(resolve => listener({ source: 'coursera-study-solver', action, data: { nonce, url: sender.url, questions: [] } }, sender, resolve));
  }
  assert.equal((await send('start', nonce1)).ok, true);
  const oldPoll = send('poll', nonce1);
  await started;
  const stop = send('cancel', nonce1);
  const restart = send('start', nonce2);
  await new Promise(resolve => setImmediate(resolve));
  finishOldPoll({ ok: true, json: async () => ({ status: 'done', result: { answers: [] } }) });
  await Promise.all([oldPoll, stop]);
  assert.equal((await restart).ok, true);
  assert.equal(stored['solver:7'].id, 'job-2');
  assert.equal(stored['solver:7'].nonce, nonce2);
  await send('cancel', nonce1);
  assert.equal(stored['solver:7'].id, 'job-2');
});

test('course checkpoints have one active writer and account binding without touching editors', async () => {
  const session = {}, local = { bridgeToken: 'b'.repeat(64) };
  let listener, interruptions = 0;
  const removed = [];
  const storage = data => ({
    get: async key => key === null ? structuredClone(data) : structuredClone({ [key]: data[key] }),
    set: async value => Object.assign(data, structuredClone(value)),
    remove: async key => { delete data[key]; }, setAccessLevel: async () => {}
  });
  const id = 'a'.repeat(32), scope = 'https://www.coursera.org/learn/demo/';
  const chrome = {
    storage: { local: storage(local), session: storage(session) },
    runtime: { id, getURL: file => `chrome-extension://${id}/${file}`, onMessage: { addListener: callback => listener = callback } },
    tabs: { query: async () => [{id:1},{id:2}], remove: async tabId => removed.push(tabId), onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} } },
    scripting: { executeScript: async options => {
      if (options.args[0] === 'interrupt') { interruptions++; return [{ result: { interrupted: true } }]; }
      return [{ documentId: 'doc', result: { busy: true, url: scope, fields: [] } }];
    } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), { chrome, fetch: async () => ({ ok: true, json: async () => ({ ready: true }) }), AbortSignal, Map, Promise, Error, encodeURIComponent, courseraEditorBridge: function () {} });
  const send = (tabId, action, data = {}) => new Promise(resolve => listener({ source: 'coursera-study-course', action, data: { accountHint: 'user-a', ...data } }, { id, tab: { id: tabId }, url: scope + 'peer/p/title' }, resolve));
  const starts = await Promise.all([send(1, 'start', { runId: 'a'.repeat(36), settings: { speed: 2 } }), send(2, 'start', { runId: 'b'.repeat(36), settings: { speed: 2 } })]);
  assert.equal(starts.filter(result => result.ok).length, 1);
  const tabId = starts[0].ok ? 1 : 2, record = starts.find(result => result.ok).data;
  assert.equal(record.settings.autoHonorCode,false);
  const progress = { ...record.progress, queue: [{ key: scope + 'peer/p', status: 'pending_grade' }] };
  assert.equal((await send(tabId, 'save', { runId: record.id, progress })).ok, true);
  assert(local['checkpoint:' + scope + ':user-a']);
  const journal=[{item:scope+'quiz/q',attempt:1,at:Date.now(),confirmed:true}];
  const full={...progress,submitted:journal,quizReviews:Object.fromEntries(['one','two','three'].map((name,index)=>[scope+'quiz/'+name,{attempt:index,score:80,feedback:name[0].repeat(32000),reviewed:true}]))};
  assert(JSON.stringify(full).length>64000);
  assert.equal((await send(tabId,'save',{runId:record.id,progress:full})).ok,true,'several bounded feedback notes must fit together');
  assert.equal(JSON.stringify(local['checkpoint:'+scope+':user-a'].progress)===JSON.stringify(full),true,'checkpoint must retain all serialized progress');
  for(const invalid of [{...full,padding:'x'.repeat(256001)},{...full,visited:null},{...full,submitted:null},{...full,pages:null}])assert.equal((await send(tabId,'save',{runId:record.id,progress:invalid})).ok,false);
  assert.equal(JSON.stringify(session['course:'+tabId].progress)===JSON.stringify(full),true,'a rejected save must preserve the last valid journal and feedback');
  session['workspace:' + tabId] = { tabId: 99, runId: record.id };
  assert.equal((await send(tabId, 'stop', { runId: record.id })).ok, true);
  assert.equal(interruptions,0);assert.deepEqual(removed,[]);assert.equal(session['workspace:' + tabId].tabId,99);
  const resumed=await send(tabId,'start',{runId:'d'.repeat(36),settings:{speed:2,resumeQueue:true}});assert.equal(resumed.ok,true);assert.equal(JSON.stringify(resumed.data.progress.submitted)===JSON.stringify(journal),true);assert.equal(JSON.stringify(resumed.data.progress.quizReviews)===JSON.stringify(full.quizReviews),true);await send(tabId,'stop',{runId:resumed.data.id});
  const other = await send(tabId, 'start', { accountHint: 'user-b', runId: 'c'.repeat(36), settings: { speed: 2, resumeQueue: true, autoHonorCode:true } });
  assert.equal(other.ok, true); assert.equal(other.data.progress.queue.length, 0);
  assert.equal(other.data.settings.autoHonorCode,true);
  const beforeSwitch = interruptions;
  assert.equal((await send(tabId, 'save', { accountHint: 'user-a', runId: other.data.id, progress: other.data.progress })).ok, false);
  assert.equal(interruptions,beforeSwitch);
});

test('a stale course owner is removed only after Chrome confirms its tab is closed',async()=>{
  const id='a'.repeat(32),scope='https://www.coursera.org/learn/demo/',accountHint='user-a';
  const submitted=[{item:scope+'assessment/q',attempt:1,at:1,confirmed:false}];
  const progress={visited:[],submitted,pages:[],queue:[{key:scope+'assessment/q',url:scope+'assignment-submission/q/title',status:'pending_grade'}]};
  const checkpoint={scope,accountHint,progress,updated:1};
  for(const mode of ['closed','live','unavailable']){
    const session={'course:1':{id:'a'.repeat(36),scope,accountHint,progress},'solver:1':{id:'old-job',nonce:'b'.repeat(36)}};
    const local={bridgeToken:'b'.repeat(64),['checkpoint:'+scope+':'+accountHint]:structuredClone(checkpoint)};
    let listener,posts=0;
    const storage=data=>({get:async key=>structuredClone(key===null?data:{[key]:data[key]}),set:async patch=>Object.assign(data,structuredClone(patch)),remove:async key=>{delete data[key];},setAccessLevel:async()=>{}});
    const chrome={storage:{local:storage(local),session:storage(session)},runtime:{id,getURL:file=>`chrome-extension://${id}/${file}`,onMessage:{addListener:callback=>listener=callback}},tabs:{query:async()=>{if(mode==='unavailable')throw Error('Tab inventory unavailable');return mode==='live'?[{id:1},{id:2}]:[{id:2}];},onRemoved:{addListener:()=>{}},onUpdated:{addListener:()=>{}}}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),{chrome,fetch:async(url,options)=>{if(options.method==='POST')posts++;return {ok:true,json:async()=>({status:'cancelled'})};},AbortSignal,Map,Promise,Error,encodeURIComponent});
    const result=await new Promise(resolve=>listener({source:'coursera-study-course',action:'start',data:{runId:'c'.repeat(36),accountHint,settings:{speed:2,resumeQueue:true,target100:true,autoHonorCode:true}}},{id,tab:{id:2},url:scope+'assignment-submission/q/title'},resolve));
    assert.equal(result.ok,mode==='closed',mode+': '+(result.error||'unexpected takeover'));
    assert.deepEqual(local['checkpoint:'+scope+':'+accountHint],checkpoint,'recovery must not rewrite the durable submission journal');
    assert.equal(posts,0,'owner cleanup must not submit another model job');
    if(mode==='closed'){
      assert.equal(session['course:1'],undefined);
      assert.equal(session['solver:1'],undefined);
      assert.deepEqual(result.data.progress.submitted,submitted,'an ambiguous submission must survive owner replacement');
      assert.equal(result.data.progress.queue[0].status,'pending_grade');
    }else{
      assert(session['course:1'],'live or unverified owner must survive');
      assert(session['solver:1'],'live or unverified solver must survive');
      assert.equal(session['course:2'],undefined);
    }
  }
});

test('an obsolete document cannot stop or overwrite a course during document handoff',async()=>{
  const id='a'.repeat(32),scope='https://www.coursera.org/learn/demo/',runId='a'.repeat(36);
  const session={'course:1':{id:runId,scope,progress:{visited:[],submitted:[],pages:[]}}};let listener;
  const storage=data=>({get:async key=>structuredClone(key===null?data:{[key]:data[key]}),set:async patch=>Object.assign(data,structuredClone(patch)),remove:async key=>{delete data[key];},setAccessLevel:async()=>{}});
  let pendingUrl=scope+'coach/next/title',status='complete',url=scope+'coach/c/title';
  const chrome={storage:{session:storage(session),local:storage({})},runtime:{id,getURL:file=>`chrome-extension://${id}/${file}`,onMessage:{addListener:callback=>listener=callback}},tabs:{get:async tabId=>{assert.equal(tabId,1);return {pendingUrl,status,url};},onRemoved:{addListener:()=>{}},onUpdated:{addListener:()=>{}}},scripting:{executeScript:async()=>[{frameId:0,documentId:'new-document',result:scope+'coach/c/title'}]}};
  const context={chrome,Map,Promise,Error,encodeURIComponent};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),context);
  const send=(documentId,action,data={})=>new Promise(resolve=>listener({source:'coursera-study-course',action,data:{runId,...data}},{id,tab:{id:1},url:scope+'coach/c/title',documentId,frameId:0},resolve));
  assert.equal((await send('old-document','stop')).ok,false);
  assert.equal(session['course:1'].id,runId,'late old-document Stop must preserve the run before new-document resume');
  assert.equal((await send('new-document','resume')).data.id,runId);
  assert.equal((await send('new-document','navigation')).data,true);
  pendingUrl='https://www.coursera.org/learn/another/coach/next/title';
  assert.equal((await send('new-document','navigation')).data,false);
  pendingUrl=undefined;assert.equal((await send('new-document','navigation')).data,false);
  status='loading';assert.equal((await send('new-document','navigation')).data,true,'a same-URL reload has no pendingUrl');
  pendingUrl='https://www.coursera.org/learn/another/coach/next/title';assert.equal((await send('new-document','navigation')).data,false,'loading cannot authorize a pending departure from the course');
  pendingUrl=undefined;url='https://www.coursera.org/learn/another/coach/next/title';assert.equal((await send('new-document','navigation')).data,false);
  status='complete';url=scope+'coach/c/title';
  assert.equal((await send('old-document','save',{progress:{visited:['stale'],submitted:[],pages:[]}})).ok,false);
  assert.equal(session['course:1'].progress.visited.length,0);
  assert.equal((await send('new-document','stop',{reason:'Explicit current-document Stop'})).ok,true);
  assert.equal(session['course:1'],undefined);
  const inactive=(await send('new-document','resume')).data;
  assert.equal(inactive.inactive,true);assert.equal(inactive.reason,'Explicit current-document Stop');
  session['course:1']={id:runId,scope,progress:{visited:[],submitted:[],pages:[]}};
  let activeDocument='old-document',release;
  chrome.scripting.executeScript=async()=>[{frameId:0,documentId:activeDocument,result:scope+'coach/c/title'}];
  const holding=context.withTab(1,()=>new Promise(resolve=>{release=resolve;}));
  await new Promise(resolve=>setImmediate(resolve));
  const staleStop=send('old-document','stop');await new Promise(resolve=>setImmediate(resolve));
  activeDocument='new-document';release();await holding;
  assert.equal((await staleStop).ok,false,'document identity must be checked after acquiring the tab operation lock');
  assert.equal(session['course:1'].id,runId);
});

function automaticWorker({token,request,native}={}) {
  const local={bridgeToken:token},id='a'.repeat(32);let nativeCalls=0,listener,updated;
  const context={CourseraStudy:require('../extension/core.js'),AbortSignal,URL,fetch:request,chrome:{
    storage:{local:{setAccessLevel:async()=>{},get:async()=>({...local}),set:async data=>Object.assign(local,data)}},
    runtime:{id,getURL:file=>`chrome-extension://${id}/${file}`,sendNativeMessage:async(name,message)=>{nativeCalls++;assert.equal(name,'com.coursera.studytools');assert.equal(message.action,'connect');return native();},onMessage:{addListener:callback=>listener=callback}},
    tabs:{onRemoved:{addListener:()=>{}},onUpdated:{addListener:callback=>updated=callback}}
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),context);
  return {context,local,calls:()=>nativeCalls,id,update:(tabId,change)=>updated(tabId,change),send:(request,sender)=>new Promise(resolve=>listener(request,sender,resolve))};
}
const healthResponse=()=>({ok:true,status:200,json:async()=>({ready:true,provider:'codex-chatgpt'})});

test('solver uses the verified active document URL after a same-document SPA route change',async()=>{
  const cover='https://www.coursera.org/learn/demo/assignment-submission/a/title',attempt=cover+'/attempt';
  let liveUrl=attempt,liveDocumentId='active-document',posts=0;const session={};
  const worker=automaticWorker({token:'b'.repeat(64),request:async(url,options)=>{
    if(url.endsWith('/health'))return healthResponse();
    if(options.method==='POST'){posts++;return {ok:true,json:async()=>({id:'spa-job'})};}
    return {ok:true,json:async()=>({status:'running'})};
  }});
  worker.context.chrome.storage.session={get:async key=>({[key]:session[key]}),set:async data=>Object.assign(session,data),remove:async key=>{delete session[key];}};
  worker.context.chrome.tabs.sendMessage=async()=>({ok:true,data:true});
  worker.context.chrome.scripting={executeScript:async()=>[{frameId:0,documentId:liveDocumentId,result:liveUrl}]};
  const sender={id:worker.id,tab:{id:7},url:cover,frameId:0,documentId:'active-document'};
  const send=action=>worker.send({source:'coursera-study-solver',action,data:{nonce:'a'.repeat(36),url:attempt,documentNonce:'b'.repeat(36),questions:[]}},sender);
  assert.equal((await send('start')).ok,true);assert.equal(posts,1);
  assert.equal(session['solver:7'].url,attempt);
  assert.equal((await send('poll')).ok,true);
  liveUrl=cover;
  worker.update(7,{url:cover,status:'loading'});await new Promise(resolve=>setImmediate(resolve));
  assert(session['solver:7'],'same-activity history updates must not cancel a model job');
  assert.equal((await send('poll')).ok,true,'a cover/result route of the same activity must retain its job');
  liveUrl='https://www.coursera.org/learn/demo/assignment-submission/other/title';
  assert.equal((await send('poll')).ok,false);assert.equal(posts,1);
  liveUrl=cover;liveDocumentId='replacement-document';worker.update(7,{status:'complete'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(session['solver:7'],undefined,'a replaced document must still cancel the old job');
});

test('the extension worker rejects assignment jobs and non-quiz solver routes before any model request',async()=>{
  let requests=0;
  const worker=automaticWorker({request:async()=>{requests++;return healthResponse();}});
  worker.context.chrome.storage.session={get:async()=>({}),remove:async()=>{}};
  const url='https://www.coursera.org/learn/demo/quiz/q/title';
  const data={nonce:'a'.repeat(36),url,questions:[],task:{kind:'assignment'}};
  await assert.rejects(()=>worker.context.handle({action:'start',data},{tab:{id:7},url}),/только в тестах/);
  for(const type of ['peer','coach','programming','lab']){
    const other=url.replace('/quiz/',`/${type}/`);
    await assert.rejects(()=>worker.context.handle({action:'start',data:{...data,url:other,task:undefined}},{tab:{id:7},url:other}),/только в тестах/);
  }
  assert.equal(requests,0);
});

test('page launcher reads only non-sensitive preferences while tokens remain private',async()=>{
  const worker=automaticWorker({token:'d'.repeat(64)});
  worker.local.settings={speed:1.5,skipVideo:false,autoNext:false,bridgeToken:'private',other:'private'};
  const sender={tab:{id:7},url:'https://www.coursera.org/learn/demo/coach/c/title'};
  const result=await worker.context.handleCourse({action:'preferences'},sender);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{speed:1.5,skipVideo:false,autoNext:false,autoHonorCode:false,target100:true});
  assert(!JSON.stringify(result).includes('private'));assert(!JSON.stringify(result).includes('d'.repeat(64)));
  delete worker.local.settings;
  assert.deepEqual(JSON.parse(JSON.stringify(await worker.context.handleCourse({action:'preferences'},sender))),{speed:2,skipVideo:true,autoNext:true,autoHonorCode:false,target100:true});
  await assert.rejects(()=>worker.context.handleCourse({action:'preferences'},{tab:{id:7},url:'https://example.com/'}));
});
test('automatic native connection is shared, verified and never exposes the token to page messages',async()=>{
  const token='d'.repeat(64);
  const worker=automaticWorker({native:async()=>({ok:true,version:1,token}),request:async()=>healthResponse()});
  await Promise.all([worker.context.bridge('/health'),worker.context.bridge('/health')]);
  assert.equal(worker.calls(),1);assert.equal(worker.local.bridgeToken,token);
  const result=await worker.context.handle({action:'connect'},{url:`chrome-extension://${worker.id}/popup.html`});
  assert.equal(result.ready,true);assert.equal(result.token,undefined);
  const before=worker.calls();
  await assert.rejects(worker.context.handle({action:'connect',data:{nonce:'a'.repeat(36)}},{url:'https://www.coursera.org/learn/demo/quiz/q/title',tab:{id:3}}),/Неизвестная/);
  assert.equal(worker.calls(),before);
});
test('401 refreshes native credentials but ambiguous job network errors never resend',async()=>{
  const old='b'.repeat(64),fresh='c'.repeat(64);let attempts=0,created=0;
  const worker=automaticWorker({token:old,native:async()=>({ok:true,version:1,token:fresh}),request:async(url,options)=>{
    if(options.method==='POST'){attempts++;if(options.headers.Authorization===`Bearer ${old}`)return {ok:false,status:401,json:async()=>({error:'Unauthorized'})};created++;return {ok:true,status:202,json:async()=>({id:'job'})};}
    return healthResponse();
  }});
  assert.equal((await worker.context.bridge('/jobs','POST',{})).id,'job');
  assert.equal(attempts,2);assert.equal(created,1);assert.equal(worker.calls(),1);
  const failing=automaticWorker({token:old,native:async()=>({ok:true,version:1,token:fresh}),request:async()=>{throw Error('connection reset');}});
  await assert.rejects(failing.context.bridge('/jobs','POST',{}),/недоступен/);assert.equal(failing.calls(),0);
});
test('unverified native credentials cannot overwrite an existing pairing',async()=>{
  const worker=automaticWorker({token:'b'.repeat(64),native:async()=>({ok:true,version:1,token:'c'.repeat(64)}),request:async()=>({ok:false,status:401,json:async()=>({error:'Unauthorized'})})});
  await assert.rejects(worker.context.connectNative(),/Unauthorized/);
  assert.equal(worker.local.bridgeToken,'b'.repeat(64));
});

test('native failure retains the real browser error and loaded permission metadata without credentials',async()=>{
  const secret='c'.repeat(64);
  const worker=automaticWorker({native:async()=>{throw Error('Access to native messaging host is forbidden. '+secret);},request:async()=>healthResponse()});
  worker.context.chrome.runtime.getManifest=()=>({version:'1.3.2',permissions:['storage']});
  await assert.rejects(worker.context.connectNative(),/forbidden/);
  assert.equal(worker.local.connectionDiagnostics.loadedVersion,'1.3.2');
  assert.equal(worker.local.connectionDiagnostics.nativePermission,false);
  assert.equal(JSON.stringify(worker.local.connectionDiagnostics).includes(secret),false);
  assert.equal(worker.local.connectionDiagnostics.extensionId,worker.id);
});

test('solver checks health before creating a job and restarts a stopped service without repeating POST',async()=>{
  const old='b'.repeat(64),fresh='d'.repeat(64),requests=[];
  const worker=automaticWorker({token:old,native:async()=>({ok:true,version:1,token:fresh}),request:async(url,options)=>{
    requests.push({path:new URL(url).pathname,method:options.method});
    if(options.headers.Authorization===`Bearer ${old}`)throw Error('service stopped');
    if(options.method==='POST')return {ok:true,status:202,json:async()=>({id:'job-restarted'})};
    return healthResponse();
  }});
  worker.context.chrome.storage.session={get:async()=>({}),set:async()=>{},remove:async()=>{}};
  worker.context.chrome.tabs.sendMessage=async()=>({ok:true,data:true});
  const sender={url:'https://www.coursera.org/learn/demo/quiz/q/title'};
  await worker.context.handleTab({action:'start',data:{url:sender.url,questions:[],documentNonce:'test'}},sender,7,'a'.repeat(36));
  assert.equal(worker.calls(),1);
  assert.equal(requests[0].path,'/health');assert.equal(requests[0].method,'GET');
  assert.equal(requests.filter(request=>request.method==='POST').length,1);
});

test('pre-job host-declared and health failures are unavailable work, with no POST',async()=>{
  for(const mode of ['host','health']){
    let posts=0;
    const worker=automaticWorker({native:async()=>mode==='host'?{ok:false,error:'Codex login unavailable'}:{ok:true,version:1,token:'d'.repeat(64)},request:async(url,options)=>{if(options.method==='POST')posts++;throw Error('health disconnected');}});
    worker.context.chrome.storage.session={get:async()=>({}),remove:async()=>{}};
    const sender={url:'https://www.coursera.org/learn/demo/quiz/q/title'};
    await assert.rejects(worker.context.handleTab({action:'start',data:{url:sender.url,questions:[]}},sender,7,'a'.repeat(36)),error=>error.code==='BRIDGE_UNAVAILABLE');
    assert.equal(posts,0);
  }
});

test('Stop or replaced document during preflight prevents creating a model job',async()=>{
  let announce,release,active=true,posts=0;
  const started=new Promise(resolve=>announce=resolve),health=new Promise(resolve=>release=resolve);
  const worker=automaticWorker({token:'b'.repeat(64),request:async(url,options)=>{if(options.method==='POST'){posts++;return {ok:true,json:async()=>({id:'unexpected'})};}announce();await health;return healthResponse();}});
  worker.context.chrome.storage.session={get:async()=>({}),set:async()=>{},remove:async()=>{}};
  worker.context.chrome.tabs.sendMessage=async()=>({ok:true,data:active});
  const sender={url:'https://www.coursera.org/learn/demo/quiz/q/title'};
  const starting=worker.context.handleTab({action:'start',data:{url:sender.url,questions:[]}},sender,7,'a'.repeat(36));
  await started;active=false;release();
  await assert.rejects(starting,/изменилась|отменено/);assert.equal(posts,0);
});
