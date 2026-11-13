const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {extensionId}=require('../bridge/install-native.cjs');
const root=path.resolve(__dirname,'..'),extension=path.join(root,'extension');
const temporary=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'coursera-completed-'));
let browser;
(async()=>{
  try{
    browser=await chromium.launchPersistentContext(temporary,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    const loads=new Map(),marks=new Map();
    const icon='<svg width="15" height="15" data-testid="learn-item-success-icon"></svg>';
    await browser.route('https://www.coursera.org/**',route=>{
      const url=new URL(route.request().url()),scope=url.pathname.split('/').slice(0,3).join('/')+'/';
      const key=url.pathname;loads.set(key,(loads.get(key)||0)+1);
      if(url.pathname==='/__mark'){const name=url.searchParams.get('course');marks.set(name,(marks.get(name)||0)+1);return route.fulfill({body:'{}'});}
      let body;
      if(url.pathname.includes('/home/'))body='<main><h1 data-testid="course-completed">Course completed</h1></main>';
      else if(url.pathname.includes('/quiz/'))body='<main><h1>Completed quiz</h1><div data-testid="quiz-result" data-score="100">Passed 100%</div></main>';
      else{
        const hidden=url.pathname.includes('/hidden/');
        const links=[['supplement/current/title',icon],['supplement/done/title',icon],['lecture/done/title',icon],['quiz/done/title',icon],['supplement/hidden/title',icon.replace('<svg','<svg style="display:none"')]].map(([href,proof])=>`<a href="${scope+href}">${href}${proof}</a>`).join('');
        body=`<aside data-testid="left-nav">${links}</aside><a href="${scope}home/completed">Course home</a><main><h1>${hidden?'Unfinished reading':'Completed reading'}</h1>${hidden?`<button onclick="fetch('/__mark?course=${scope.split('/')[2]}',{method:'POST'});this.outerHTML='<h3>Completed</h3>'">Mark as complete</button>`:'<h3>Completed</h3>'}</main>`;
      }
      return route.fulfill({contentType:'text/html',body:'<!doctype html>'+body});
    });
    const popup=await browser.newPage();await popup.goto(`chrome-extension://${extensionId(extension)}/popup.html`);
    const page=await browser.newPage();
    const command=(action,data)=>popup.evaluate(async({action,data})=>{for(const tab of await chrome.tabs.query({})){try{const result=await chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action,data});if(result?.ok)return result;}catch{}}},{action,data});
    for(const [name,target100,knownPerfect] of [['skip-completed',false,false],['skip-perfect',true,true],['check-perfect',true,false]]){
      const scope=`https://www.coursera.org/learn/${name}/`,key=scope+'quiz/done',journal=[{item:key,at:Date.now(),confirmed:true}];
      await popup.evaluate(({scope,key,journal,knownPerfect})=>chrome.storage.local.set({[`checkpoint:${scope}`]:{scope,accountHint:'',progress:{item:null,phase:'lesson',visited:[],submitted:journal,pages:[],feedbackResultRecoveryVersion:3,quizReviews:knownPerfect?{[key]:{score:100}}:{}}}}),{scope,key,journal,knownPerfect});
      await page.goto(scope+'supplement/current/title');
      assert.equal((await command('courseStart',{speed:2,skipVideo:false,target100,resumeQueue:true})).ok,true);
      await page.waitForURL(scope+'home/completed',{timeout:15000});
      await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='Course completed');
      const status=await command('status');
      assert.equal(loads.get(`/learn/${name}/supplement/done/title`)||0,0,'completed readings must not reopen');
      assert.equal(loads.get(`/learn/${name}/lecture/done/title`)||0,0,'completed videos must not reopen');
      assert.equal(loads.get(`/learn/${name}/quiz/done/title`)||0,target100&&!knownPerfect?1:0,'only an unknown perfect score needs its cover checked');
      assert.equal(marks.get(name),1,'a hidden completion icon must not skip unfinished work');
      const saved=await popup.evaluate(scope=>chrome.storage.local.get(`checkpoint:${scope}`),scope);
      assert.deepEqual(saved[`checkpoint:${scope}`].progress.submitted,journal,'completed quizzes must never submit again');
      assert.equal(status.ok,true);await command('stop');
    }
    console.log('COMPLETED_BROWSER_PASSED (completed materials skipped, perfect target preserved, hidden icon rejected, submission journal unchanged)');
  }finally{
    if(browser)await browser.close();
    assert.equal(path.dirname(temporary),fs.realpathSync(os.tmpdir()));assert(path.basename(temporary).startsWith('coursera-completed-'));
    fs.rmSync(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
