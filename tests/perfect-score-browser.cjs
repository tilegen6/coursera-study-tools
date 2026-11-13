const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createBridge}=require('../bridge/server.cjs'),{extensionId}=require('../bridge/install-native.cjs');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'coursera-perfect-'));
const extension=path.join(temporary,'extension'),token='d'.repeat(64),events={},scores={already:100,optout:80,unknown:80,overlay:80,resume:80},visits=[];
let context,server,cooldown=0,solves=0,overlaySolves=0,resumeSolves=0,reloaded=false;
function fixture(url){
  const course=url.pathname.split('/')[2],base=`/learn/${course}/`,cover=base+'assignment-submission/q/review',report=event=>`fetch('/__event?name=${course}:${event}',{method:'POST'})`;
  const links=`<aside data-testid="left-nav"><a href="${cover}">Review</a><a href="${base}supplement/read/material">Reading</a><a href="${base}peer/p/project">Peer project</a></aside>`;
  if(url.pathname.includes('/supplement/'))return `<main><h1>Reading</h1>${events[course+':reading']?'<span data-testid="item-completed">Completed</span>':`<button onclick="${report('reading')};this.outerHTML='<span data-testid=&quot;item-completed&quot;>Completed</span>'">Mark as complete</button>`}</main>${links}`;
  const score=scores[course];
  const banner=score===undefined?'':`<div data-testid="result-banner"><h2>You passed!</h2><p>Pass with at least 75%.</p>${course==='unknown'?'<div data-test="question"><div data-testid="result-banner"><span data-testid="grade">100%</span></div></div>':`<span data-testid="grade">${score}%</span>`}<button data-testid="view-feedback-button" onclick="location.href='${cover}/view-feedback'">View feedback</button></div>`;
  const retake=course==='resume'?`<button data-testid="CoverPageActionButton" onclick="${report('resume')}.then(()=>location.href='${cover}/attempt')">Возобновить задание</button>`:`<button data-testid="CoverPageActionButton" ${course==='perfect'&&Date.now()<cooldown?'disabled':''} id="retake">Повторить попытку</button>`;
  const retakeScript=`<script>document.getElementById('retake').onclick=async()=>{if(document.querySelector('[data-testid="assignment-feedback-view"]'))return;await ${report('retake')};document.body.insertAdjacentHTML('beforeend','<div role="dialog"><h2>Другой диалог</h2><button id="unrelated-continue">Продолжить</button></div><div role="dialog"><h2>Начать новую попытку?</h2><button data-testid="StartAttemptModal__primary-button" id="confirm-retake">Продолжить</button></div>');document.getElementById('unrelated-continue').onclick=()=>{${report('unrelated-continue')};};document.getElementById('confirm-retake').onclick=async()=>{await ${report('confirm-retake')};location.href='${cover}/attempt';};};</script>`;
  if(url.pathname.endsWith('/view-feedback'))return `<main><h1>Quiz</h1><article data-testid="assignment-cover-redesign">${banner}${retake}</article><div data-testid="assignment-feedback-view"><button data-testid="tunnel-vision-back-button" onclick="${report('feedback-back')};location.href='${cover}'">Назад</button><div data-testid="part-Submission_GradedMultipleChoiceQuestion" role="group" aria-labelledby="feedback-prompt"><h3 id="feedback-prompt">Which side is blue?</h3><label><input type="radio" name="feedback" checked onchange="${report('feedback-change')}">Left</label><label><input type="radio" name="feedback" onchange="${report('feedback-change')}">Right</label><p>Wrong: Left was incorrect. The blue side is Right.</p></div></div></main>${links}${course==='resume'?'':retakeScript}`;
  if(url.pathname.endsWith('/attempt'))return `<main><h1>Quiz</h1>${banner}<form data-test="quiz-form"><fieldset><legend>Which side is blue?</legend><label><input type="radio" name="q">Left</label><label><input type="radio" name="q">Right</label></fieldset><label><input id="agreement-checkbox-base" type="checkbox">Honor code</label><button type="button" onclick="if(!document.getElementById('agreement-checkbox-base').checked)return;${report('submit')}.then(()=>location.href='${cover}')">Submit answers</button></form></main>${links}`;
  return `<main><h1>Quiz</h1><article data-testid="assignment-cover-redesign">${banner}${score===undefined?`<button data-testid="CoverPageActionButton" onclick="location.href='${cover}/attempt'">Начать задание</button>`:course==='resume'?`<button data-testid="CoverPageActionButton" onclick="${report('resume')}.then(()=>location.href='${cover}/attempt')">Возобновить задание</button>`:retake}</article></main>${links}${score===undefined||course==='resume'?'':retakeScript}`;
}
(async()=>{
 try{
  server=createBridge({token,solve:async quiz=>{assert.equal(quiz.questions[0].question,'Which side is blue?');if(quiz.url.includes('/resume/')){resumeSolves++;return {status:'solved',answers:[{id:1,choices:[2],text:''}]};}if(quiz.url.includes('/overlay/')){overlaySolves++;assert.match(quiz.feedback,/Wrong: Left was incorrect/);return {status:'solved',answers:[{id:1,choices:[2],text:''}]};}solves++;if(solves===2)assert.match(quiz.feedback,/Wrong: Left was incorrect/);return {status:'solved',answers:[{id:1,choices:[solves===1?1:2],text:''}]};}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  fs.cpSync(path.join(root,'extension'),extension,{recursive:true});const worker=path.join(extension,'background.js');fs.writeFileSync(worker,fs.readFileSync(worker,'utf8').replace('http://127.0.0.1:43179',`http://127.0.0.1:${server.address().port}`));
  context=await chromium.launchPersistentContext(path.join(temporary,'browser'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  await context.route('https://www.coursera.org/**',route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/__event'){const name=url.searchParams.get('name');events[name]=(events[name]||0)+1;if(name==='perfect:submit'){scores.perfect=events[name]===1?80:100;if(events[name]===1)cooldown=Date.now()+5000;}if(name==='overlay:submit')scores.overlay=100;if(name==='resume:submit')scores.resume=100;return route.fulfill({body:'{}'});}
   visits.push(url.pathname);return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8">'+fixture(url)});
  });
  const page=await context.newPage(),popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId(extension)}/popup.html`);await popup.evaluate(token=>chrome.storage.local.set({bridgeToken:token}),token);
  async function open(url){await page.goto(url,{waitUntil:'domcontentloaded'});await page.locator('#coursera-study-launcher').waitFor({state:'attached'});}
  async function command(action,data={}){return popup.evaluate(async({action,data})=>{for(const tab of await chrome.tabs.query({}))try{const status=await chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action:'status'});if(status?.ok)return await chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action,data});}catch{}},{action,data});}
  async function waitState(predicate,timeout=20000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const response=await command('status');if(response?.ok&&predicate(response.data))return response.data;await page.waitForTimeout(100);}throw Error(JSON.stringify(await command('status')));}
  await popup.evaluate(async()=>{
    const scope='https://www.coursera.org/learn/overlay/',key=scope+'assignment-submission/q',url=key+'/review/view-feedback';
    await chrome.storage.local.set({['checkpoint:'+scope]:{scope,accountHint:'',progress:{item:key,phase:'waiting',visited:[],pages:[],inventory:[],feedbackRetakeRecoveryVersion:1,submitted:[{item:key,attempt:0,at:Date.now()-60000,confirmed:true}],attempts:{},retakePending:{[key]:{item:key,before:0,at:Date.now()-60000,confirmed:false}},queue:[{key,url,status:'needs_input',reason:'Новая попытка не открылась. Повторное нажатие заблокировано, чтобы не расходовать попытки вслепую.'}]}}});
  });
  await open('https://www.coursera.org/learn/overlay/assignment-submission/q/review/view-feedback');
  assert.equal((await command('quizExport')).ok,false,'feedback controls must never be exported, even before their disabled state is hydrated');
  await command('courseStart',{speed:2,target100:true,autoHonorCode:true,resumeQueue:true});
  await waitState(s=>scores.overlay===100&&s.course.phase==='completed',10000);
  assert.equal(events['overlay:feedback-back'],1);assert.equal(events['overlay:retake'],1);assert.equal(events['overlay:submit'],1);assert.equal(overlaySolves,1);
  assert.equal(events['overlay:confirm-retake'],1);assert.equal(events['overlay:unrelated-continue']||0,0);
  assert.equal(events['overlay:feedback-change']||0,0);
  await popup.evaluate(async()=>{
    const scope='https://www.coursera.org/learn/resume/',key=scope+'assignment-submission/q';
    await chrome.storage.local.set({['checkpoint:'+scope]:{scope,accountHint:'',progress:{item:key,phase:'waiting',visited:[],pages:[],inventory:[],submitted:[{item:key,attempt:0,at:Date.now()-60000,confirmed:true}],attempts:{[key]:1},queue:[]}}});
  });
  await open('https://www.coursera.org/learn/resume/assignment-submission/q/review/view-feedback');await command('courseStart',{speed:2,target100:true,autoHonorCode:true,resumeQueue:true});
  await waitState(s=>scores.resume===100&&s.course.phase==='completed',10000);
  assert.equal(events['resume:feedback-back'],1);assert.equal(events['resume:resume'],1);assert.equal(events['resume:retake']||0,0);assert.equal(events['resume:confirm-retake']||0,0);assert.equal(events['resume:submit'],1);assert.equal(resumeSolves,1);
  await open('https://www.coursera.org/learn/perfect/assignment-submission/q/review');assert.equal((await command('courseStart',{speed:2,target100:true,autoHonorCode:true,resumeQueue:true})).ok,true);
  await waitState(state=>{if(scores.perfect===80&&state.course.phase==='completed')throw Error('The runner accepted 80% instead of retaking');return scores.perfect===80&&state.course.pending===1&&events['perfect:reading']===1;});
  assert.equal(events['perfect:retake']||0,0,'a cooldown must not consume a retake');await page.reload();reloaded=true;
  const state=await waitState(s=>scores.perfect===100&&s.course.phase==='completed',95000);
  assert.equal(events['perfect:submit'],2);assert.equal(events['perfect:retake'],1);assert.equal(events['perfect:confirm-retake'],1);assert.equal(solves,2);assert(reloaded);assert.equal(state.course.needsInput,0);assert(!visits.some(url=>url.includes('/peer/')));
  const journal=await popup.evaluate(async()=>Object.entries(await chrome.storage.local.get(null)).find(([key])=>key.startsWith('checkpoint:https://www.coursera.org/learn/perfect/'))?.[1]?.progress.submitted);
  assert.equal(journal.length,2);assert.deepEqual(journal.map(entry=>entry.attempt),[0,1]);
  for(const course of ['already','optout','unknown']){
   await open(`https://www.coursera.org/learn/${course}/assignment-submission/q/review`);await command('courseStart',{speed:2,target100:course!=='optout',autoHonorCode:true});
   await waitState(s=>course==='unknown'?s.course.phase==='waiting'&&s.course.pending===1&&s.course.needsInput===0&&events[course+':reading']===1:s.course.phase==='completed',course==='unknown'?30000:20000);
   assert.equal(events[course+':retake']||0,0);assert.equal(events[course+':submit']||0,0);await command('stop');
  }
  assert.equal(solves,2);console.log('PERFECT_SCORE_BROWSER_PASSED (feedback closed, scoped Continue once, unrelated Continue untouched, legacy intent recovered, cooldown, materials, reload, journal generations, one Start, 100% stop, opt-out, unknown grade)');
 }finally{if(context)await context.close();if(server)await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(temporary),fs.realpathSync(os.tmpdir()));fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
