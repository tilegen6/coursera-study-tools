const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {defaultHome,HOST_NAME}=require('../bridge/manager.cjs');
const quote=value=>"'"+value.replaceAll("'","''")+"'";
(async()=>{
  assert.equal(process.platform,'win32');
  const powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const who=spawnSync(path.join(process.env.SystemRoot,'System32/whoami.exe'),['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true});assert.equal(who.status,0);const sid=who.stdout.match(/S-1-[\d-]+/)?.[0];assert(sid);
  const outputRoot=path.join(os.homedir(),'.coursera-study-tools');fs.mkdirSync(outputRoot,{recursive:true});
  const output=path.join(outputRoot,'visibility-'+randomUUID()+'.json');
  const childScript=`$ErrorActionPreference='Stop';try{$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}');$manifest='';if($key){$manifest=[string]$key.GetValue('')};$exists=Test-Path -LiteralPath $manifest;$wrapper=$false;if($exists){$data=Get-Content -LiteralPath $manifest -Raw|ConvertFrom-Json;$wrapper=Test-Path -LiteralPath $data.path};$row=@{sameUser=([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value -eq '${sid}');manifest=$manifest;manifestVisible=$exists;wrapperVisible=$wrapper}}catch{$row=@{error=$_.Exception.GetType().Name}};$row|ConvertTo-Json -Compress|Set-Content -LiteralPath ${quote(output)} -Encoding utf8`;
  const encodedChild=Buffer.from(childScript,'utf16le').toString('base64');
  const command=`"${powershell}" -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodedChild}`;
  const parentScript=`$result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${quote(command)}};if($result.ReturnValue -ne 0){exit 1}`;
  const launched=spawnSync(powershell,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(parentScript,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(launched.status,0,'Outside-context diagnostic must start');
  try{
    const deadline=Date.now()+10000;while(!fs.existsSync(output)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
    assert(fs.existsSync(output),'Normal Windows process must publish its diagnostic');const result=JSON.parse(fs.readFileSync(output,'utf8').replace(/^\uFEFF/,''));
    assert.equal(result.sameUser,true);assert.equal(path.resolve(result.manifest).toLowerCase(),path.join(defaultHome(),'native-host.json').toLowerCase());
    assert.equal(result.manifestVisible,true,'Native manifest is invisible outside the Codex process context');assert.equal(result.wrapperVisible,true,'Native wrapper is invisible outside the Codex process context');
    console.log('WINDOWS_VISIBLE_INSTALL_PASSED');
  }finally{assert.equal(path.dirname(output),outputRoot);if(fs.existsSync(output))fs.unlinkSync(output);}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
