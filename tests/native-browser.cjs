const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {install,extensionId,registryKeys}=require('../bridge/install-native.cjs');
const {readState,stopBridge,checkHealth}=require('../bridge/manager.cjs');
const root=path.resolve(__dirname,'..');
const temporary=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'coursera-native-browser-'));
const extension=path.join(temporary,'extension');
const home=path.join(temporary,'Локальный мост с пробелами');
const name='com.coursera.studytools.t'+Date.now().toString(36)+process.pid;
const url='https://www.coursera.org/learn/native-demo/';
function fixture(pathname){
  if(pathname.includes('/home/'))return '<main><h1 data-testid="course-completed">Course completed</h1></main>';
  if(pathname.includes('/quiz/'))return `<main><h1>Quiz</h1><fieldset><legend>2 + 2?</legend><label><input type="radio" name="q">3</label><label><input type="radio" name="q">4</label></fieldset><button id="submit">Submit</button><script>document.getElementById('submit').onclick=()=>document.querySelector('main').innerHTML='<h2>You passed!</h2><a href="${url}home/completed">Next lesson</a>';</script></main>`;
  return `<main><h1>Reading</h1><input id="draft" value="initial"><button onclick="sessionStorage.draftAtStart=document.getElementById('draft').value;this.outerHTML='<button disabled>Completed</button>'">Mark as complete</button><a href="${url}quiz/q/title">Next lesson</a><script>sessionStorage.readingLoads=Number(sessionStorage.readingLoads||0)+1;</script></main>`;
}
async function run({recover=false,missingPermission=false}={}){
  let context,installed;
  try{
    assert.equal(process.platform,'win32');
    fs.cpSync(path.join(root,'extension'),extension,{recursive:true});
    const manifestFile=path.join(extension,'manifest.json'),updatedManifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
    if(recover)fs.writeFileSync(manifestFile,JSON.stringify({...updatedManifest,version:missingPermission?'1.3.2':'1.4.0',permissions:missingPermission?updatedManifest.permissions.filter(value=>value!=='nativeMessaging'):updatedManifest.permissions}));
    const worker=path.join(extension,'background.js');fs.writeFileSync(worker,fs.readFileSync(worker,'utf8').replace("'com.coursera.studytools'",JSON.stringify(name)));
    const codex=process.env.CODEX_BINARY||spawnSync('where.exe',['codex.exe'],{encoding:'utf8',windowsHide:true}).stdout?.trim().split(/\r?\n/)[0];
    installed=install(root,{home,name,codex,extensionPath:extension,preserveOrigins:false,serverPath:path.join(__dirname,'fixtures/native-server.cjs')});
    context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    await context.route('https://www.coursera.org/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8">'+fixture(new URL(route.request().url()).pathname)}));
    const management=await context.newPage();await management.goto('chrome://extensions/');
    if(recover)await management.locator('extensions-toolbar').locator('#devMode').click();
    const item=management.locator('extensions-item').filter({hasText:'Coursera Study Tools'});await item.waitFor();
    const id=await item.getAttribute('id');assert.equal(id,extensionId(extension),'native origin must preserve the real unpacked extension identity');
    const page=await context.newPage();await page.goto(url+'supplement/r/title');
    let popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);await page.bringToFront();
    await popup.evaluate(()=>document.getElementById('refresh').click());
    await popup.waitForFunction(()=>document.getElementById('dot').classList.contains('connected'));
    assert.equal(await popup.evaluate(async()=>(await chrome.storage.local.get('bridgeToken')).bridgeToken),undefined);
    if(recover){
      assert.equal(await popup.evaluate(()=>chrome.runtime.getManifest().version),missingPermission?'1.3.2':'1.4.0');
      assert.equal(await popup.evaluate(()=>chrome.runtime.getManifest().permissions.includes('nativeMessaging')),!missingPermission);
      await popup.evaluate(()=>chrome.storage.local.set({checkpointProbe:{retained:true}}));
      await page.locator('#draft').fill('unsaved page data');
      fs.writeFileSync(manifestFile,JSON.stringify(updatedManifest));
    }
    // Exactly the course button. No token, helper launch or separate connect click.
    await popup.locator('#run-course').click().catch(error=>{if(!popup.isClosed())throw error;});
    await page.waitForURL('**/home/completed',{timeout:45000}).catch(async error=>{
      if(!popup.isClosed())console.error(await popup.locator('#feedback').innerText());
      else {try{const diagnostic=await context.newPage();await diagnostic.goto(`chrome-extension://${id}/popup.html`);console.error('RECOVERY_DEBUG',await diagnostic.evaluate(async()=>({manifest:chrome.runtime.getManifest(),data:await chrome.storage.local.get(['pendingCourseRecovery','recoveryError','connectionDiagnostics'])})));}catch(problem){console.error('RECOVERY_DEBUG',problem.message);console.error('EXTENSION_CARDS',await management.locator('extensions-item').allTextContents());console.error('EXTENSION_MANAGER',await management.locator('body').innerText());}}
      throw error;
    });
    if(recover){
      assert(popup.isClosed(),'extension reload should replace the old popup');
      popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);await page.bringToFront();
      assert.equal(await popup.evaluate(()=>chrome.runtime.getManifest().version),updatedManifest.version);
      assert.equal(await popup.evaluate(async()=>(await chrome.storage.local.get('checkpointProbe')).checkpointProbe.retained),true);
      assert.equal(await page.evaluate(()=>sessionStorage.readingLoads),'1');
      assert.equal(await page.evaluate(()=>sessionStorage.draftAtStart),'unsaved page data');
      assert.equal(await popup.evaluate(async()=>(await chrome.storage.local.get('pendingCourseRecovery')).pendingCourseRecovery),undefined);
    }
    const first=readState(home);assert(first);assert(await checkHealth(first));
    assert.equal(await popup.evaluate(async()=>(await chrome.storage.local.get('bridgeToken')).bridgeToken),first.token);
    await stopBridge(home);
    await page.goto(url+'supplement/r/title');
    await popup.evaluate(()=>document.getElementById('refresh').click());
    await popup.waitForFunction(()=>document.getElementById('run-course').disabled===false);
    await popup.locator('#run-course').click();
    await page.waitForURL('**/home/completed',{timeout:45000}).catch(async error=>{console.error(await popup.locator('#feedback').innerText());throw error;});
    const second=readState(home);assert(second);assert.notEqual(second.token,first.token);
    assert.equal(await popup.evaluate(async()=>(await chrome.storage.local.get('bridgeToken')).bridgeToken),second.token);
    // Real native framing is also used for the explicit diagnostic action; no credentials reach the page.
    const diagnostic=await popup.evaluate(()=>chrome.runtime.sendMessage({source:'coursera-study-solver',action:'connect'}));
    assert.equal(diagnostic.ok,true);assert.equal(diagnostic.data.token,undefined);
    assert.equal(await page.locator('body').innerText().then(text=>text.includes(second.token)),false);
    let closeTimer;
    try{await Promise.race([context.close(),new Promise((resolve,reject)=>{closeTimer=setTimeout(()=>reject(Error('Browser close retained background service handles')),15000);})]);}finally{clearTimeout(closeTimer);}
    context=null;
    assert(await checkHealth(second),'bridge must survive closing the browser');
    console.log(recover?'RECOVERY_BROWSER_PASSED (stale manifest, native permission, exact document, preserved draft/checkpoint, single-click continuation)':'NATIVE_BROWSER_PASSED (real native channel, preserved ID, Unicode paths, one click, no token entry, restart recovery)');
  }finally{
    await stopBridge(home);
    if(context)await context.close();
    if(installed)for(const key of registryKeys(name))spawnSync('reg.exe',['DELETE',key,'/f'],{windowsHide:true,stdio:'ignore'});
    assert.equal(path.dirname(temporary),fs.realpathSync(os.tmpdir()));assert(path.basename(temporary).startsWith('coursera-native-browser-'));
    fs.rmSync(temporary,{recursive:true,force:true});
  }
}
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};
