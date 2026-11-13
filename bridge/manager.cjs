'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const PORT = 43179;
const HOST_NAME = 'com.coursera.studytools';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const legacyHome = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'CourseraStudyTools');
// AppData files created from packaged desktop apps can be invisible to Chrome.
const defaultHome = () => process.platform === 'win32' ? path.join(process.env.USERPROFILE || os.homedir(), '.coursera-study-tools') : legacyHome();
const statePath = home => path.join(home, 'bridge-state.json');

function readJson(file) {
  try { if(fs.statSync(file).size>16384)return null; return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return null; }
}
function readState(home, port = PORT) {
  const state=readJson(statePath(home));
  return state?.schema===1 && state.port===port && /^[a-f0-9]{64}$/.test(state.token||'') && /^[a-f0-9]{64}$/.test(state.build||'') && /^[a-f0-9-]{36}$/.test(state.instance||'') && Number.isSafeInteger(state.pid) && state.pid>0 ? state : null;
}
function request(state, route='/health', method='GET') {
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:state.port,path:route,method,headers:{Authorization:`Bearer ${state.token}`,Connection:'close'}},response=>{
      let body='';
      response.on('data',chunk=>{body+=chunk;if(body.length>16384)req.destroy(new Error('Oversized local response'));});
      response.on('error',reject);response.on('aborted',()=>reject(new Error('Incomplete local response')));
      response.on('end',()=>{try{if(response.statusCode!==200)throw Error('Local authentication failed');resolve(JSON.parse(body));}catch(error){reject(error);}});
    });
    req.setTimeout(1200,()=>req.destroy(new Error('Local service timeout')));
    req.on('error',reject);req.end();
  });
}
async function checkHealth(state) {
  if(!state)return false;
  try {const response=await request(state);return response.ready===true && response.provider==='codex-chatgpt' && response.instance===state.instance && response.build===state.build;}catch{return false;}
}
async function occupied(port) {
  return new Promise(resolve=>{
    const socket=net.connect({host:'127.0.0.1',port});let done=false;
    const finish=value=>{if(done)return;done=true;socket.destroy();resolve(value);};
    socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(600,()=>finish(true));
  });
}
function alive(pid) {try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
async function locked(home, operation) {
  fs.mkdirSync(home,{recursive:true,mode:0o700});
  const file=path.join(home,'start.lock'), nonce=crypto.randomUUID(), deadline=Date.now()+20000;
  while(true){
    try {const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,nonce}));}finally{fs.closeSync(fd);}break;}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      const previous=readJson(file);
      try {const age=Date.now()-fs.statSync(file).mtimeMs;if((previous?.pid && !alive(previous.pid) && age>500)||(!previous && age>30000)){fs.unlinkSync(file);continue;}}catch{}
      if(Date.now()>deadline)throw Error('Другой запуск сервиса ещё выполняется. Повторите позже.');
      await sleep(80);
    }
  }
  try{return await operation();}finally{if(readJson(file)?.nonce===nonce)fs.unlinkSync(file);}
}
async function ensureBridge(config) {
  const {home,node,codex,serverPath,port=PORT}=config;
  const build=config.build||crypto.createHash('sha256').update(fs.readFileSync(serverPath)).digest('hex');
  if(![home,node,codex,serverPath].every(value=>typeof value==='string' && path.isAbsolute(value)))throw Error('Некорректная локальная установка. Запустите Start-Bridge.cmd.');
  return locked(home,async()=>{
    let state=readState(home,port);
    if(await checkHealth(state)){
      if(state.build===build)return state;
      await stopBridge(home,port);
    }
    if(path.resolve(home)===path.resolve(defaultHome()) && path.resolve(home)!==path.resolve(legacyHome())){
      await stopBridge(legacyHome(),port);
    }
    if(await occupied(port))throw Error(`Порт ${port} занят другим или старым сервисом. Остановите прежний Start-Bridge и повторите запуск.`);
    if(config.checkLogin)await config.checkLogin();
    else {
      let login;
      try {login=await execute(codex,['login','status'],{windowsHide:true,timeout:10000,maxBuffer:65536});}
      catch(error){
        if(error.code==='ENOENT')throw Error('Путь к Codex CLI устарел после обновления приложения. Запустите Start-Bridge.cmd для обновления подключения.');
        throw Error('Выполните codex login и войдите через ChatGPT.');
      }
      if(!/ChatGPT/i.test(login.stdout+' '+login.stderr))throw Error('Для сервиса нужен вход Codex через ChatGPT.');
    }
    const argumentsList=[serverPath,'--managed',home,String(port),build];
    let executable=node,args=argumentsList;
    if(process.platform==='win32'){
      // Start-Process avoids retaining the browser/native-host pipe handles on Windows.
      const quote=value=>"'"+value.replaceAll("'","''")+"'";
      const command=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';Start-Process -WindowStyle Hidden -FilePath ${quote(node)} -ArgumentList ${quote(argumentsList.map(value=>'"'+value+'"').join(' '))}`;
      executable=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
      args=['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')];
    }
    const child=spawn(executable,args,{detached:process.platform!=='win32',windowsHide:true,stdio:process.platform==='win32'?['ignore','pipe','pipe']:'ignore',env:{...process.env,CODEX_BINARY:codex}});
    let diagnostics='';child.stdout?.resume();child.stderr?.on('data',data=>{diagnostics=(diagnostics+data.toString()).slice(-16000);});
    let spawnError;child.once('error',error=>{spawnError=error;});child.unref();
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      if(spawnError || (child.exitCode!==null && child.exitCode!==0))break;
      state=readState(home,port);if(await checkHealth(state))return state;
      await sleep(100);
    }
    if(diagnostics)fs.writeFileSync(path.join(home,'bootstrap-error.log'),diagnostics,{mode:0o600});
    throw Error('Не удалось запустить локальный сервис. Проверьте установку Node.js и Codex.');
  });
}
async function runManaged({home,port=PORT,build,createServer}) {
  if(!/^[a-f0-9]{64}$/.test(build||''))throw Error('Invalid managed build');
  fs.mkdirSync(home,{recursive:true,mode:0o700});
  const state={schema:1,pid:process.pid,port,build,token:crypto.randomBytes(32).toString('hex'),instance:crypto.randomUUID()};
  let server;
  const stop=()=>server.close();
  server=createServer({token:state.token,instance:state.instance,build,onShutdown:stop});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const temporary=path.join(home,`state-${state.instance}.tmp`);
  try {fs.writeFileSync(temporary,JSON.stringify(state),{mode:0o600,flag:'wx'});fs.renameSync(temporary,statePath(home));}
  catch(error){server.close();try{fs.unlinkSync(temporary);}catch{}throw error;}
  server.on('close',()=>{if(readState(home,port)?.instance===state.instance)try{fs.unlinkSync(statePath(home));}catch{}});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);
  return {server,state};
}
async function stopBridge(home,port=PORT) {
  const state=readState(home,port);
  if(!await checkHealth(state))return false;
  await request(state,'/shutdown','POST');
  const deadline=Date.now()+5000;
  while(await checkHealth(state)){if(Date.now()>deadline)throw Error('Сервис ещё завершает работу.');await sleep(100);}
  return true;
}
module.exports={PORT,HOST_NAME,defaultHome,legacyHome,readJson,readState,request,checkHealth,ensureBridge,runManaged,stopBridge};
