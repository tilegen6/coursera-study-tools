(function(root){
  'use strict';
  function course(value){
    const url=new URL(value),slug=url.pathname.match(/^\/learn\/([a-z0-9][a-z0-9-]{0,199})\//)?.[1];
    if(url.protocol!=='https:'||!['www.coursera.org','coursera.org'].includes(url.hostname)||url.port||url.username||url.password||!slug)throw Error('Недопустимый адрес курса.');
    return {origin:url.origin,slug};
  }
  function lectures(value,links){
    const {origin,slug}=course(value);
    if(!Array.isArray(links)||links.length>10000)throw Error('Слишком много ссылок курса.');
    const ids=new Set(),prefix=`/learn/${slug}/lecture/`;
    for(const link of links){
      try{
        const url=new URL(link,origin);
        if(url.origin!==origin||!url.pathname.startsWith(prefix))continue;
        const id=url.pathname.slice(prefix.length).split('/')[0];
        if(/^[a-zA-Z0-9_-]{1,128}$/.test(id))ids.add(id);
      }catch{}
    }
    if(ids.size>2000)throw Error('Достигнут предел видеоматериалов курса.');
    return [...ids];
  }
  async function complete({url,links,signal,isCurrent=()=>true,request=fetch}){
    const guard=()=>{signal?.throwIfAborted();if(!isCurrent())throw new DOMException('Course changed','AbortError');};
    guard();
    const {origin,slug}=course(url),ids=lectures(url,links),accepted=[];
    if(!ids.length)return {accepted,attempted:0};
    const send=async(path,options)=>{
      guard();
      const deadline=AbortSignal.timeout(10000);
      const response=await request(origin+path,{...options,credentials:'include',signal:signal?AbortSignal.any([signal,deadline]):deadline});
      guard();return response;
    };
    let userId;
    try{
      const response=await send('/api/adminUserPermissions.v1?q=my',{method:'GET',headers:{Accept:'application/json'}});
      if(!response.ok)return {accepted,attempted:0,unsupported:true};
      const raw=await response.text();guard();
      if(raw.length>16384)throw Error('Unexpected identity response');
      const identity=JSON.parse(raw);
      if(identity?.elements?.length!==1)throw Error('Ambiguous identity');
      userId=String(identity.elements[0].id);
      if(!/^\d{1,32}$/.test(userId))throw Error('Invalid identity');
    }catch(error){guard();return {accepted,attempted:0,unsupported:true};}
    let cursor=0,attempted=0,halt=false;
    async function worker(){
      while(!halt&&cursor<ids.length){
        guard();const id=ids[cursor++];attempted++;
        try{
          // An accepted ended event is not yet a verified course completion.
          const response=await send(`/api/opencourse.v1/user/${userId}/course/${slug}/item/${id}/lecture/videoEvents/ended?autoEnroll=false`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contentRequestBody:{}})});
          if(response.ok)accepted.push(id);else halt=true;
        }catch(error){guard();halt=true;}
      }
    }
    await Promise.all(Array.from({length:Math.min(8,ids.length)},worker));
    guard();return {accepted,attempted,unsupported:halt};
  }
  const api={lectures,complete};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.CourseraFastVideos=api;
})(globalThis);
