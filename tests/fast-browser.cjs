const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {extensionId}=require('../bridge/install-native.cjs');
const root=path.resolve(__dirname,'..'),extension=path.join(root,'extension');
const temporary=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'coursera-fast-'));
const state=new Map();let browser,child;
const wav=Buffer.alloc(44+16000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(16000,40);
const media='data:audio/wav;base64,'+wav.toString('base64');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function data(name){if(!state.has(name))state.set(name,{done:new Set(),posts:0,live:0,peak:0,loads:0,ended:0,restored:false});return state.get(name);}
function fixture(name,pathname){
  const record=data(name),base=`https://www.coursera.org/learn/${name}/`;
  if(pathname.includes('/home/'))return '<main><h1 data-testid="course-completed">Course completed</h1></main>';
  record.loads++;
  const ids=['fallback','spa'].includes(name)?['v0']:Array.from({length:16},(_,i)=>'v'+i);
  const anchor=id=>`<a href="${base}lecture/${id}/title">${id}${record.done.has(id)||name==='unconfirmed'?`<svg ${name==='unconfirmed'?'style="display:none"':''} width="15" height="15" data-testid="learn-item-success-icon"></svg>`:''}</a>`;
  let nav=ids.map(anchor).join('');
  if(name==='batch'){
    const second=ids.slice(8).map(anchor).join('');
    nav=`<button id="m1" aria-expanded="true" aria-controls="p1"><span data-testid="module-number-heading">Module1</span></button><div id="p1">${ids.slice(0,8).map(anchor).join('')}</div><button id="m2" aria-expanded="false" aria-controls="p2"><span data-testid="module-number-heading">Module2</span></button><div id="p2" hidden></div><script>function openModule(n){for(const i of [1,2]){document.getElementById('m'+i).setAttribute('aria-expanded',String(i===n));document.getElementById('p'+i).hidden=i!==n;}if(n===2&&!document.getElementById('p2').children.length)setTimeout(()=>document.getElementById('p2').innerHTML=${JSON.stringify(second)},80);}document.getElementById('m1').onclick=()=>openModule(1);document.getElementById('m2').onclick=()=>openModule(2);</script>`;
  }
  if(['fallback','spa'].includes(name))nav=`<a href="${base}lecture/v0/title">v0<span id="status"></span></a>`;
  const player=`<video src="${media}" controls style="width:400px;height:200px"></video>`;
  const wire=`const v=document.querySelector('video');v.onended=async()=>{await fetch('/__ended?course=${name}',{method:'POST'});document.getElementById('status').innerHTML='<svg width="15" height="15" data-testid="learn-item-success-icon"></svg>';await fetch('/__audio?course=${name}&restored='+(!v.muted));};`;
  if(name==='spa'&&pathname.includes('/supplement/')){
    const next=`<h1>New reading</h1><button id="mark">Mark as complete</button><a href="${base}home/completed">Next lesson</a>`;
    return `<aside data-testid="left-nav">${nav}</aside><main id="main"><h1>First reading</h1><h3>Completed</h3><button id="next">Next lesson</button></main><script>document.getElementById('next').onclick=()=>{history.pushState({},'',${JSON.stringify(base+'supplement/second/title')});document.body.append(document.createElement('span'));setTimeout(()=>{document.getElementById('main').innerHTML=${JSON.stringify(next)};document.getElementById('mark').onclick=async event=>{await fetch('/__reading',{method:'POST'});event.target.outerHTML='<h3>Completed</h3>';};},80);};</script>`;
  }
  const video=name==='fallback'?`${player}<script>${wire}</script>`:'';
  return `<aside data-testid="left-nav">${nav}</aside><a href="${base}home/completed">Course home</a><main><h1>Video lesson</h1>${name==='batch'?'<input type="range" aria-label="Volume">':''}${video}<a href="${base}lecture/${ids[1]||'v0'}/title">Next lesson</a></main>`;
}
(async()=>{
  try{
    // A fresh fixture-only browser; never attach to the user's Chrome/profile.
    // noDefaults avoids Playwright's foreground emulation; no throttle/autoplay overrides.
    child=spawn(chromium.executablePath(),['--headless=new','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${temporary}`,`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-first-run','about:blank'],{windowsHide:true,stdio:'ignore'});
    const devtools=path.join(temporary,'DevToolsActivePort');
    for(let i=0;i<200&&!fs.existsSync(devtools);i++)await sleep(25);
    const port=Number(fs.readFileSync(devtools,'utf8').split('\n')[0]);assert(Number.isInteger(port)&&port>1024&&port<65536);
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{noDefaults:true});
    const context=browser.contexts()[0];
    context.on('page',page=>page.on('pageerror',error=>console.error('PAGE_ERROR',error.message)));
    await context.route('https://www.coursera.org/**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/api/adminUserPermissions.v1')return route.fulfill({contentType:'application/json',body:JSON.stringify({elements:[{id:'123'}]})});
      const event=url.pathname.match(/^\/api\/opencourse\.v1\/user\/123\/course\/([^/]+)\/item\/(v\d+)\/lecture\/videoEvents\/ended$/);
      if(event){
        const [,name,id]=event,record=data(name);record.posts++;record.live++;record.peak=Math.max(record.peak,record.live);
        assert.equal(route.request().method(),'POST');assert.deepEqual(route.request().postDataJSON(),{contentRequestBody:{}});
        assert.equal(url.searchParams.get('autoEnroll'),'false');
        await sleep(100);record.live--;
        if(name==='batch')record.done.add(id);
        return route.fulfill({status:['denied','fallback','spa'].includes(name)?404:200,contentType:'application/json',body:'{}'}).catch(()=>{});
      }
      if(url.pathname==='/__ended'){const record=data(url.searchParams.get('course'));record.ended++;record.done.add('v0');return route.fulfill({body:'{}'});}
      if(url.pathname==='/__audio'){data(url.searchParams.get('course')).restored=url.searchParams.get('restored')==='true';return route.fulfill({body:'{}'});}
      if(url.pathname==='/__reading'){data('spa').ended++;return route.fulfill({body:'{}'});}
      const name=url.pathname.match(/^\/learn\/([^/]+)/)?.[1];
      return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html>'+(name?fixture(name,url.pathname):'<h1>Other tab</h1>')});
    });
    const workerURL=`chrome-extension://${extensionId(extension)}/background.js`;
    const worker=context.serviceWorkers().find(worker=>worker.url()===workerURL)||await context.waitForEvent('serviceworker',{predicate:worker=>worker.url()===workerURL});
    const send=(tabId,action)=>worker.evaluate(({tabId,action})=>chrome.tabs.sendMessage(tabId,{source:'coursera-study-tools',action}),{tabId,action});
    async function waitStatus(tabId,predicate){let last;for(let i=0;i<100;i++){try{const response=await send(tabId,'status');last=response;if(response?.ok&&predicate(response.data))return response.data;}catch(error){last={error:error.message};}await sleep(25);}throw Error('Course status did not settle: '+JSON.stringify(last));}
    async function start(name){
      const popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId(extension)}/popup.html`);
      const opened=context.waitForEvent('page');const tab=await popup.evaluate(()=>chrome.tabs.create({url:'about:blank',active:true}));
      const page=await opened;await page.goto(`https://www.coursera.org/learn/${name}/${name==='spa'?'supplement/first/title':'lecture/v0/title'}`);
      assert.equal(await page.locator('h1').innerText(),name==='spa'?'First reading':'Video lesson','route fixture must be installed before starting');
      await popup.evaluate(()=>document.getElementById('refresh').click());
      await popup.waitForFunction(()=>!document.getElementById('run-course').disabled);
      const started=performance.now();await popup.evaluate(()=>document.getElementById('run-course').click());
      const foregroundOpened=context.waitForEvent('page');await popup.evaluate(()=>chrome.tabs.create({url:'about:blank',active:true}));const foreground=await foregroundOpened;await foreground.waitForLoadState();
      await popup.close();assert.equal(await page.evaluate(()=>document.hidden),true,'course must genuinely be hidden');
      return {page,foreground,tabId:tab.id,started};
    }
    const batch=await start('batch');
    await batch.page.waitForURL('**/home/completed',{timeout:7000}).catch(async error=>{console.error('FAST_DEBUG',JSON.stringify({url:batch.page.url(),records:[...state].map(([name,value])=>({name,...value,done:[...value.done]})),status:await send(batch.tabId,'status').catch(problem=>({error:problem.message})),body:await batch.page.locator('body').innerText()}));throw error;});
    const elapsed=Math.round(performance.now()-batch.started);
    assert.equal(data('batch').done.size,16);assert.equal(data('batch').posts,16);assert(data('batch').peak>1&&data('batch').peak<=8);
    assert.equal(data('batch').loads,2,'batch needs one fresh-page verification, not one page per video');
    assert.equal((await waitStatus(batch.tabId,status=>status.course.phase==='completed')).course.count,16);
    assert.equal(await batch.page.evaluate(()=>document.hidden),true);
    await batch.page.close();await batch.foreground.close();
    for(const name of ['unconfirmed','denied']){
      const attempt=await start(name);await sleep(1600);
      const status=(await send(attempt.tabId,'status')).data;
      assert.equal(status.course.count,0);assert.equal(status.courseRunning,true);assert.notEqual(status.course.phase,'completed');
      assert.equal(data(name).done.size,0);assert(data(name).posts>0);
      await send(attempt.tabId,'stop');await attempt.page.close();await attempt.foreground.close();
    }
    const fallback=await start('fallback');
    await sleep(1500);
    const fallbackStatus=await waitStatus(fallback.tabId,status=>!!status.course);
    if(fallbackStatus.course.phase==='completed')assert.equal(data('fallback').ended,1);
    else {assert.equal(fallbackStatus.course.count,0);assert.equal(data('fallback').done.size,0);await send(fallback.tabId,'stop');assert.equal(await fallback.page.locator('video').evaluate(video=>video.muted),false);}
    assert.equal(await fallback.page.evaluate(()=>document.hidden),true);
    await fallback.page.close();await fallback.foreground.close();
    const spa=await start('spa');await spa.page.waitForURL('**/home/completed',{timeout:12000});
    assert.equal((await waitStatus(spa.tabId,status=>status.course.phase==='completed')).course.count,2);
    assert.equal(data('spa').ended,1);
    fs.mkdirSync(path.join(root,'output'),{recursive:true});
    fs.writeFileSync(path.join(root,'output/fast-video-evidence.json'),JSON.stringify({version:JSON.parse(fs.readFileSync(path.join(extension,'manifest.json'),'utf8')).version,fixture:true,lectures:16,elapsedMs:elapsed,hidden:true,popupClosed:true,checkedAt:new Date().toISOString()},null,2));
    console.log(`FAST_BROWSER_PASSED (16 videos, ${elapsed}ms fixture time, genuinely hidden, popup closed, delayed modules, fresh site proof, rejected/hidden-icon controls, native playback policy, delayed SPA)`);
  }finally{
    if(browser)await browser.close();if(child)child.kill();
    assert.equal(path.dirname(temporary),fs.realpathSync(os.tmpdir()));assert(path.basename(temporary).startsWith('coursera-fast-'));fs.rmSync(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
