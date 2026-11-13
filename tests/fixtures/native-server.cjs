const {runManaged}=require('../../bridge/manager.cjs');
const {createBridge}=require('../../bridge/server.cjs');
runManaged({home:process.argv[3],port:Number(process.argv[4]),build:process.argv[5],createServer:options=>createBridge({...options,solve:async task=>({status:'solved',answers:task.questions.map(question=>({id:question.id,choices:[2],text:''}))})})}).catch(error=>{console.error(error);process.exitCode=1;});
