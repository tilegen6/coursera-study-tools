const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createBridge}=require('../bridge/server.cjs');
const {extensionId}=require('../bridge/install-native.cjs');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'coursera-offline-'));
const extension=path.join(temporary,'extension'),token='e'.repeat(64),base='https://www.coursera.org/learn/offline-demo/';
let context,server,submissions=0,solves=0;
function fixture(url){
  if(url.pathname.includes('/home/'))return '<main><h1 data-testid="course-completed">Course completed</h1></main>';
  if(url.pathname.includes('/quiz/'))return `<main><h1>Quiz</h1><fieldset><legend>2 + 2?</legend><label><input type="radio" name="q">3</label><label><input type="radio" name="q">4</label></fieldset><button id="submit">Submit</button><a href="${base}supplement/last/title">Next lesson</a><script>document.getElementById('submit').onclick=async()=>{await fetch('/__submitted',{method:'POST'});document.querySelector('main').innerHTML='<h2>You passed!</h2><a href="${base}supplement/last/title">Next lesson</a>';};</script></main>`;
  const last=url.pathname.includes('/last/');
  return `<main><h1>${last?'Final reading':'Reading'}</h1><button onclick="this.outerHTML='<button disabled>Completed</button>'">Mark as complete</button><a href="${base}${last?'home/completed':'quiz/q/title'}">Next lesson</a></main>`;
}
(async()=>{
  try{
    server=createBridge({token,solve:async task=>{solves++;return {status:'solved',answers:task.questions.map(question=>({id:question.id,choices:[2],text:''}))};}});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    fs.cpSync(path.join(root,'extension'),extension,{recursive:true});
    const file=path.join(extension,'background.js');
    fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('http://127.0.0.1:43179',`http://127.0.0.1:${server.address().port}`).replace("'com.coursera.studytools'",JSON.stringify('com.coursera.studytools.absent_'+process.pid+'_'+Date.now())));
    context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    await context.route('https://www.coursera.org/**',route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/__submitted'){submissions++;return route.fulfill({body:'{}'});}
      return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html>'+fixture(url)});
    });
    const page=await context.newPage();await page.goto(base+'supplement/first/title');
    const popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId(extension)}/popup.html`);await page.bringToFront();
    await popup.locator('#refresh').click();await popup.waitForFunction(()=>!document.getElementById('run-course').disabled);
    await popup.locator('#run-course').click();
    await page.waitForURL('**/home/completed',{timeout:20000}).catch(async error=>{console.error(await popup.locator('#feedback').innerText());throw error;});
    await popup.waitForFunction(()=>document.getElementById('title').textContent==='Course completed' && document.getElementById('queue-items').textContent.includes('native messaging host not found'),null,{timeout:20000});
    if (!await popup.locator('#queue-items').evaluate(element=>element.closest('details').open)) await popup.getByText('Очередь заданий',{exact:true}).click();
    assert.equal(submissions,0);assert.equal(solves,0);
    assert.match(await popup.locator('#run-course').innerText(),/выполняется/);
    assert.doesNotMatch(await popup.locator('#feedback').innerText(),/^Курс завершён/);
    assert.match(await popup.locator('#queue-items').textContent(),/native messaging host not found/i);
    // Restore the solver only in this disposable profile; the runner must retry by itself.
    await popup.evaluate(token=>chrome.storage.local.set({bridgeToken:token}),token);
    await popup.waitForFunction(()=>document.getElementById('feedback').textContent.startsWith('Курс завершён'),null,{timeout:85000});
    assert.equal(submissions,1);assert.equal(solves,1);
    assert.equal(await popup.locator('#queue-items').textContent(),'');
    assert.equal(page.url(),base+'home/completed');
    console.log('OFFLINE_BROWSER_PASSED (one click, missing native host, materials continue, automatic backoff/recheck, single submission)');
  }finally{
    if(context)await context.close();if(server)await new Promise(resolve=>server.close(resolve));
    assert.equal(path.dirname(temporary),fs.realpathSync(os.tmpdir()));assert(path.basename(temporary).startsWith('coursera-offline-'));fs.rmSync(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
