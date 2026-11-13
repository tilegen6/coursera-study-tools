const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validateQuiz,codexArguments}=require('../bridge/server.cjs');
const zlib=require('node:zlib');
const asset='https://d3c33hcgiwev3.cloudfront.net/imageAssetProxy.v1/diagram.png?expiry=1&hmac=fixture';
const quiz={url:'https://www.coursera.org/learn/demo/assignment-submission/a/attempt',questions:[{id:1,question:'Which diagram?',type:'radio',options:['a','b'],images:[{url:asset,alt:'Diagram'}]}]};
function crc(data){let value=0xffffffff;for(const byte of data){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^(0xedb88320&-(value&1));}return(value^0xffffffff)>>>0;}
function chunk(name,data){const type=Buffer.from(name),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([head,type,data,tail]);}
const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
test('transparent black diagrams are flattened onto white without changing opaque pixels, for every PNG row filter',()=>{
  const {normalizePNGAlpha}=require('../bridge/quiz-images.cjs');
  const pixels=Buffer.from([0,0,0,255,0,0,0,0,255,0,0,128,10,20,30,255]);
  for(let filter=0;filter<=4;filter++){
    const raw=Buffer.alloc(18),header=Buffer.alloc(13);header.writeUInt32BE(2);header.writeUInt32BE(2,4);header[8]=8;header[9]=6;
    for(let y=0;y<2;y++){raw[y*9]=filter;for(let x=0;x<8;x++){const i=y*8+x,a=x>=4?pixels[i-4]:0,b=y?pixels[i-8]:0,c=y&&x>=4?pixels[i-12]:0,predictor=[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter];raw[y*9+1+x]=(pixels[i]-predictor+256)%256;}}
    const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
    const flattened=normalizePNGAlpha(png);assert.equal(flattened[25],2);
    let data=Buffer.alloc(0);for(let offset=8;offset<flattened.length;){const size=flattened.readUInt32BE(offset);if(flattened.subarray(offset+4,offset+8).toString()==='IDAT')data=Buffer.concat([data,flattened.subarray(offset+8,offset+8+size)]);offset+=12+size;}
    assert.deepEqual([...zlib.inflateSync(data)],[0,0,0,0,255,255,255,0,255,127,127,10,20,30]);
  }
});
test('question image references survive validation, remain question-bound and cannot become arbitrary network requests',()=>{
  assert.deepEqual(validateQuiz(quiz).questions[0].images,quiz.questions[0].images);
  for(const url of ['http://127.0.0.1/x','https://example.com/x','https://user@d3c33hcgiwev3.cloudfront.net/imageAssetProxy.v1/x','https://d3c33hcgiwev3.cloudfront.net:8443/imageAssetProxy.v1/x','https://d3c33hcgiwev3.cloudfront.net/not-an-asset/x'])assert.throws(()=>validateQuiz({...quiz,questions:[{...quiz.questions[0],images:[{url}]}]}));
});
test('alpha normalization rejects excessive dimensions and inflated data before unbounded allocation',()=>{
  const {normalizePNGAlpha}=require('../bridge/quiz-images.cjs'),header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  const png=(h,data)=>Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',zlib.deflateSync(data)),chunk('IEND',Buffer.alloc(0))]);
  const large=Buffer.from(header);large.writeUInt32BE(0xffffffff);assert.throws(()=>normalizePNGAlpha(png(large,Buffer.alloc(5))));
  assert.throws(()=>normalizePNGAlpha(png(header,Buffer.alloc(1024))));
  const interlaced=Buffer.from(header);interlaced[12]=1;assert.throws(()=>normalizePNGAlpha(png(interlaced,Buffer.alloc(5))));
});
test('actual image bytes become private attachments with stable question mapping; redirects, oversized streams and non-images fail closed',async()=>{
  const {downloadQuizImages}=require('../bridge/quiz-images.cjs');
  const root=fs.realpathSync(os.tmpdir()),directory=fs.mkdtempSync(path.join(root,'coursera-image-test-'));
  const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex');
  try{
    let calls=0;
    const reply=async(url,options)=>{calls++;assert.equal(url,asset);assert.equal(options.redirect,'error');return new Response(png,{headers:{'content-type':'image/png'}});};
    const q={...quiz,questions:[quiz.questions[0],{...quiz.questions[0],id:2}]};
    const result=await downloadQuizImages(validateQuiz(q),directory,new AbortController().signal,reply);
    assert.equal(calls,1);assert.equal(result.files.length,1);assert.equal(fs.readFileSync(result.files[0])[25],2);assert.equal(path.dirname(result.files[0]),directory);
    assert.equal(result.questions[0].images[0].attachment,1);assert.equal(result.questions[1].images[0].attachment,1);assert(!JSON.stringify(result.questions).includes('hmac'));
    const args=codexArguments('schema.json','answer.json',result.files);assert.equal(args[args.indexOf('--image')+1],result.files[0]);assert.equal(args.at(-1),'-');
    for(const response of [new Response('text',{headers:{'content-type':'text/html'}}),new Response(png,{status:302,headers:{location:'http://127.0.0.1'}}),new Response(png,{headers:{'content-type':'image/png','content-length':'99999999'}}),new Response(Buffer.alloc(4*1024*1024+1),{headers:{'content-type':'image/png'}})])await assert.rejects(()=>downloadQuizImages(validateQuiz(quiz),directory,new AbortController().signal,async()=>response));
    const controller=new AbortController();controller.abort();await assert.rejects(()=>downloadQuizImages(validateQuiz(quiz),directory,controller.signal,reply));
  }finally{assert.equal(path.dirname(directory),root);fs.rmSync(directory,{recursive:true,force:true});}
});
