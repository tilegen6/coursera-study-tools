const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const core=require('../extension/core.js');

async function popup(queue=[]){
  class Element{
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.value='';this.open=false;this.classList={toggle(){},remove(){}};}
    set textContent(value){this.text=String(value);this.children=[];}
    get textContent(){return (this.text||'')+this.children.map(child=>child.textContent).join('');}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.text='';this.children=children;}
    closest(selector){return selector==='details'?this.details:null;}
    addEventListener(){}
  }
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const details=new Element('details');get('queue-items').details=details;
  let poll;
  const state={url:'https://www.coursera.org/learn/demo/supplement/a/title',title:'Reading',kind:'reading',running:false,solving:false,courseRunning:true,hasVideo:false,message:'Waiting',logs:[],course:{phase:'waiting',count:1,pending:0,needsInput:queue.length,queue}};
  const context={URL,Date,CourseraStudy:core,document:{getElementById:get,querySelectorAll:()=>[],createElement:tag=>new Element(tag),createTextNode:text=>({textContent:String(text)})},setInterval:callback=>{poll=callback;},chrome:{
    storage:{local:{get:async()=>({settings:{speed:2},fastCourseDefaults:true})}},
    tabs:{query:async()=>[{id:7,url:state.url}],sendMessage:async()=>({ok:true,data:structuredClone(state)})},
    runtime:{getManifest:()=>({version:'test'}),sendMessage:async()=>({ok:true,data:{running:false}})}
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/popup.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  return {get,details,state,refresh:()=>poll()};
}

test('restored queue shows task titles, reasons and only safe current-course links',async()=>{
  const entries=[
    {title:'Week 1 <img src=x>',url:'https://www.coursera.org/learn/demo/quiz/q/title'},
    {title:'Script',url:'javascript:alert(1)'},
    {title:'Other site',url:'https://www.coursera.org.evil.test/learn/demo/quiz/q/title'},
    {title:'Other course',url:'https://www.coursera.org/learn/other/quiz/q/title'},
    {title:'Credentials',url:'https://name:password@www.coursera.org/learn/demo/quiz/q/title'},
    {title:'HTTP',url:'http://www.coursera.org/learn/demo/quiz/q/title'}
  ].map(entry=>({...entry,status:'needs_input',reason:'Нужен ответ'}));
  const ui=await popup(entries),items=ui.get('queue-items').children;
  assert.equal(ui.details.open,true);
  assert.equal(items.length,entries.length);
  assert.equal(items[0].children[0].tagName,'A');
  assert.equal(items[0].children[0].href,entries[0].url);
  assert.equal(items[0].children[0].textContent,entries[0].title);
  assert.equal(items[0].children[0].target,'_blank');
  assert.equal(items[0].children[0].rel,'noopener noreferrer');
  for(let i=0;i<items.length;i++){
    assert(items[i].textContent.includes(entries[i].title));assert(items[i].textContent.includes('Нужен ответ'));
    if(i)assert.notEqual(items[i].children[0].tagName,'A');
  }
});

test('the perfect-score option defaults on and is locked during an active run',async()=>{
  const ui=await popup();assert.equal(ui.get('target-100').checked,true);assert.equal(ui.get('target-100').disabled,true);
  ui.state.courseRunning=false;await ui.refresh();assert.equal(ui.get('target-100').disabled,false);
});

test('queue opens once when items appear and later polling respects manual closure',async()=>{
  const ui=await popup();assert.equal(ui.details.open,false);
  ui.state.course.queue=[{title:'Quiz',url:'https://www.coursera.org/learn/demo/quiz/q/title',status:'pending_grade',reason:'Ожидается оценка'}];
  ui.state.course.pending=1;await ui.refresh();assert.equal(ui.details.open,true);
  ui.details.open=false;ui.state.course.queue[0].reason='Проверка позже';await ui.refresh();
  assert.equal(ui.details.open,false);assert(ui.get('queue-items').textContent.includes('Проверка позже'));
});
