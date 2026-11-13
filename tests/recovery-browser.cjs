require('./native-browser.cjs').run({recover:true,missingPermission:true}).catch(error=>{console.error(error);process.exitCode=1;});
