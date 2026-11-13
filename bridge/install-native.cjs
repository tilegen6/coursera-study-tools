'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {HOST_NAME,defaultHome,legacyHome,readJson}=require('./manager.cjs');
function extensionId(directory){
  const manifest=readJson(path.join(directory,'manifest.json'));
  if(!manifest)throw Error('Не найден manifest.json расширения.');
  let data;
  if(manifest.key)data=Buffer.from(manifest.key,'base64');
  else {let absolute=path.resolve(directory);if(process.platform==='win32')absolute=absolute.replace(/^[a-z]:/,drive=>drive.toUpperCase());data=Buffer.from(absolute,process.platform==='win32'?'utf16le':'utf8');}
  return crypto.createHash('sha256').update(data).digest('hex').slice(0,32).replace(/[0-9a-f]/g,digit=>String.fromCharCode(97+parseInt(digit,16)));
}
function registryKeys(name){return ['Google\\Chrome','Microsoft\\Edge','Chromium'].map(browser=>`HKCU\\Software\\${browser}\\NativeMessagingHosts\\${name}`);}
function registerHost(name,file){
  for(const key of registryKeys(name)){
    const result=spawnSync('reg.exe',['ADD',key,'/ve','/t','REG_SZ','/d',file,'/f'],{encoding:'utf8',windowsHide:true,timeout:5000});
    if(result.status!==0)throw Error('Не удалось зарегистрировать локальное подключение браузера.');
  }
}
function writeAtomic(file,data){const temp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(temp,data,{mode:0o600});fs.renameSync(temp,file);}finally{try{fs.unlinkSync(temp);}catch{}}}
function install(root,options={}){
  if(process.platform!=='win32')throw Error('Автоматическая установка подключения поддерживается в Windows.');
  const home=options.home||defaultHome(), name=options.name||HOST_NAME;
  if(!/^com\.coursera\.studytools(?:\.[a-z0-9_]+)?$/.test(name))throw Error('Invalid native host name');
  const node=options.node||process.execPath,codex=options.codex||process.env.CODEX_BINARY;
  if(!path.isAbsolute(node)||!path.isAbsolute(codex||'')||!fs.existsSync(node)||!fs.existsSync(codex))throw Error('Нужны установленные Node.js и Codex CLI. Запустите Start-Bridge.cmd.');
  const runtime=path.join(home,'runtime');
  fs.mkdirSync(runtime,{recursive:true,mode:0o700});
  for(const file of ['bridge/server.cjs','bridge/quiz-images.cjs','bridge/quiz-batches.cjs','bridge/manager.cjs','bridge/native-host.cjs','extension/core.js','extension/assignment-core.js']){
    const target=path.join(runtime,file);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
    const source=path.join(root,file);if(path.resolve(source)!==path.resolve(target))writeAtomic(target,fs.readFileSync(source));
  }
  const candidates=[options.extensionPath||path.join(root,'extension')];
  if(!options.extensionPath && fs.existsSync(path.join(root,'dist/coursera-study-tools/extension/manifest.json')))candidates.push(path.join(root,'dist/coursera-study-tools/extension'));
  const manifestPath=path.join(home,'native-host.json');
  const old=readJson(manifestPath)||(!options.home && readJson(path.join(legacyHome(),'native-host.json')));
  const allowedOrigins=[...new Set([...(options.preserveOrigins===false?[]:old?.allowed_origins||[]),...candidates.map(directory=>`chrome-extension://${extensionId(directory)}/`)])].filter(origin=>/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin)).slice(-16);
  const config={home,node,codex,serverPath:options.serverPath||path.join(runtime,'bridge/server.cjs'),allowedOrigins,port:options.port||43179};
  const build=crypto.createHash('sha256').update(node).update('\0').update(codex);
  for(const file of [config.serverPath,path.join(runtime,'bridge/quiz-images.cjs'),path.join(runtime,'bridge/quiz-batches.cjs'),path.join(runtime,'bridge/manager.cjs'),path.join(runtime,'extension/core.js'),path.join(runtime,'extension/assignment-core.js')])build.update('\0').update(fs.readFileSync(file));
  config.build=build.digest('hex');
  writeAtomic(path.join(runtime,'bridge/native-config.json'),JSON.stringify(config,null,2));
  // %~dp0 preserves Unicode directory names; UTF-8 handles executable paths too.
  const wrapper=path.join(runtime,'bridge/native-host.cmd');
  const executable=node.replaceAll('%','%%');
  writeAtomic(wrapper,`@echo off\r\nchcp 65001 >nul 2>nul\r\n"${executable}" "%~dp0native-host.cjs" %*\r\n`);
  writeAtomic(manifestPath,JSON.stringify({name,description:'Coursera Study Tools local connection',path:wrapper,type:'stdio',allowed_origins:allowedOrigins},null,2));
  if(options.register!==false)registerHost(name,manifestPath);
  return {config,manifestPath,name};
}
if(require.main===module){try{install(path.resolve(__dirname,'..'));console.log('Локальное подключение Chrome/Edge установлено.');}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={extensionId,registryKeys,registerHost,install};
