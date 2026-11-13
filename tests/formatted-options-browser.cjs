const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {extensionId}=require('../bridge/install-native.cjs');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'coursera-formatted-'));
const extension=path.join(temporary,'extension');let context;
(async()=>{try{
 fs.cpSync(path.join(root,'extension'),extension,{recursive:true});
 context=await chromium.launchPersistentContext(path.join(temporary,'browser'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 await context.route('https://www.coursera.org/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><main><h1>Quiz</h1><form data-test="quiz-form"><fieldset><legend>Which notation is italic?</legend><label><input type="radio" name="q"><em>anOperation()</em></label><label><input type="radio" name="q">abstract anOperation()</label><label><input type="radio" name="q">x<sup>2</sup></label><label><input type="radio" name="q">a<sub>n</sub></label><label><input type="radio" name="q"><strong>bold</strong></label></fieldset></form></main>'}));
 const page=await context.newPage(),popup=await context.newPage();await page.goto('https://www.coursera.org/learn/format/assignment-submission/q/quiz/attempt');await popup.goto(`chrome-extension://${extensionId(extension)}/popup.html`);
 const exported=await popup.evaluate(async()=>{for(const tab of await chrome.tabs.query({}))try{const response=await chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action:'quizExport'});if(response?.ok)return response;}catch{}});
 assert.deepEqual(exported.data.questions[0].options,['*anOperation()*','abstract anOperation()','x^{2}','a_{n}','**bold**']);
 const applied=await popup.evaluate(async answer=>{for(const tab of await chrome.tabs.query({}))try{const state=await chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action:'status'});if(state?.ok)return await chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action:'quizApply',data:{raw:JSON.stringify(answer)}});}catch{}},{answers:[{id:1,question:exported.data.questions[0].question,options:exported.data.questions[0].options,choices:[1]}]});
 assert.equal(applied.ok,true);assert.equal(await page.locator('input[type=radio]:checked').count(),1);assert.equal(await page.locator('input[type=radio]').first().isChecked(),true);
 console.log('FORMATTED_OPTIONS_PASSED (emphasis, superscript, subscript, bold and stable answer binding)');
}finally{if(context)await context.close();assert.equal(path.dirname(temporary),fs.realpathSync(os.tmpdir()));fs.rmSync(temporary,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
