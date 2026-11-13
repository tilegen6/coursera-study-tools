const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createBridge}=require('../bridge/server.cjs');
const {extensionId}=require('../bridge/install-native.cjs');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'coursera-quiz-only-'));
const extension=path.join(temporary,'extension'),token='b'.repeat(64),events={},visits={},passed=new Set();
let context,server,solves=0;
function fixture(url){
  const course=url.pathname.split('/')[2],base=`/learn/${course}/`,quiz=base+'assignment-submission/test/assessment/attempt';
  const report=event=>`fetch('/__event?name=${course}:${event}',{method:'POST'})`;
  const links=`<aside data-testid="left-nav"><a href="${base}peer/p/project">Peer project</a><a href="${base}programming/p/project">Programming</a><a href="${base}lab/l/work">Lab</a><a href="${base}coach/c/dialogue">Coach</a><a href="${base}interactive/x/work">Other assignment</a><a href="${base}assignment-submission/essay/written">Written project</a><a href="${quiz}">Assessment</a><a href="${base}supplement/read/material">Reading</a></aside>`;
  if(url.pathname.includes('/home/'))return `<main><h1 data-testid="course-completed">Course completed</h1></main>${links}`;
  if(url.pathname.includes('/supplement/'))return `<main><h1>Reading</h1><button onclick="${report('reading')};this.outerHTML='<span data-testid=&quot;item-completed&quot;>Completed</span>'">Mark as complete</button></main>${links}`;
  if(url.pathname.includes('/essay/'))return `<main><h1>Written project</h1><article>Write an essay and upload your source.</article><label>Answer<textarea>Keep my text</textarea></label><label><input id="agreement-checkbox-base" type="checkbox" onchange="${report('written-agreement')}">Honor code</label><button onclick="${report('written-submit')}">Submit assignment</button></main>${links}`;
  if(!url.pathname.includes('/assignment-submission/'))return `<main><h1>Excluded assignment</h1><button onclick="${report('assignment-action')}">Start</button></main>${links}`;
  if(passed.has(course))return `<main><h1>Assessment</h1><div role="status" data-test="quiz-result" data-score="100">You passed!</div></main>${links}`;
  const checkbox=`<label><input id="agreement-checkbox-base" type="checkbox" ${course==='hidden'?'style="display:none"':''} onchange="${report('agreement')}">Coursera Honor Code</label>`;
  const late=course==='late'?`if(!document.getElementById('agreement-checkbox-base'))document.getElementById('submit').insertAdjacentHTML('beforebegin',${JSON.stringify(checkbox)});`:'';
  return `<main><h1>Assessment</h1><form data-test="quiz-form"><fieldset><legend>Which number is even?</legend><label><input type="radio" name="q" onchange='${late.replaceAll("'",'&#39;')}'>Three</label><label><input type="radio" name="q" onchange='${late.replaceAll("'",'&#39;')}'>Four</label></fieldset>${course==='late'?'':checkbox}${course==='name'?'<label>Full name<input data-testid="honor-code-legal-name-input" value="Keep my name"></label>':''}<label><input id="marketing" type="checkbox" onchange="${report('marketing')}">Send offers</label><button id="submit" type="button" onclick="if(!document.getElementById('agreement-checkbox-base')?.checked)return;${report('submit')};document.body.innerHTML='<main><h1>Assessment</h1><div role=&quot;status&quot; data-test=&quot;quiz-result&quot; data-score=&quot;100&quot;>You passed!</div></main>';">Submit answers</button></form></main>${links}`;
}
(async()=>{
  try{
    server=createBridge({token,solve:async task=>{solves++;assert.equal(task.kind,undefined,'only quiz jobs may reach the model');assert.equal(task.questions.length,1);return {status:'solved',answers:[{id:1,choices:[2],text:''}]};}});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    fs.cpSync(path.join(root,'extension'),extension,{recursive:true});
    const background=path.join(extension,'background.js');fs.writeFileSync(background,fs.readFileSync(background,'utf8').replace('http://127.0.0.1:43179',`http://127.0.0.1:${server.address().port}`));
    context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    await context.route('https://www.coursera.org/**',route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/__event'){const key=url.searchParams.get('name');events[key]=(events[key]||0)+1;if(key.endsWith(':submit'))passed.add(key.split(':')[0]);return route.fulfill({body:'{}'});}
      visits[url.pathname]=(visits[url.pathname]||0)+1;
      return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8">'+fixture(url)});
    });
    const page=await context.newPage(),popup=await context.newPage();
    await popup.goto(`chrome-extension://${extensionId(extension)}/popup.html`);
    await popup.evaluate(token=>chrome.storage.local.set({bridgeToken:token,fastCourseDefaults:true,settings:{speed:2,skipVideo:false}}),token);
    async function command(action,data={}){return popup.evaluate(async({action,data})=>{for(const tab of await chrome.tabs.query({}))try{const status=await chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action:'status'});if(status?.ok)return await chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action,data:{speed:2,...data}});}catch{}},{action,data});}
    async function waitStatus(predicate){for(let i=0;i<160;i++){const response=await command('status');if(response?.ok&&predicate(response.data))return response.data;await page.waitForTimeout(100);}throw new Error('Unexpected status: '+JSON.stringify(await command('status')));}
    await page.goto('https://www.coursera.org/learn/off/home/welcome');assert.equal((await command('courseStart')).ok,true);
    let state=await waitStatus(s=>s.course.phase==='waiting'&&s.course.needsInput===1&&events['off:reading']===1);
    assert.equal(events['off:agreement']||0,0);assert.equal(events['off:submit']||0,0);
    assert(state.course.skipped>=6);assert(state.course.queue.some(e=>e.status==='skipped'));
    await page.reload();await waitStatus(s=>s.course.phase==='waiting'&&s.course.skipped>=6);await command('stop');
    for(const course of ['on','hidden','late']){
      await page.goto(`https://www.coursera.org/learn/${course}/home/welcome`);
      assert.equal((await command('courseStart',{autoHonorCode:true})).ok,true);
      state=await waitStatus(s=>s.course.phase==='completed');
      assert.equal(events[`${course}:submit`],1);assert.equal(events[`${course}:agreement`],1);assert.equal(events[`${course}:marketing`]||0,0);
      assert.equal(events[`${course}:written-submit`]||0,0);assert.equal(events[`${course}:written-agreement`]||0,0);assert.equal(state.course.skipped,6);
      for(const type of ['peer','programming','lab','coach','interactive'])assert(!Object.keys(visits).some(p=>p.startsWith(`/learn/${course}/${type}/`)),`${type} must not be opened`);
    }
    await page.goto('https://www.coursera.org/learn/name/assignment-submission/test/assessment/attempt');
    await command('courseStart',{autoHonorCode:true});await waitStatus(s=>s.course.phase==='waiting'&&s.course.needsInput===1&&events['name:reading']===1);
    assert.equal(events['name:submit']||0,0);await command('stop');
    await page.bringToFront();await popup.locator('#refresh').click();await popup.locator('#auto-honor-code').check();
    await popup.waitForFunction(async()=>((await chrome.storage.local.get('settings')).settings.autoHonorCode===true));
    await popup.reload();assert.equal(await popup.locator('#auto-honor-code').isChecked(),true);
    assert.equal(await popup.locator('#target-100').isChecked(),true);await popup.locator('#target-100').uncheck();
    await popup.waitForFunction(async()=>((await chrome.storage.local.get('settings')).settings.target100===false));
    await popup.reload();assert.equal(await popup.locator('#target-100').isChecked(),false);await popup.locator('#target-100').check();
    await popup.waitForFunction(async()=>((await chrome.storage.local.get('settings')).settings.target100===true));
    await page.goto('https://www.coursera.org/learn/persisted/home/welcome');
    await page.locator('#coursera-study-launcher').getByRole('button',{name:'Запустить курс',exact:true}).click();
    await waitStatus(s=>s.course.phase==='completed');assert.equal(events['persisted:submit'],1);
    assert.equal(events['off:assignment-action']||0,0);assert.equal(solves,4);
    await page.bringToFront();await popup.locator('#refresh').click();await popup.setViewportSize({width:420,height:900});
    fs.mkdirSync(path.join(root,'output/playwright'),{recursive:true});
    for(const colorScheme of ['light','dark']){
      await popup.emulateMedia({colorScheme});
      await popup.screenshot({path:path.join(root,`output/playwright/quiz-only-settings-${colorScheme}.png`),fullPage:true});
    }
    console.log('QUIZ_ONLY_BROWSER_PASSED (assignment exclusion, checkbox opt-in/off/late/hidden, reload, name guard, persisted launcher setting)');
  }finally{
    if(context)await context.close();if(server)await new Promise(resolve=>server.close(resolve));
    assert.equal(path.dirname(temporary),fs.realpathSync(os.tmpdir()));assert(path.basename(temporary).startsWith('coursera-quiz-only-'));fs.rmSync(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
