const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {spawn}=require('node:child_process');
const {ensureBridge,stopBridge,readState,checkHealth,defaultHome,legacyHome}=require('../bridge/manager.cjs');
const {install,extensionId}=require('../bridge/install-native.cjs');
const {encode,connect}=require('../bridge/native-host.cjs');
const root=path.resolve(__dirname,'..');
const fixture=path.join(__dirname,'fixtures/native-server.cjs');
async function portNumber(){const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
function remove(home){assert.equal(path.dirname(home),fs.realpathSync(os.tmpdir()));assert(path.basename(home).startsWith('coursera-native-'));fs.rmSync(home,{recursive:true,force:true});}
function nativeRequest(script,origin,data){return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[script,origin,'--parent-window=0'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const chunks=[];let errors='';const timeout=setTimeout(()=>{child.kill();reject(Error('native timeout'));},10000);
  child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>errors+=chunk);
  child.once('error',reject);child.once('close',code=>{clearTimeout(timeout);const buffer=Buffer.concat(chunks);try{assert.equal(code,0,errors);assert(buffer.length>=4);assert.equal(buffer.readUInt32LE(0),buffer.length-4);resolve(JSON.parse(buffer.subarray(4)));}catch(error){reject(error);}});
  // Split both the prefix and UTF-8 body across pipe writes.
  child.stdin.write(data.subarray(0,2));setTimeout(()=>child.stdin.end(data.subarray(2)),10);
});}

test('native host rejects unknown origins and operations before touching state',async()=>{
  await assert.rejects(connect({action:'connect',version:1},'chrome-extension://'+'a'.repeat(32)+'/',{allowedOrigins:[]}),/источник/);
  const origin='chrome-extension://'+'a'.repeat(32)+'/';
  for(const message of [{action:'exec',version:1},{action:'connect',version:2},{action:'connect',version:1,path:'evil'}])await assert.rejects(connect(message,origin,{allowedOrigins:[origin]}),/команда/);
  assert.throws(()=>encode({data:'x'.repeat(5000)}),/Oversized/);
});

test('a removed Codex executable reports a stale installation instead of a missing login',async()=>{
  const home=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'coursera-native-'));
  const port=await portNumber();
  try{
    await assert.rejects(ensureBridge({home,node:process.execPath,codex:path.join(home,'removed-app-version','codex.exe'),serverPath:fixture,port}),error=>{
      assert.match(error.message,/Путь к Codex CLI устарел/);
      assert(!error.message.includes('codex login'),'an absent executable does not prove an absent login');return true;
    });
    assert.equal(readState(home,port),null);
  }finally{remove(home);}
});

test('shared startup serializes callers, reuses authenticated state and rotates tokens after stop',async()=>{
  const home=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'coursera-native-'));
  const port=await portNumber();const config={home,node:process.execPath,codex:process.execPath,serverPath:fixture,port,checkLogin:async()=>{}};
  try{
    const states=await Promise.all([ensureBridge(config),ensureBridge(config),ensureBridge(config)]);
    assert(states.every(state=>state.instance===states[0].instance));assert(await checkHealth(states[0]));
    assert.equal(await stopBridge(home,port),true);
    assert.equal(await checkHealth(states[0]),false);
    const restarted=await ensureBridge(config);assert.notEqual(restarted.token,states[0].token);
    assert.notEqual(restarted.instance,states[0].instance);
    const response=await fetch(`http://127.0.0.1:${port}/health`);assert.equal(response.status,401);
    const updated=await ensureBridge({...config,build:'e'.repeat(64)});assert.equal(updated.build,'e'.repeat(64));assert.notEqual(updated.instance,restarted.instance);
  }finally{await stopBridge(home,port);remove(home);}
});

test('a foreign occupied port is rejected without killing it or trusting stale state',async()=>{
  const home=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'coursera-native-'));
  const foreign=http.createServer((request,response)=>response.end('{}'));await new Promise(resolve=>foreign.listen(0,'127.0.0.1',resolve));const port=foreign.address().port;
  try{
    fs.writeFileSync(path.join(home,'bridge-state.json'),JSON.stringify({schema:1,pid:process.pid,port,token:'a'.repeat(64),instance:'a'.repeat(8)+'-'+'a'.repeat(4)+'-'+'a'.repeat(4)+'-'+'a'.repeat(4)+'-'+'a'.repeat(12)}));
    await assert.rejects(ensureBridge({home,node:process.execPath,codex:process.execPath,serverPath:fixture,port}),/занят/);
    assert.equal((await fetch(`http://127.0.0.1:${port}`)).status,200);
  }finally{await new Promise(resolve=>foreign.close(resolve));remove(home);}
});

test('Windows default-home migration preserves origins and stops only the authenticated legacy service',{skip:process.platform!=='win32'},async()=>{
  const sandbox=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'coursera-native-'));
  const previous={USERPROFILE:process.env.USERPROFILE,LOCALAPPDATA:process.env.LOCALAPPDATA};
  const port=await portNumber();
  process.env.USERPROFILE=sandbox;process.env.LOCALAPPDATA=path.join(sandbox,'AppData');
  const home=defaultHome(),oldHome=legacyHome();
  try{
    assert.equal(home,path.join(sandbox,'.coursera-study-tools'));
    const old=await ensureBridge({home:oldHome,node:process.execPath,codex:process.execPath,serverPath:fixture,port,checkLogin:async()=>{}});
    const retained='chrome-extension://'+'b'.repeat(32)+'/';
    fs.writeFileSync(path.join(oldHome,'native-host.json'),JSON.stringify({allowed_origins:[retained]}));
    const {config}=install(root,{node:process.execPath,codex:process.execPath,serverPath:fixture,port,register:false});
    assert(config.allowedOrigins.includes(retained));
    const current=await ensureBridge({...config,checkLogin:async()=>{}});
    assert(await checkHealth(current));assert.equal(await checkHealth(old),false);
    assert.notEqual(current.instance,old.instance);
    assert(fs.existsSync(path.join(oldHome,'native-host.json')),'legacy files remain available for rollback');
  }finally{
    await stopBridge(home,port);await stopBridge(oldHome,port);
    for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    remove(sandbox);
  }
});

test('installed native protocol handles partial framing, malformed messages and host exit independently',async()=>{
  const home=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'coursera-native-'));
  const port=await portNumber();
  try{
    const {config}=install(root,{home,node:process.execPath,codex:process.execPath,port,serverPath:fixture,register:false});
    const state=await ensureBridge({...config,checkLogin:async()=>{}});
    const script=path.join(home,'runtime/bridge/native-host.cjs'),origin=config.allowedOrigins[0];
    const response=await nativeRequest(script,origin,encode({action:'connect',version:1}));assert.equal(response.token,state.token);
    assert(await checkHealth(state),'service must survive native host exit');
    assert.equal((await nativeRequest(script,'chrome-extension://'+'z'.repeat(32)+'/',encode({action:'connect',version:1}))).ok,false);
    assert.equal((await nativeRequest(script,origin,Buffer.from([255,255,255,127]))).ok,false);
    assert.equal((await nativeRequest(script,origin,Buffer.from([2,0,0,0,123]))).ok,false);
    assert.equal((await nativeRequest(script,origin,Buffer.concat([encode({action:'connect',version:1}),encode({action:'connect',version:1})]))).ok,false);
    assert.match(extensionId(path.join(root,'extension')),/^[a-p]{32}$/);
    assert.equal(readState(home,port).token,state.token);
  }finally{await stopBridge(home,port);remove(home);}
});
