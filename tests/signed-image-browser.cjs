const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createBridge}=require('../bridge/server.cjs'),{extensionId}=require('../bridge/install-native.cjs');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'coursera-signed-images-'));
const extension=path.join(temporary,'extension'),token='d'.repeat(64),image='https://d3c33hcgiwev3.cloudfront.net/imageAssetProxy.v1/diagram.png';
const events={},calls={};let context,server,page;
(async()=>{try{
 server=createBridge({token,solve:async quiz=>{
  const mode=new URL(quiz.url).pathname.split('/')[2];calls[mode]=(calls[mode]||0)+1;
  assert.equal(quiz.questions.length,1);assert.equal(quiz.questions[0].images[0].url,image+'?expiry=1&hmac=first&width=200');
  const replacement=mode==='asset'?image.replace('diagram','replacement')+'?expiry=2&hmac=second&width=200':image+'?expiry=2&hmac=second&width='+(mode==='transform'?300:200);
  await page.locator('img').evaluate((element,url)=>{element.src=url;},replacement);
  return {status:'solved',answers:[{id:1,choices:[2],text:''}]};
 }});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 fs.cpSync(path.join(root,'extension'),extension,{recursive:true});const worker=path.join(extension,'background.js');fs.writeFileSync(worker,fs.readFileSync(worker,'utf8').replace('http://127.0.0.1:43179',`http://127.0.0.1:${server.address().port}`));
 context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RUAAAAAASUVORK5CYII=','base64');
 await context.route('https://d3c33hcgiwev3.cloudfront.net/**',route=>route.fulfill({contentType:'image/png',body:pixel}));
 await context.route('https://www.coursera.org/**',route=>{
  const url=new URL(route.request().url());if(url.pathname==='/__submit'){const mode=url.searchParams.get('mode');events[mode]=(events[mode]||0)+1;return route.fulfill({body:'{}'});}
  const mode=url.pathname.split('/')[2];return route.fulfill({contentType:'text/html',body:`<!doctype html><main><h1>Quiz</h1><form data-test="quiz-form"><fieldset><legend>Which side is blue?</legend><img src="${image}?expiry=1&hmac=first&width=200" alt="Diagram"><label><input type="radio" name="q">Left</label><label><input type="radio" name="q" onchange="document.querySelector('img').src='${image}?expiry=3&hmac=third&width=200'">Right</label></fieldset><button type="button" onclick="fetch('/__submit?mode=${mode}',{method:'POST'}).then(()=>this.closest('form').outerHTML='<div data-test=&quot;quiz-result&quot; data-score=&quot;100&quot;><h2>You passed!</h2></div><h2 data-testid=&quot;course-completed&quot;>Course completed</h2>')">Submit answers</button></form></main>`});
 });
 page=await context.newPage();const popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId(extension)}/popup.html`);await popup.evaluate(token=>chrome.storage.local.set({bridgeToken:token}),token);
 async function command(action,data={}){return popup.evaluate(async({action,data})=>{for(const tab of await chrome.tabs.query({}))try{const status=await chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action:'status'});if(status?.ok)return await chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action,data});}catch{}},{action,data});}
 for(const mode of ['signed','asset','transform']){
  await page.goto(`https://www.coursera.org/learn/${mode}/assignment-submission/q/quiz/attempt`);assert.equal((await command('courseStart',{speed:2})).ok,true);
  let state;const deadline=Date.now()+10000;while(Date.now()<deadline){state=(await command('status'))?.data;if(mode==='signed'?state?.course.phase==='completed':state?.courseRunning&&state.course.phase==='waiting'&&state.course.pending===1)break;await page.waitForTimeout(100);}
  assert.equal(calls[mode],1);assert.equal(events[mode]||0,mode==='signed'?1:0,JSON.stringify(state));
  assert.equal(mode==='signed'?state.course.phase:state.course.pending,mode==='signed'?'completed':1,JSON.stringify(state));await command('stop');
 }
 console.log('SIGNED_IMAGE_BROWSER_PASSED (signature rotation during solving and filling; changed asset/transform blocked; single model call and submission)');
}finally{if(context)await context.close();if(server)await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(temporary),fs.realpathSync(os.tmpdir()));fs.rmSync(temporary,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
