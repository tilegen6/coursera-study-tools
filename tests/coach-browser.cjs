const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createBridge}=require('../bridge/server.cjs'),{extensionId}=require('../bridge/install-native.cjs');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'coursera-coach-')),extension=path.join(temporary,'extension'),token='8'.repeat(64);
let server,context,solves=0;const events=new Map(),records=new Map();
const record=course=>{if(!records.has(course))records.set(course,{turns:0,started:false,finished:false});return records.get(course);};
function fixture(url){
  const course=url.pathname.split('/')[2],base=`/learn/${course}/`,state=record(course);
  if(url.pathname.includes('/home/'))return '<main><h1 data-testid="course-completed">Course completed</h1></main>';
  if(url.pathname.includes('/supplement/'))return `<main><h1>Reading</h1><button onclick="this.outerHTML='<button disabled>Completed</button>'">Mark as complete</button><a href="${base}home/completed">Next lesson</a></main>`;
  return `<main><div data-testid="dialogue-content"><div data-testid="tunnel-vision-header"><h1>Practice dialogue</h1><button aria-label="Нет прогресса">Нет прогресса</button><button id="finish">Завершить диалог</button></div><div data-testid="coursera-coach-item"><div role="log" data-testid="ai-coach-chat-messages" id="messages"></div><button id="open">Начать диалог</button><div id="composer" hidden><textarea aria-label="Отправить сообщение" maxlength="7999"></textarea><button data-testid="coach-send-message-button" aria-label="Отправить сообщение">Send</button></div></div></div></main><script>
    let turns=${state.turns},started=${state.started},finished=${state.finished};const messages=document.getElementById('messages'),field=document.querySelector('textarea'),send=document.querySelector('[data-testid="coach-send-message-button"]');
    const event=async name=>fetch('/__event?course=${course}&name='+name,{method:'POST'});
    const prompt=()=>turns>=2?'This dialogue is complete. End dialogue to view your results.':'${course}'==='badfinish'?'Why should we not end dialogue before answering the exercise?':turns===1?'How would you use below(reference) to locate the input?':'Why can dynamic IDs make traditional locators unreliable?';
    function assistant(text){messages.insertAdjacentHTML('beforeend','<div data-testid="chat-message-llm"><div data-testid="coach-message-markdown"></div></div>');messages.lastElementChild.querySelector('div').textContent=text;if(!turns)messages.lastElementChild.insertAdjacentHTML('beforeend','<h2>Course completed</h2>');}
    function active(){document.getElementById('open').hidden=true;document.getElementById('composer').hidden=false;assistant(prompt());}
    document.getElementById('open').onclick=async()=>{await event('start');started=true;active();};if(started)active();
    send.onclick=async()=>{if(!field.value.trim())throw Error('Empty message');field.disabled=true;send.disabled=true;const user=document.createElement('div');user.dataset.testid='chat-message-user';user.textContent=field.value;messages.append(user);field.value='';await event('reply');turns++;assistant('Thinking...');setTimeout(()=>{if('${course}'==='auto'&&turns>=2){document.querySelector('main').innerHTML='<p>Диалог окончен. Начните новый чат, чтобы очистить историю.</p><button>Повторить попытку</button><a href="${base}supplement/last/title">Next lesson</a>';return;}messages.lastElementChild.querySelector('div').textContent=prompt();field.disabled=false;send.disabled=false;},350);};
    document.getElementById('finish').onclick=async()=>{await event(turns>=2?'finish':'early-finish');if(turns<2)return;document.querySelector('main').innerHTML='<h2 data-testid="dialogue-completed">Dialogue completed</h2><a href="${base}supplement/last/title">Next lesson</a>';};
  </script>`;
}
(async()=>{
  try{
    server=createBridge({token,solve:async(task,signal)=>{
      solves++;assert.equal(task.kind,'assignment');assert.equal(task.type,'generic');assert(task.fields.some(field=>field.id==='coach:reply'));
      if(task.url.includes('/stop/'))await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));
      const finish=task.url.includes('/badfinish/')||task.instructions.includes('This dialogue is complete. End dialogue');
      return {status:'ready',reason:'',values:[{id:'coach:action',choices:[finish?2:1],text:'',files:[]},{id:'coach:reply',choices:[],text:finish?'':'Use a stable reference element and below(reference), with an explicit wait.',files:[]}]};
    }});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    // A previously loaded worker may not know the new non-sensitive preferences action yet.
    fs.cpSync(path.join(root,'extension'),extension,{recursive:true});const file=path.join(extension,'background.js');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('http://127.0.0.1:43179',`http://127.0.0.1:${server.address().port}`).replace("request.action==='preferences'","request.action==='preferences-not-supported'").replace('async function handleCourse(request, sender) {',"async function handleCourse(request, sender) { if(request.action==='preferences'&&sender.url.includes('/late-start/'))await new Promise(resolve=>setTimeout(resolve,400));"));
    context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    await context.route('https://www.coursera.org/**',async route=>{const url=new URL(route.request().url());if(url.pathname==='/__event'){const course=url.searchParams.get('course'),name=url.searchParams.get('name'),key=course+':'+name;events.set(key,(events.get(key)||0)+1);if(name==='reply')record(course).turns++;if(name==='start')record(course).started=true;if(name==='finish')record(course).finished=true;return route.fulfill({body:'{}'});}if(url.pathname.includes('/slow/supplement/'))await new Promise(resolve=>setTimeout(resolve,18000));return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8">'+fixture(url)});});
    const popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId(extension)}/popup.html`);await popup.evaluate(token=>chrome.storage.local.set({bridgeToken:token}),token);await popup.close();
    const page=await context.newPage();await page.goto('https://www.coursera.org/learn/success/coach/c/title');
    const start=page.getByRole('button',{name:'Запустить курс',exact:true});await start.waitFor({timeout:6000});
    await page.evaluate(()=>document.querySelector('#coursera-study-launcher').shadowRoot.querySelector('button').click());await page.waitForTimeout(250);assert.equal(events.get('success:start')||0,0);assert.equal(solves,0);
    await start.click();const firstDeadline=Date.now()+10000;while(!events.get('success:reply')&&Date.now()<firstDeadline)await page.waitForTimeout(75);assert.equal(events.get('success:reply'),1,JSON.stringify({status:await page.evaluate(()=>document.querySelector('#coursera-study-launcher')?.shadowRoot.querySelector('[role="status"]')?.textContent),events:Object.fromEntries(events),solves}));await page.reload();
    await page.waitForURL('**/success/home/completed',{timeout:25000}).catch(async error=>{console.error('COACH_DEBUG',page.url(),await page.locator('body').innerText(),await page.evaluate(()=>document.querySelector('#coursera-study-launcher')?.shadowRoot.textContent),Object.fromEntries(events),solves);throw error;});
    assert.equal(events.get('success:start'),1);assert.equal(events.get('success:reply'),2);assert.equal(events.get('success:finish'),1);assert.equal(events.get('success:early-finish')||0,0);
    await page.waitForFunction(()=>document.querySelector('#coursera-study-launcher').shadowRoot.textContent.includes('Курс завершён'));
    await page.goto('https://www.coursera.org/learn/auto/coach/c/title');await page.getByRole('button',{name:'Запустить курс',exact:true}).click();await page.waitForURL('**/auto/home/completed',{timeout:20000});assert.equal(events.get('auto:reply'),2);assert.equal(events.get('auto:finish')||0,0);
    await page.goto('https://www.coursera.org/learn/slow/coach/c/title');await page.getByRole('button',{name:'Запустить курс',exact:true}).click();
    await page.waitForURL('**/slow/home/completed',{timeout:40000}).catch(async error=>{console.error('SLOW_NAVIGATION_STATUS',page.url(),await page.locator('#coursera-study-launcher').innerText());throw error;});
    assert.equal(events.get('slow:start'),1);assert.equal(events.get('slow:reply'),2);assert.equal(events.get('slow:finish'),1);
    await page.goto('https://www.coursera.org/learn/badfinish/coach/c/title');await page.getByRole('button',{name:'Запустить курс',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#coursera-study-launcher').shadowRoot.textContent.includes('не подтвердил завершение'));
    assert.equal(events.get('badfinish:finish')||0,0);assert.equal(events.get('badfinish:early-finish')||0,0);
    await page.getByRole('button',{name:'Стоп',exact:true}).click();
    await page.goto('https://www.coursera.org/learn/late-start/coach/c/title');await page.getByRole('button',{name:'Запустить курс',exact:true}).click();await page.getByRole('button',{name:'Стоп',exact:true}).click();await page.waitForTimeout(700);assert.equal(events.get('late-start:start')||0,0);
    await page.goto('https://www.coursera.org/learn/stop/coach/c/title');const before=solves;await page.getByRole('button',{name:'Запустить курс',exact:true}).click();
    while(solves===before)await page.waitForTimeout(100);await page.getByRole('button',{name:'Стоп',exact:true}).click();await page.waitForTimeout(500);assert.equal(events.get('stop:reply')||0,0);
    await page.reload();await page.waitForTimeout(300);assert.equal(events.get('stop:reply')||0,0);
    console.log('COACH_BROWSER_PASSED (trusted in-page launch, observed Coach markup, two replies, streaming, no early finish, stop/reload)');
  }finally{if(context)await context.close();if(server)await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(temporary),fs.realpathSync(os.tmpdir()));assert(path.basename(temporary).startsWith('coursera-coach-'));fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
