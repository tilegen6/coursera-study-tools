const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {extensionId}=require('../bridge/install-native.cjs');
const {HOST_NAME,PORT,defaultHome,readJson,readState,checkHealth}=require('../bridge/manager.cjs');
const root=path.resolve(__dirname,'..');
const extension=path.join(root,'extension');

async function closeContext(context){
  let timer;
  try{await Promise.race([context.close(),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Installed native diagnostic browser did not close within 15 seconds')),15000);})]);}
  finally{clearTimeout(timer);}
}

(async()=>{
  assert.equal(process.platform,'win32','Installed native diagnostic requires Windows');
  const home=defaultHome(),manifestPath=path.join(home,'native-host.json');
  const configPath=path.join(home,'runtime/bridge/native-config.json');
  assert(fs.statSync(manifestPath).isFile(),'Installed native host manifest is missing');
  assert(fs.statSync(configPath).isFile(),'Installed native host config is missing');
  const manifest=readJson(manifestPath),config=readJson(configPath);
  const id=extensionId(extension),origin=`chrome-extension://${id}/`;
  assert.equal(manifest?.name,HOST_NAME);
  assert.equal(manifest.type,'stdio');
  assert(manifest.allowed_origins?.includes(origin),'Installed host does not allow this project extension');
  assert(config?.allowedOrigins?.includes(origin),'Installed config does not allow this project extension');
  assert.equal(path.resolve(config.home),path.resolve(home));
  assert.equal(config.port,PORT);
  for(const file of [manifest.path,config.node,config.codex,config.serverPath])assert(path.isAbsolute(file)&&fs.statSync(file).isFile(),'Installed native executable or runtime file is missing');
  const key=`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
  for(const view of ['32','64']){
    const query=spawnSync('reg.exe',['QUERY',key,'/ve',`/reg:${view}`],{encoding:'utf8',windowsHide:true,timeout:5000});
    assert.equal(query.status,0,`Installed Chrome native host registration is missing in registry view ${view}`);
    const value=query.stdout.match(/\bREG_SZ[ \t]+([^\r\n]+)/)?.[1].trim();
    assert(value&&path.resolve(value).toLowerCase()===path.resolve(manifestPath).toLowerCase(),`Installed Chrome native host registration points elsewhere in registry view ${view}`);
  }
  const tempRoot=fs.realpathSync(os.tmpdir());
  const temporary=fs.mkdtempSync(path.join(tempRoot,'coursera-installed-native-'));
  let context,state;
  try{
    context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    const popup=await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const result=await popup.evaluate(async()=>{
      const response=await chrome.runtime.sendMessage({source:'coursera-study-solver',action:'connect'});
      const serialized=JSON.stringify(response||{});
      return {ok:response?.ok===true,ready:response?.data?.ready===true,provider:response?.data?.provider==='codex-chatgpt',exposesToken:/"(?:bridge)?token"\s*:|[a-f0-9]{64}/i.test(serialized),error:String(response?.error||'').replace(/[a-f0-9]{64}/gi,'[hidden]').slice(0,500)};
    });
    assert.equal(result.exposesToken,false,'Trusted connect response exposed a token');
    assert.equal(result.ok,true,result.error||'Installed native host did not connect');
    assert.equal(result.ready,true);
    assert.equal(result.provider,true);
    state=readState(home,config.port);
    assert(state,'Installed native host did not publish valid managed state');
    assert(state.build===config.build,'Installed native host started a different runtime build');
    assert(await checkHealth(state),'Installed managed bridge is not healthy');
  }finally{
    try{if(context)await closeContext(context);}
    finally{
      assert.equal(path.dirname(temporary),tempRoot);
      assert(path.basename(temporary).startsWith('coursera-installed-native-'));
      fs.rmSync(temporary,{recursive:true,force:true,maxRetries:3,retryDelay:100});
    }
  }
  assert(await checkHealth(state),'Installed bridge must survive closing the disposable browser');
  console.log('INSTALLED_NATIVE_PASSED');
})().catch(error=>{console.error(String(error.message).replace(/[a-f0-9]{64}/gi,'[hidden]'));process.exitCode=1;});
