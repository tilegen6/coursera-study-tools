const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createBridge, PORT } = require('../bridge/server.cjs');

(async () => {
  assert.equal(process.platform, 'win32', 'This launcher check requires Windows PowerShell.');
  const server = createBridge({token:'c'.repeat(64)});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(PORT,'127.0.0.1',resolve);});
  try {
    const result = await new Promise((resolve,reject)=>{
      const child = spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve(__dirname,'../Start-Bridge.ps1')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      let output='';
      const timer=setTimeout(()=>{child.kill();reject(new Error('Launcher failed to exit after port collision'));},20000);
      for(const stream of [child.stdout,child.stderr])stream.on('data',data=>output+=data.toString());
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',code=>{clearTimeout(timer);resolve({code,output});});
    });
    assert.equal(result.code,1,'Node failure must propagate through PowerShell');
    // Windows console encoding varies; the port is an independent stable marker.
    assert.match(result.output,/43179/);
    console.log('LAUNCHER_PASSED (occupied port propagates nonzero exit through Windows PowerShell)');
  } finally { await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
