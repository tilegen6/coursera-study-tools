'use strict';
const fs=require('node:fs'),path=require('node:path');
const zlib=require('node:zlib');
const MAX_IMAGE=4*1024*1024,MAX_TOTAL=20*1024*1024;
function mediaError(message,temporary=false){return Object.assign(new Error(message),{publicMessage:message,status:temporary?503:422,code:temporary?'SOLVER_TEMPORARY':'QUIZ_MEDIA_UNSUPPORTED'});}
function crc32(data){let value=0xffffffff;for(const byte of data){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^(0xedb88320&-(value&1));}return(value^0xffffffff)>>>0;}
function pngChunk(name,data){const type=Buffer.from(name),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([head,type,data,tail]);}
function normalizePNGAlpha(bytes){
  if(bytes.length<33||bytes.readUInt32BE(8)!==13||bytes.subarray(12,16).toString()!=='IHDR')throw mediaError('Некорректный заголовок PNG.');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),depth=bytes[24],type=bytes[25],compressed=[];let transparency=false,ended=false;
  for(let offset=8;offset+12<=bytes.length;){const size=bytes.readUInt32BE(offset),name=bytes.subarray(offset+4,offset+8).toString();if(size>bytes.length-offset-12)throw mediaError('Повреждённое изображение PNG.');if(name==='IDAT')compressed.push(bytes.subarray(offset+8,offset+8+size));if(name==='tRNS')transparency=true;offset+=size+12;if(name==='IEND'){ended=true;break;}}
  if(!ended||!compressed.length)throw mediaError('Неполное изображение PNG.');
  if(![4,6].includes(type)){if(transparency)throw mediaError('Этот формат прозрачного PNG пока не поддерживается.');return bytes;}
  if(depth!==8||bytes[26]!==0||bytes[27]!==0||bytes[28]!==0||!width||!height||width>8192||height>8192||width*height>12000000)throw mediaError('Формат или размер прозрачного PNG не поддерживается.');
  const channels=type===6?4:2,stride=width*channels,expected=(stride+1)*height;
  let filtered;try{filtered=zlib.inflateSync(Buffer.concat(compressed),{maxOutputLength:expected});}catch{throw mediaError('Не удалось прочитать прозрачное изображение PNG.');}
  if(filtered.length!==expected)throw mediaError('Некорректные пиксели PNG.');
  const pixels=Buffer.alloc(stride*height),output=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++){
    const filter=filtered[y*(stride+1)];if(filter>4)throw mediaError('Неподдерживаемый фильтр PNG.');
    for(let x=0;x<stride;x++){
      const index=y*stride+x,a=x>=channels?pixels[index-channels]:0,b=y?pixels[index-stride]:0,c=y&&x>=channels?pixels[index-stride-channels]:0,p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
      const predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):pa<=pb&&pa<=pc?a:pb<=pc?b:c;
      pixels[index]=(filtered[y*(stride+1)+1+x]+predictor)&255;
    }
    for(let x=0;x<width;x++){const source=y*stride+x*channels,target=y*(width*3+1)+1+x*3,alpha=pixels[source+channels-1];for(let color=0;color<3;color++)output[target+color]=Math.round((pixels[source+(type===6?color:0)]*alpha+255*(255-alpha))/255);}
  }
  const header=Buffer.from(bytes.subarray(16,29));header[9]=2;
  return Buffer.concat([bytes.subarray(0,8),pngChunk('IHDR',header),pngChunk('IDAT',zlib.deflateSync(output)),pngChunk('IEND',Buffer.alloc(0))]);
}
function validateImages(images){
  if(!Array.isArray(images)||images.length>6)throw mediaError('Неподдерживаемое число изображений в вопросе.');
  return images.map(image=>{
    let url;try{url=new URL(image?.url);}catch{throw mediaError('Некорректное изображение вопроса.');}
    if(typeof image.url!=='string'||image.url.length>4096||url.protocol!=='https:'||url.hostname!=='d3c33hcgiwev3.cloudfront.net'||url.port||url.username||url.password||url.hash||!url.pathname.startsWith('/imageAssetProxy.v1/'))throw mediaError('Источник изображения вопроса не поддерживается.');
    if(image.alt!==undefined&&(typeof image.alt!=='string'||image.alt.length>2000))throw mediaError('Некорректная подпись изображения.');
    return {url:url.href,alt:image.alt||''};
  });
}
async function downloadQuizImages(quiz,directory,signal,fetchImage=fetch){
  const files=[],seen=new Map();let total=0;
  const batchSignal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(20000)]);
  const questions=[];
  for(const question of quiz.questions){
    const images=[];
    for(const image of validateImages(question.images||[])){
      batchSignal.throwIfAborted();
      let attachment=seen.get(image.url);
      if(!attachment){
        if(files.length>=20)throw mediaError('В тесте слишком много изображений для одного запроса.');
        let response;try{response=await fetchImage(image.url,{redirect:'error',credentials:'omit',signal:batchSignal});}catch{throw mediaError('Изображение вопроса временно недоступно; проверим тест позже.',true);}
        if(!response.ok)throw mediaError('Изображение вопроса не загрузилось; проверим тест позже.',true);
        const type=response.headers.get('content-type')?.split(';')[0].trim();
        if(!['image/png','image/jpeg','image/webp'].includes(type)||Number(response.headers.get('content-length'))>MAX_IMAGE||!response.body)throw mediaError('Формат или размер изображения вопроса не поддерживается.');
        const reader=response.body.getReader(),chunks=[];let size=0;
        try{while(true){batchSignal.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_IMAGE||total+size>MAX_TOTAL)throw mediaError('Изображения теста превышают допустимый размер.');chunks.push(value);}}
        catch(error){await reader.cancel().catch(()=>{});throw error;}
        const bytes=Buffer.concat(chunks);
        const png=bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255,webp=bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
        if(!(type==='image/png'&&png||type==='image/jpeg'&&jpeg||type==='image/webp'&&webp))throw mediaError('Файл вопроса не является поддерживаемым изображением.');
        const prepared=png?normalizePNGAlpha(bytes):bytes;
        if(prepared.length>MAX_IMAGE||total+Math.max(size,prepared.length)>MAX_TOTAL)throw mediaError('Изображения теста превышают допустимый размер после подготовки.');
        total+=Math.max(size,prepared.length);attachment=files.length+1;
        const file=path.join(directory,`question-image-${attachment}.${png?'png':jpeg?'jpg':'webp'}`);
        fs.writeFileSync(file,prepared,{mode:0o600});files.push(file);seen.set(image.url,attachment);
      }
      images.push({attachment,alt:image.alt});
    }
    questions.push({...question,...(images.length?{images}:{})});
  }
  return {questions,files};
}
module.exports={validateImages,downloadQuizImages,normalizePNGAlpha};
