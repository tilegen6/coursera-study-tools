const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const {defaultHome,readState,checkHealth,readJson}=require('../bridge/manager.cjs');
const home=defaultHome(),runtime=path.join(home,'runtime'),state=readState(home),config=readJson(path.join(runtime,'bridge/native-config.json'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  assert(config&&state,'Install/start the managed helper first');assert(await checkHealth(state),'Managed helper must be authenticated and ready');
  assert.equal(state.build,config.build,'Running helper must use the installed build');
  const source=fs.readFileSync(path.join(__dirname,'../bridge/server.cjs')),installed=fs.readFileSync(config.serverPath);
  assert(source.equals(installed),'Installed helper must match the project source');
  const build=createHash('sha256').update(config.node).update('\0').update(config.codex);
  for(const file of [config.serverPath,path.join(runtime,'bridge/quiz-images.cjs'),path.join(runtime,'bridge/quiz-batches.cjs'),path.join(runtime,'bridge/manager.cjs'),path.join(runtime,'extension/core.js'),path.join(runtime,'extension/assignment-core.js')])build.update('\0').update(fs.readFileSync(file));
  assert.equal(build.digest('hex'),state.build,'Live build must match the current runtime bytes, not a stale configuration');
  const {codexArguments}=require(config.serverPath),tempRoot=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(tempRoot,'coursera-model-check-'));
  let jobId;
  const headers={authorization:`Bearer ${state.token}`,'content-type':'application/json'},base=`http://127.0.0.1:${state.port}`;
  try{
    const schema=path.join(directory,'schema.json'),output=path.join(directory,'answer.json');
    fs.writeFileSync(schema,JSON.stringify({type:'object',additionalProperties:false,required:['ok'],properties:{ok:{type:'boolean'}}}));
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|CODEX_HOME|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)$/i.test(key)));
    const diagnostics=await new Promise((resolve,reject)=>{
      let text='';const child=spawn(config.codex,codexArguments(schema,output),{cwd:directory,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
      const timer=setTimeout(()=>{child.kill();reject(Error('Model verification timed out'));},90000);
      for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{text=(text+data.toString()).slice(-32000);});
      child.once('error',()=>{clearTimeout(timer);reject(Error('Codex verification could not start'));});
      child.once('close',code=>{clearTimeout(timer);code===0?resolve(text):reject(Error('Codex verification failed; no model fallback is allowed'));});
      child.stdin.on('error',()=>{});child.stdin.end('Return only {"ok":true}. Do not use tools.');
    });
    const model=diagnostics.match(/^model:\s*(\S+)\s*$/m)?.[1],effort=diagnostics.match(/^reasoning effort:\s*(\S+)\s*$/m)?.[1];
    assert.equal(model,'gpt-6-sol');assert.equal(effort,'none');assert.equal(JSON.parse(fs.readFileSync(output,'utf8')).ok,true);
    assert(!/unsupported reasoning|fall(?:ing)? back.*(?:model|reasoning)/i.test(diagnostics),'CLI must not silently substitute settings');
    const deadline=Date.now()+90000,quiz={url:'https://www.coursera.org/learn/model-check/quiz/q/title',questions:[{id:1,question:'What is 2 + 2?',type:'radio',options:['3','4','5']}]};
    while(!jobId){
      const response=await fetch(base+'/jobs',{method:'POST',headers,body:JSON.stringify(quiz),signal:AbortSignal.timeout(5000)});
      if(response.status===409&&Date.now()<deadline){await wait(500);continue;}
      assert.equal(response.status,202,'Live helper must accept the synthetic quiz');jobId=(await response.json()).id;
    }
    let result;
    while(Date.now()<deadline){
      const response=await fetch(base+'/jobs/'+jobId,{headers,signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);result=await response.json();
      if(result.status!=='running')break;await wait(300);
    }
    assert.equal(result?.status,'done');assert.deepEqual(result.result.answers[0].choices,[2]);jobId=null;
    const evidence={checkedAt:new Date().toISOString(),model,reasoningEffort:effort,managedReady:await checkHealth(state),pid:state.pid,build:state.build,liveQuizPassed:true};
    assert(evidence.managedReady);fs.mkdirSync(path.join(__dirname,'../output'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../output/model-settings-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
    console.log(`MODEL_SETTINGS_PASSED (model=${model}, reasoning effort=${effort}, installed build verified, live helper quiz passed)`);
  }finally{
    if(jobId)await fetch(base+'/jobs/'+jobId,{method:'DELETE',headers,signal:AbortSignal.timeout(5000)}).catch(()=>{});
    assert.equal(path.dirname(directory),tempRoot);assert(path.basename(directory).startsWith('coursera-model-check-'));fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
