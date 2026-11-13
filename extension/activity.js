(function(root){
  'use strict';
  function watch(callback,document=root.document,Observer=root.MutationObserver){
    let active=true,queued=false;
    const wake=()=>{
      if(!active||queued)return;queued=true;
      queueMicrotask(()=>{queued=false;if(active)callback();});
    };
    const events=['loadedmetadata','durationchange','loadeddata','canplay','progress','seeked','ended','timeupdate','visibilitychange','input','change'];
    for(const event of events)document.addEventListener(event,wake,true);
    const observer=new Observer(wake);
    observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['aria-label','aria-disabled','aria-expanded','class','disabled','hidden','data-testid','data-test','src']});
    return ()=>{active=false;observer.disconnect();for(const event of events)document.removeEventListener(event,wake,true);};
  }
  function until(predicate,{signal,timeout=2000,document=root.document,Observer=root.MutationObserver}={}){
    signal?.throwIfAborted();if(predicate())return Promise.resolve(true);
    return new Promise((resolve,reject)=>{
      const observer=new Observer(check),timer=setTimeout(()=>finish(false),timeout);
      function finish(ready,error){observer.disconnect();clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(ready);}
      function abort(){finish(false,new DOMException('Aborted','AbortError'));}
      function check(){if(predicate())finish(true);}
      observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true});
      signal?.addEventListener('abort',abort,{once:true});check();
    });
  }
  const api={watch,until};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.CourseraActivity=api;
})(globalThis);
