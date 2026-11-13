'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {readJson,ensureBridge}=require('./manager.cjs');
const LIMIT=4096;
function encode(value){const body=Buffer.from(JSON.stringify(value));if(body.length>LIMIT)throw Error('Oversized native response');const prefix=Buffer.alloc(4);prefix.writeUInt32LE(body.length);return Buffer.concat([prefix,body]);}
async function connect(request,origin,config){
  if(!config?.allowedOrigins?.includes(origin))throw Error('Недопустимый источник подключения.');
  if(request?.action!=='connect' || request.version!==1 || Object.keys(request).some(key=>!['action','version'].includes(key)))throw Error('Неизвестная команда подключения.');
  const state=await ensureBridge(config);
  return {ok:true,version:1,token:state.token};
}
async function main(){
  const config=readJson(path.join(__dirname,'native-config.json'));
  const origin=process.argv[2];
  // Validate before reading input or touching bridge state. Parent-window is not an instruction.
  if(!config?.allowedOrigins?.includes(origin)){process.stdout.write(encode({ok:false,error:'Недопустимый источник подключения.'}));return;}
  let buffer=Buffer.alloc(0),finished=false;
  const finish=async error=>{
    if(finished)return;finished=true;process.stdin.pause();
    let response;
    try {if(error)throw error;response=await connect(JSON.parse(buffer.subarray(4).toString('utf8')),origin,config);}
    catch(failure){response={ok:false,error:failure.message||'Ошибка подключения.'};}
    process.stdout.write(encode(response),()=>process.exit(0));
  };
  const timer=setTimeout(()=>void finish(Error('Время подключения истекло.')),15000);timer.unref();
  process.stdin.on('data',chunk=>{
    if(finished)return;
    buffer=Buffer.concat([buffer,chunk]);
    if(buffer.length>LIMIT+4)return void finish(Error('Слишком большое сообщение.'));
    if(buffer.length<4)return;
    const size=buffer.readUInt32LE(0);
    if(!size||size>LIMIT)return void finish(Error('Некорректная длина сообщения.'));
    if(buffer.length>size+4)return void finish(Error('Допускается одна команда подключения.'));
    if(buffer.length===size+4)void finish();
  });
  process.stdin.on('end',()=>{if(!finished)void finish(Error('Неполное сообщение подключения.'));});
  process.stdin.on('error',()=>void finish(Error('Канал подключения закрыт.')));
}
if(require.main===module)main().catch(()=>{process.stdout.write(encode({ok:false,error:'Ошибка локального подключения.'}));process.exitCode=1;});
module.exports={encode,connect};
