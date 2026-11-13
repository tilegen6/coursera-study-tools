const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createBridge}=require('../bridge/server.cjs');
const {extensionId}=require('../bridge/install-native.cjs');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'coursera-skipped-'));
const extension=path.join(temporary,'extension'),token='9'.repeat(64),events={},passed=new Set();
let context,server,solves=0;
function fixture(url){
  const course=url.pathname.split('/')[2],base=`/learn/${course}/`,quiz=base+'assignment-submission/test/assessment/attempt',reading=base+'supplement/read/material';
  const report=event=>`fetch('/__event?name=${course}:${event}',{method:'POST'})`;
  if(course==='unknown')return `<main><h1 data-testid="course-completed">Course completed</h1></main><aside data-testid="left-nav"><a href="${base}interactive/dialog/conversation">Нестандартное задание</a></aside>`;
  if(url.pathname.includes('/home/'))return '<main><h1 data-testid="course-completed">Course completed</h1></main>';
  if(url.pathname.includes('/lecture/'))return `<main><h1>Completed video</h1><span data-testid="item-completed">Completed</span><a href="${base}home/completed">Next lesson</a></main><aside data-testid="left-nav"><div id="one"><a href="${url.pathname}"><span data-testid="learn-item-success-icon">Completed</span>Video</a><a href="${reading}">Reading material</a></div><button id="module2" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');setTimeout(()=>{document.getElementById('one').hidden=true;document.getElementById('two').hidden=false;},2750)"><span data-testid="module-number-heading">Module 2</span></button><div id="two" hidden><a href="${quiz}">Assessment</a></div><button id="module3" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.getElementById('two').hidden=true;document.getElementById('three').hidden=false"><span data-testid="module-number-heading">Module 3</span></button><div id="three" hidden><a href="${reading}">Reading material</a></div></aside>`;
  if(url.pathname.includes('/supplement/'))return `<main><h1>Reading material</h1><button onclick="${report('reading')};this.outerHTML='<button disabled>Completed</button>'">Mark as complete</button><a href="${base}home/completed">Next lesson</a></main>`;
  if(passed.has(course))return `<main><h2>You passed!</h2><a href="${base}home/completed">Next lesson</a></main>`;
  const agreement=course.startsWith('agreement');
  return `<div id="main-container"><h1>Assessment</h1><a href="${reading}">Reading material</a></div><div role="dialog"><h1>Assessment</h1><div id="q">Which value is even?</div><div role="radiogroup" aria-labelledby="q"><label><input type="radio" name="q">Three</label><label><input type="radio" name="q">Four</label></div>${agreement?`<fieldset><legend>Personal confirmation</legend><label><input id="agreement-checkbox-base" type="checkbox" ${course==='agreement-hidden'?'style="display:none"':''}>I certify this submission</label></fieldset>`:''}<button id="submit" ${agreement?'disabled':''}>Отправить</button></div><script>${agreement?`document.getElementById('agreement-checkbox-base').onchange=e=>document.getElementById('submit').disabled=!e.target.checked;`:''}document.getElementById('submit').onclick=async()=>{await ${report('submit')};document.body.innerHTML='<main><h2>You passed!</h2><a href="${base}home/completed">Next lesson</a></main>';};</script>`;
}
(async()=>{
  try{
    server=createBridge({token,solve:async task=>{solves++;assert.equal(task.questions.length,1);assert.equal(task.questions[0].question,'Which value is even?');return {status:'solved',answers:[{id:1,choices:[2],text:''}]};}});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    fs.cpSync(path.join(root,'extension'),extension,{recursive:true});
    const background=path.join(extension,'background.js');fs.writeFileSync(background,fs.readFileSync(background,'utf8').replace('http://127.0.0.1:43179',`http://127.0.0.1:${server.address().port}`));
    context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    await context.route('https://www.coursera.org/**',route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/__event'){const key=url.searchParams.get('name');events[key]=(events[key]||0)+1;if(key.endsWith(':submit'))passed.add(key.split(':')[0]);return route.fulfill({body:'{}'});}
      return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8">'+fixture(url)});
    });
    const page=await context.newPage(),popup=await context.newPage();
    await popup.goto(`chrome-extension://${extensionId(extension)}/popup.html`);await popup.evaluate(token=>chrome.storage.local.set({bridgeToken:token}),token);
    async function command(action){return popup.evaluate(async action=>{for(const tab of await chrome.tabs.query({}))try{const status=await chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action:'status'});if(status?.ok)return await chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action,data:{speed:2,skipVideo:true}});}catch{}},action);}
    async function waitStatus(predicate){await page.waitForTimeout(100);for(let i=0;i<160;i++){const response=await command('status');if(response?.ok&&predicate(response.data))return response.data;await page.waitForTimeout(100);}throw new Error('Unexpected status: '+JSON.stringify(await command('status')));}
    await page.goto('https://www.coursera.org/learn/chain/lecture/video/title');assert.equal((await command('courseStart')).ok,true);
    await waitStatus(state=>state.course.phase==='completed');
    assert.equal(events['chain:reading'],1);assert.equal(events['chain:submit'],1);
    // Structural fixture from the real 2026-10-26 attempt; the agreement is not a quiz question.
    for(const course of ['agreement','agreement-hidden']){
    const previousSolves=solves;
    await page.goto(`https://www.coursera.org/learn/${course}/assignment-submission/test/assessment/attempt`);
    assert.equal((await command('quizExport')).data.questions.length,1);
    assert.equal((await command('courseStart')).ok,true);
    let state=await waitStatus(state=>state.course.phase==='waiting'&&state.course.needsInput===1&&page.url().includes('/home/'));
    assert.equal(events[`${course}:submit`]||0,0);assert.equal(events[`${course}:reading`],1);assert.equal(solves,previousSolves);
    assert.equal(state.course.queue[0].title,'Assessment');assert.match(state.course.queue[0].reason,/подтверждение/);
    await page.goto(`https://www.coursera.org/learn/${course}/assignment-submission/test/assessment/attempt`);
    await page.waitForTimeout(500);assert.equal(await page.locator('#agreement-checkbox-base').isChecked(),false);
    // This represents the learner's own action, never a click issued by the extension.
    await page.locator('label:has(#agreement-checkbox-base)').click();
    await waitStatus(state=>state.course.phase==='completed');assert.equal(events[`${course}:submit`],1);assert.equal(solves,previousSolves+1);
    }
    await page.goto('https://www.coursera.org/learn/unknown/home/completed');assert.equal((await command('courseStart')).ok,true);
    const state=await waitStatus(state=>state.course.needsInput===1);assert.notEqual(state.course.phase,'completed');
    assert.equal(state.course.queue[0].title,'Нестандартное задание');assert.match(state.course.queue[0].url,/\/interactive\/dialog\//);
    await page.bringToFront();await popup.locator('#refresh').click();await popup.waitForFunction(()=>document.getElementById('queue-items').textContent.includes('Нестандартное задание'),null,{timeout:6000}).catch(async error=>{console.error('QUEUE_DEBUG',await popup.locator('body').innerText(),JSON.stringify(await command('status')));throw error;});
    assert.equal(await popup.locator('#queue-items a').getAttribute('href'),'https://www.coursera.org/learn/unknown/interactive/dialog/conversation');
    assert.equal(await popup.locator('#queue-items').evaluate(element=>element.closest('details').open),true);
    await page.reload();await waitStatus(state=>state.course.needsInput===1);await command('stop');
    console.log('SKIPPED_ASSIGNMENTS_PASSED (collapsed module inventory, reading and quiz after videos, personal agreement pause/resume, named unsupported task)');
  }finally{
    if(context)await context.close();if(server)await new Promise(resolve=>server.close(resolve));
    assert.equal(path.dirname(temporary),fs.realpathSync(os.tmpdir()));assert(path.basename(temporary).startsWith('coursera-skipped-'));fs.rmSync(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
