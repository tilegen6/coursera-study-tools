const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createBridge}=require('../bridge/server.cjs'),{extensionId}=require('../bridge/install-native.cjs');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'coursera-review-recovery-'));
const extension=path.join(temporary,'extension'),scope='https://www.coursera.org/learn/object-oriented-design/',token='c'.repeat(64),events={},passed=new Set(),visits=[];
const items=[['r1','module-1-review','Обзор Модуля 1'],['piok8','module-3-review','Обзор модуля 3'],['mKILy','final-exam','Заключительный экзамен'],['changing','updated-review','Changing quiz']];
const urlFor=item=>scope+'assignment-submission/'+item[0]+'/'+item[1];
const image='https://d3c33hcgiwev3.cloudfront.net/imageAssetProxy.v1/fixture-diagram.png';
const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RUAAAAAASUVORK5CYII=','base64');
let context,server,page,attempts=0,changedAttempts=0,reloaded=false;
function fixture(url){
  const links=`<aside data-testid="left-nav">${items.map(item=>`<a href="${urlFor(item)}">${item[2]}</a>`).join('')}<a href="${scope}supplement/a/reading">Reading A</a><a href="${scope}supplement/b/reading">Reading B</a><a href="${scope}assignment-submission/written/essay">Written project</a><a href="${scope}peer/p/project">Peer project</a><a aria-disabled="true" href="${scope}supplement/locked/solution">Locked solution reading</a></aside>`;
  const id=url.pathname.split('/')[4],report=event=>`fetch('/__event?event=${event}',{method:'POST'})`;
  if(url.pathname.includes('/supplement/locked/'))return `<main><div>Чтобы разблокировать, выполните предыдущее задание</div><p>Чтобы открыть это задание после завершения предыдущего, обновите страницу.</p><button>Перейти к предыдущему заданию</button></main>${links}`;
  if(url.pathname.includes('/supplement/'))return `<main><h1>Reading ${id}</h1>${events['reading-'+id]?'<span data-testid="item-completed">Completed</span>':`<button onclick="${report('reading-'+id)};this.outerHTML='<span data-testid=&quot;item-completed&quot;>Completed</span>'">Mark as complete</button>`}</main>${links}`;
  if(id==='written')return `<main><article data-testid="assignment-cover-redesign"><h1>Written project</h1><label>Answer<textarea>Preserve my draft</textarea></label><button onclick="${report('written-submit')}">Submit assignment</button></article></main>${links}`;
  const item=items.find(item=>item[0]===id);if(!item)return `<main><h1 data-testid="course-completed">Course completed</h1></main>${links}`;
  if(passed.has(id))return `<main><h2>You passed!</h2></main>${links}`;
  if(!url.pathname.endsWith('/attempt')){
    const cover=`<main><article data-testid="assignment-cover-redesign"><h1>${item[2]}</h1><p>Оцениваемое задание</p><p>Попытки: 3 раз в 8 часов</p><button data-testid="CoverPageActionButton" onclick="location.href='${url.pathname}/attempt'">Начать задание</button></article></main>`;
    return id==='r1'?`<main><h1>Загрузка...</h1><form></form></main>${links}<script>setTimeout(()=>document.querySelector('main').outerHTML=${JSON.stringify(cover)},1000)</script>`:cover+links;
  }
  return `<main><h1>${item[2]}</h1><div data-testid="part-Submission_MultipleChoiceQuestion" role="group" aria-labelledby="legend"><div id="legend" data-testid="legend"><div id="prompt"><p>${id==='changing'&&changedAttempts?'Which updated side is blue?':'Which side is blue?'}</p><figure><img alt="Colour diagram" src="${image}"></figure></div></div><div role="radiogroup" aria-labelledby="prompt"><label><input type="radio" name="q">Left</label><label><input type="radio" name="q">Right</label></div></div><button onclick="${report('submit-'+id)};document.body.innerHTML=${JSON.stringify('<main><h2>You passed!</h2></main>'+links).replaceAll('"','&quot;')};history.pushState({},'','${url.pathname.replace('/attempt','')}');">Submit answers</button></main>${links}`;
}
(async()=>{
 try{
  server=createBridge({token,solve:async quiz=>{
    assert.equal(quiz.questions.length,1);assert.equal(quiz.questions[0].images[0].url,image);
    if(quiz.url.includes('/r1/'))await page.evaluate(()=>history.replaceState({},'',location.pathname.replace('/attempt','')));
    if(quiz.url.includes('/mKILy/')&&++attempts===1)throw Object.assign(Error('Temporary fixture failure'),{publicMessage:'Решатель временно недоступен.',status:503});
    if(quiz.url.includes('/changing/')&&++changedAttempts===1)await page.locator('#prompt').evaluate(element=>{element.closest('[data-testid="part-Submission_MultipleChoiceQuestion"]').outerHTML='<section data-testid="assignment-feedback-view"><fieldset><legend>Old feedback question</legend><label><input type="radio" name="feedback">Old answer</label></fieldset></section>';history.replaceState({},'',location.pathname.replace('/attempt','/view-feedback'));});
    return {status:'solved',answers:[{id:1,choices:[2],text:''}]};
  }});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  fs.cpSync(path.join(root,'extension'),extension,{recursive:true});const worker=path.join(extension,'background.js');fs.writeFileSync(worker,fs.readFileSync(worker,'utf8').replace('http://127.0.0.1:43179',`http://127.0.0.1:${server.address().port}`));
  context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  await context.route('https://d3c33hcgiwev3.cloudfront.net/**',route=>route.fulfill({contentType:'image/png',body:pixel}));
  await context.route('https://www.coursera.org/**',route=>{const url=new URL(route.request().url());if(url.pathname==='/__event'){const event=url.searchParams.get('event');events[event]=(events[event]||0)+1;if(event.startsWith('submit-'))passed.add(event.slice(7));return route.fulfill({body:'{}'});}visits.push(url.pathname);return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8">'+fixture(url)});});
  page=await context.newPage();const popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId(extension)}/popup.html`);
  await popup.evaluate(({token,scope,url})=>chrome.storage.local.set({bridgeToken:token,[`checkpoint:${scope}`]:{scope,accountHint:'',progress:{item:null,phase:'waiting',visited:[],submitted:[],pages:[],inventory:[],queue:[{key:url.replace('/module-3-review',''),url,title:'Обзор модуля 3',status:'skipped',reason:'Задания отключены: обрабатываются только материалы и тесты.'}]}}}),{token,scope,url:urlFor(items[1])});
  await page.goto(urlFor(items[2])+'/attempt');
  async function command(action,data={}){return popup.evaluate(async({action,data})=>{for(const tab of await chrome.tabs.query({}))try{const state=await chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action:'status'});if(state?.ok)return await chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action,data});}catch{}},{action,data});}
  assert.equal((await command('courseStart',{speed:2,resumeQueue:true})).ok,true);
  const deadline=Date.now()+105000;let state;
  while(Date.now()<deadline){
    const result=await command('status');if(result?.ok){state=result.data;if(passed.size===4&&state.course.phase==='waiting'&&state.course.pending===1)break;if(!state.courseRunning&&state.course.phase!=='idle')throw Error('Course stopped: '+state.message);
      if(!reloaded&&state.course.pending&&passed.size===2&&events['reading-a']&&events['reading-b']){reloaded=true;await page.reload();}
    }await page.waitForTimeout(150);
  }
  assert.equal(state?.course.phase,'waiting',JSON.stringify(state));assert.equal(state.courseRunning,true);assert(visits.some(url=>url.includes('/supplement/locked/')));assert.equal(attempts,2);assert.equal(changedAttempts,2);assert.equal(reloaded,true);assert.equal(passed.size,4);
  assert.equal(events['written-submit']||0,0);assert(!visits.some(url=>url.includes('/peer/')));
  assert.equal(visits.filter(url=>url.includes('/written/')).length,1,'a correctly excluded written form must not be retried after reload');
  for(const item of items)assert.equal(events['submit-'+item[0]],1);
  assert.equal(state.course.needsInput,0);assert.equal(state.course.pending,1);assert.equal(state.course.skipped,2);await command('stop');
  console.log('ASSESSMENT_RECOVERY_PASSED (Russian covers, old skipped review recovered, attached images, changed form cancels stale answers, temporary error, materials and later quizzes, reload, automatic retry, single Start)');
 }finally{if(context)await context.close();if(server)await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(temporary),fs.realpathSync(os.tmpdir()));fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
