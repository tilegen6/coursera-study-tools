'use strict';
const path=require('node:path');
const {install,registerHost}=require('./install-native.cjs');
const {ensureBridge,stopBridge,defaultHome}=require('./manager.cjs');
(async()=>{
  if(process.argv[2]==='stop'){
    console.log(await stopBridge(defaultHome())?'Локальный сервис остановлен.':'Активный сервис этой установки не найден.');return;
  }
  const {config,manifestPath,name}=install(path.resolve(__dirname,'..'),{register:false});
  await ensureBridge(config);
  registerHost(name,manifestPath);
  console.log('Coursera Study Tools подключён к Codex через ChatGPT.');
  console.log('Код вводить не нужно: расширение подключается через локального помощника.');
  console.log('Сервис работает в фоне; кнопку курса можно запускать без этого окна.');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
