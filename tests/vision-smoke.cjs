const assert=require('node:assert/strict'),zlib=require('node:zlib');
const {solveCodex,validateQuiz,makeAnswers}=require('../bridge/server.cjs');
function crc(data){let c=0xffffffff;for(const byte of data){c^=byte;for(let n=0;n<8;n++)c=(c>>>1)^(0xedb88320&-(c&1));}return(c^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([head,name,data,tail]);}
function diagram(){const width=320,height=160,raw=Buffer.alloc(height*(1+width*3));for(let y=0;y<height;y++){const offset=y*(1+width*3);for(let x=0;x<width;x++){const i=offset+1+x*3;raw[i]=x<width/2?240:0;raw[i+1]=0;raw[i+2]=x<width/2?0:240;}}const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
(async()=>{
 const quiz=validateQuiz({url:'https://www.coursera.org/learn/vision-fixture/quiz/q/title',questions:[{id:1,question:'Look at the attached image. Which half is blue?',type:'radio',options:['Left half','Right half'],images:[{url:'https://d3c33hcgiwev3.cloudfront.net/imageAssetProxy.v1/synthetic.png',alt:''}]}]});
 const output=await solveCodex(quiz,new AbortController().signal,process.env.CODEX_BINARY||'codex',async()=>new Response(diagram(),{headers:{'content-type':'image/png'}}));
 const result=makeAnswers(output,quiz.questions);assert.deepEqual(result.answers[0].choices,[2]);
 console.log('VISION_SOLVER_PASSED (real ChatGPT-authenticated gpt-6-sol, none, attached synthetic diagram, no real assessment submitted)');
})().catch(error=>{console.error(error.publicMessage||error.message);process.exitCode=1;});
