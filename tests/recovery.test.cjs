const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const recovery=require('../extension/recovery.js');
const intent=()=>({version:1,action:'courseStart',tabId:7,url:'https://www.coursera.org/learn/demo/supplement/a/title',documentId:'same-document',profile:'user-a',createdAt:Date.now(),settings:{speed:2,skipVideo:true,autoNext:true,resumeQueue:false}});
test('recovery intent is short lived and limited to a known action, course document and bounded settings',()=>{
  const good=intent();assert.equal(recovery.validIntent(good),true);
  for(const patch of [{action:'exec'},{url:'https://evil.test/learn/demo/'},{documentId:''},{createdAt:Date.now()-61000},{createdAt:Date.now()+10000},{settings:{...good.settings,speed:100}},{settings:{speed:2}}])assert.equal(recovery.validIntent({...good,...patch}),false);
});
test('recovery consumes intent but never starts a changed document or account',async()=>{
  for(const change of [{documentId:'different-document',profile:'user-a'},{documentId:'same-document',profile:'user-b'}]){
    const pending=intent(),local={[recovery.pendingKey]:pending};let starts=0,native=0;
    const context={CourseraRecovery:recovery,AbortSignal,URL,chrome:{
      storage:{local:{setAccessLevel:async()=>{},get:async()=>({...local}),set:async data=>Object.assign(local,data),remove:async key=>delete local[key]}},
      runtime:{id:'a'.repeat(32),getManifest:()=>({permissions:['nativeMessaging']}),getURL:file=>'chrome-extension://'+'a'.repeat(32)+'/'+file,sendNativeMessage:async()=>{native++;throw Error('Unexpected native connect');},onMessage:{addListener:()=>{}}},
      scripting:{executeScript:async()=>[{documentId:change.documentId,result:{url:pending.url,profile:change.profile}}]},
      tabs:{sendMessage:async()=>{starts++;return {ok:true};},onRemoved:{addListener:()=>{}},onUpdated:{addListener:()=>{}}}
    }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),context);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(starts,0);assert.equal(native,0);assert.equal(local[recovery.pendingKey],undefined);assert.match(local.recoveryError,/изменились/);
  }
});

test('recovered course starts its exact document without opening the native connection',async()=>{
  const pending=intent(),local={[recovery.pendingKey]:pending},id='a'.repeat(32);let starts=0,native=0;
  const context={CourseraRecovery:recovery,AbortSignal,URL,chrome:{
    storage:{local:{setAccessLevel:async()=>{},get:async()=>({...local}),set:async data=>Object.assign(local,data),remove:async key=>delete local[key]}},
    runtime:{id,getManifest:()=>({permissions:['nativeMessaging']}),getURL:file=>`chrome-extension://${id}/${file}`,sendNativeMessage:async()=>{native++;throw Error('Specified native messaging host not found.');},onMessage:{addListener:()=>{}}},
    scripting:{executeScript:async()=>[{documentId:pending.documentId,result:{url:pending.url,profile:pending.profile}}]},
    tabs:{sendMessage:async(tabId,request,options)=>{assert.equal(tabId,pending.tabId);assert.equal(options.documentId,pending.documentId);if(request.action==='courseStart'){starts++;assert.equal(request.data.recoveryGuard.url,pending.url);}return {ok:true};},onRemoved:{addListener:()=>{}},onUpdated:{addListener:()=>{}}}
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(starts,1);assert.equal(native,0);assert.equal(local.recoveryError,undefined);assert.equal(local[recovery.pendingKey],undefined);
});

test('idle tab cannot reload while another extension course, model or material run is active',async()=>{
  const oldChrome=global.chrome,oldFetch=global.fetch;
  try{
    for(const kind of ['course','solver','materials']){
      let writes=0,reloads=0;
      global.chrome={runtime:{getManifest:()=>({name:'Coursera Study Tools',version:'1.4.0',permissions:['nativeMessaging']}),sendNativeMessage:()=>{},getURL:file=>'chrome-extension://'+'a'.repeat(32)+'/'+file,reload:()=>reloads++},storage:{session:{get:async()=>kind==='materials'?{}:{[kind+':8']:{id:'active'}}},local:{set:async()=>writes++}},tabs:{query:async()=>[{id:7},{id:8}],sendMessage:async id=>({ok:true,data:{running:kind==='materials'&&id===8}})}};
      global.fetch=async()=>({json:async()=>({name:'Coursera Study Tools',version:recovery.VERSION,permissions:['nativeMessaging']})});
      await assert.rejects(recovery.prepare(7,intent().settings),/активные сеансы/);assert.equal(reloads,0);assert.equal(writes,0);
    }
  }finally{global.chrome=oldChrome;global.fetch=oldFetch;}
});

test('missing permission without a complete installed update is diagnosed without reloading',async()=>{
  const oldChrome=global.chrome,oldFetch=global.fetch;let reloads=0;const local={};
  try{
    global.chrome={runtime:{id:'a'.repeat(32),getManifest:()=>({name:'Coursera Study Tools',version:'1.3.2',permissions:['storage']}),getURL:file=>'chrome-extension://'+'a'.repeat(32)+'/'+file,reload:()=>reloads++},storage:{local:{set:async data=>Object.assign(local,data)}}};
    global.fetch=async()=>({json:async()=>({name:'Coursera Study Tools',version:recovery.VERSION,permissions:['storage']})});
    await assert.rejects(recovery.prepare(7,intent().settings),/полного обновления/);
    assert.equal(reloads,0);assert.equal(local.pendingCourseRecovery,undefined);assert.equal(local.connectionDiagnostics.nativePermission,false);
  }finally{global.chrome=oldChrome;global.fetch=oldFetch;}
});

test('navigation, account switch or Stop during explicit native connection cancels recovery',async()=>{
  for(const mode of ['document','profile','stop']){
    const pending={...intent(),action:'connect'},local={[recovery.pendingKey]:pending},id='a'.repeat(32);
    let documentId=pending.documentId,profile=pending.profile,starts=0,resolveNative,announceNative;
    const started=new Promise(resolve=>announceNative=resolve);
    const context={CourseraRecovery:recovery,AbortSignal,URL,fetch:async()=>({ok:true,json:async()=>({ready:true,provider:'codex-chatgpt'})}),chrome:{
      storage:{local:{setAccessLevel:async()=>{},get:async()=>({...local}),set:async data=>Object.assign(local,data),remove:async keys=>{for(const key of [].concat(keys))delete local[key];}}},
      runtime:{id,getManifest:()=>({permissions:['nativeMessaging']}),getURL:file=>`chrome-extension://${id}/${file}`,sendNativeMessage:async()=>{announceNative();return new Promise(resolve=>resolveNative=resolve);},onMessage:{addListener:()=>{}}},
      scripting:{executeScript:async options=>{assert.deepEqual(Array.from(options.target.documentIds),[pending.documentId]);return [{documentId,result:{url:pending.url,profile}}];}},
      tabs:{sendMessage:async()=>{starts++;return {ok:true};},onRemoved:{addListener:()=>{}},onUpdated:{addListener:()=>{}}}
    }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),context);
    await started;
    if(mode==='document')documentId='new-document';
    else if(mode==='profile')profile='user-b';
    else await context.handle({action:'cancelRecovery'},{url:`chrome-extension://${id}/popup.html`});
    resolveNative({ok:true,version:1,token:'d'.repeat(64)});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(starts,0);assert.match(local.recoveryError,/отменён|остановлен/);
  }
});
