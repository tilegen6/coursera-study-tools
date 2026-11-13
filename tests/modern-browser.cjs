const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createBridge, PORT } = require('../bridge/server.cjs');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'coursera-modern-'));
const extension = path.join(profile,'extension');
const token = 'a'.repeat(64);
let solves = 0;
const events = {};
// Structural regression from authenticated Coursera inspection, 2026-10-26.
// Question text and identities are synthetic; no account data is retained.
function fixture(url) {
  const course = url.pathname.split('/')[2], base = `/learn/${course}`;
  if(course.startsWith('outline-'))return `<main><h2 id="module">Module 1</h2><button id="module-nav" onclick="history.pushState({},'', '${base}/home/module/2');${course==='outline-updated'?"document.getElementById('module').textContent='Module 2';":''}">Open module 2</button></main>`;
  const report = event => `fetch('/__event?name=${course}:${event}',{method:'POST'})`;
  const survey=course==='survey'?`<div role="dialog" id="pendo-guide-container"><p>How satisfied are you with translations?</p><div id="pendo-text-b0c2f015"> </div><div role="group" aria-labelledby="pendo-text-b0c2f015"><label><input type="radio" name="survey" onchange="${report('survey-change')}">Satisfied</label><label><input type="radio" name="survey" onchange="${report('survey-change')}">Dissatisfied</label></div><label>Feedback<textarea></textarea></label><button onclick="${report('survey-submit')}">Submit</button></div>`:'';
  const next = `${base}/supplement/final/end`;
  const confirmation=`<div role="${course==='alert'?'alertdialog':'dialog'}"><h2>${course==='alert'?'Готовы отправлять?':'Submit answers?'}</h2>${course==='confirm-honor'?'<input data-testid="honor-code-legal-name-input" value="Test Learner">':''}<button id="confirm">${course==='alert'?'Отправить':'Submit answers'}</button></div>`;
  const confirmationTarget=course==='alert'?"document.getElementById('submit').closest('[role=dialog]')":"document.body";
  if (url.pathname.includes('/home/')) return '<h1 data-testid="course-completed">Course completed</h1>';
  if (url.pathname.includes('/supplement/')) return `<div id="main-container"><h1>Чтение</h1><button onclick="this.outerHTML='<h3 aria-label=&quot;Чтение завершено&quot;>Пройденные</h3>'">Пометить как выполненное</button><button aria-label="Перейти к следующему пункту" onclick="location.href='${url.pathname.includes('/final/') ? base + '/home/completed' : base + '/assignment-submission/work/title'}'">Перейти к следующему пункту</button></div>`;
  if (!url.pathname.endsWith('/attempt')) return survey+(course==='delayed-cover'?`<div id="main-container"><h1>Практический тест</h1><script type="application/json">${'translations '.repeat(10000)}</script><div id="cover"></div><a href="${next}">Материал курса</a></div><script>setTimeout(()=>{const cover=document.getElementById('cover');cover.innerHTML='<article data-testid="assignment-cover-redesign"><button>Возобновить задание</button></article>';cover.querySelector('button').onclick=()=>{location.href='${url.pathname}/attempt';};},400);</script>`:`<div id="main-container"><article data-testid="assignment-cover-redesign"><h1>Практический тест</h1><button onclick="location.href='${url.pathname}/attempt'">Возобновить задание</button></article><a href="${next}">Материал курса</a></div>`);
  return `${survey}<div id="main-container"><h1>Обложка</h1>${course==='collapsed'?`<aside data-testid="left-nav"><h3><button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.getElementById('module-two').hidden=false"><span data-testid="module-number-heading">Модуль 2</span></button></h3><div id="module-two" hidden><a href="${next}">Материал курса</a></div></aside>`:`<a href="${next}">Материал курса</a>`}</div>
    <div role="dialog" aria-label="Chatpanel"></div>
    <div role="dialog" aria-labelledby="title"><h1 id="title">Практический тест</h1>
      <div data-testid="legend"><h3 aria-hidden="true">1.</h3><div id="prompt-auto~one">Which value is even?</div></div>
      <div role="${['checkbox','text'].includes(course)?'group':'radiogroup'}" aria-labelledby="prompt-auto~one">${course==='text'?'<textarea></textarea>':`<label><input type="${course==='checkbox'?'checkbox':'radio'}" name="one">Three</label><label><input type="${course==='checkbox'?'checkbox':'radio'}" name="one">Four</label>`}</div>
      ${['honor','collapsed'].includes(course) ? '<h3>Кодекс чести Coursera</h3><label>Полное имя<input data-testid="honor-code-legal-name-input" required value="Test Learner"></label>' : ''}
      <button id="submit" ${course==='delayed-submit'?'disabled':''}>Отправить</button>
    </div><script>document.getElementById('submit').onclick=()=>{${report('submit')};${confirmationTarget}.insertAdjacentHTML('beforeend',${JSON.stringify(confirmation)});document.getElementById('confirm').onclick=()=>{${report('confirm')};document.body.innerHTML='<div id="main-container"><h2>You passed!</h2><a href="${next}">Next lesson</a></div>';history.pushState({},'', '${base}/assignment-submission/work/title/result');}};${course==='late'?`document.querySelectorAll('input[type=radio]').forEach(input=>input.onchange=()=>{if(!document.querySelector('[data-testid="honor-code-legal-name-input"]'))input.parentElement.parentElement.insertAdjacentHTML('afterend','<input data-testid="honor-code-legal-name-input" value="Test Learner">')});`:''}</script>`;
}
(async () => {
  let server, context;
  try {
    server = createBridge({ token, solve: async task => {
      solves++;
      assert.equal(task.questions[0].question, 'Which value is even?');
      assert.deepEqual(task.questions[0].options, task.questions[0].type==='text'?[]:['Three', 'Four']);
      return { status: 'solved', answers: [{ id: 1, choices: task.questions[0].type==='text'?[]:[2], text: task.questions[0].type==='text'?'42':'' }] };
    } });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    fs.cpSync(path.join(root,'extension'),extension,{recursive:true});const worker=path.join(extension,'background.js');fs.writeFileSync(worker,fs.readFileSync(worker,'utf8').replace('http://127.0.0.1:43179',`http://127.0.0.1:${server.address().port}`));
    context = await chromium.launchPersistentContext(path.join(profile,'browser'), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    await context.route('https://www.coursera.org/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__event') { const key = url.searchParams.get('name'); events[key] = (events[key] || 0) + 1; return route.fulfill({body:'{}'}); }
      return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8">'+fixture(url)});
    });
    const manage = await context.newPage();
    await manage.goto('chrome://extensions/');
    const item = manage.locator('extensions-item').filter({hasText:'Coursera Study Tools'});
    await item.waitFor();
    const id = await item.getAttribute('id');
    const page = await context.newPage();
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.evaluate(token => chrome.storage.local.set({bridgeToken:token}), token);
    async function command(action,settings={speed:2}) {
      return popup.evaluate(async ({action,settings}) => {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) try {
          const status = await chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action:'status'});
          if(status?.ok) return chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action,data:settings});
        } catch {}
      }, {action,settings});
    }
    for(const course of ['outline-updated','outline-stale']){
      const scope=`https://www.coursera.org/learn/${course}/`,url=scope+'quiz/waiting/title';
      await page.goto(scope+'home/module/1');
      await popup.evaluate(({scope,url})=>chrome.storage.local.set({[`checkpoint:${scope}`]:{scope,accountHint:'',progress:{item:null,phase:'waiting',visited:[],submitted:[],pages:[],queue:[{key:scope+'quiz/waiting',url,status:'pending_grade',nextCheckAt:Date.now()+3600000}]}}}),{scope,url});
      assert.equal((await command('courseStart',{speed:2,resumeQueue:true})).ok,true);
      await page.locator('#module-nav').click();
      await page.waitForTimeout(27000);
      const state=(await command('status')).data;
      assert.equal(state.courseRunning,course==='outline-updated',`${course}: ${state.message}`);
      await command('stop');
    }
    await page.goto('https://www.coursera.org/learn/modern/supplement/read/intro');
    assert.equal((await command('courseStart')).ok,true);
    await page.waitForURL('**/learn/modern/home/completed',{timeout:30000}).catch(async error => { console.error('MODERN_DEBUG', page.url(), JSON.stringify(await command('status')), await page.locator('body').innerText()); throw error; });
    assert.equal(events['modern:submit'],1);
    assert.equal(events['modern:confirm'],1);
    assert.equal(solves,1);
    await command('stop');
    await page.goto('https://www.coursera.org/learn/delayed-cover/assignment-submission/work/title');
    assert.equal((await command('courseStart')).ok,true);
    await page.waitForURL('**/learn/delayed-cover/home/completed',{timeout:15000}).catch(async error=>{console.error('DELAYED_COVER_DEBUG',page.url(),JSON.stringify(await command('status')));throw error;});
    assert.equal(events['delayed-cover:submit'],1);assert.equal(events['delayed-cover:confirm'],1);await command('stop');
    await page.goto('https://www.coursera.org/learn/survey/assignment-submission/work/title');
    const surveySolves=solves;assert.equal((await command('courseStart')).ok,true);
    await page.waitForURL('**/learn/survey/home/completed',{timeout:15000});
    assert.equal(events['survey:submit'],1);assert.equal(events['survey:confirm'],1);
    assert.equal(events['survey:survey-submit']||0,0);assert.equal(events['survey:survey-change']||0,0);
    assert.equal(solves,surveySolves+1);await command('stop');
    for(const course of ['checkbox','text','alert','delayed-submit']) {
      await page.goto(`https://www.coursera.org/learn/${course}/assignment-submission/work/title/attempt`);
      const exported = await command('quizExport');
      assert.equal(exported.ok,true);
      assert.equal(exported.data.questions[0].type,['alert','delayed-submit'].includes(course)?'radio':course);
      if(course==='delayed-submit')await page.evaluate(()=>document.querySelectorAll('input[type=radio]').forEach(input=>input.addEventListener('change',()=>setTimeout(()=>{document.getElementById('submit').disabled=false;},1200))));
      const previousSolves=solves;
      assert.equal((await command('courseStart')).ok,true);
      await page.waitForURL(`**/learn/${course}/home/completed`,{timeout:course==='alert'?8000:30000});
      assert.equal(events[`${course}:submit`],1);
      assert.equal(events[`${course}:confirm`],1);
      assert.equal(solves,previousSolves+1,'waiting for the submit button must not call the solver again');
      await command('stop');
    }
    for(const course of ['honor','late','confirm-honor','collapsed']) {
    const previousSolves=solves;
    await page.goto(`https://www.coursera.org/learn/${course}/assignment-submission/work/title/attempt`);
    const exported = await command('quizExport');
    assert.equal(exported.ok,true);
    assert.equal(exported.data.questions.length,1);
    assert.equal(exported.data.questions[0].question,'Which value is even?');
    assert.equal((await command('courseStart')).ok,true);
    await page.waitForURL(`**/learn/${course}/home/completed`,{timeout:30000});
    await new Promise(resolve=>setTimeout(resolve,1000));
    const status = (await command('status')).data;
    assert.equal(status.courseRunning,true);
    assert.equal(status.course.needsInput,1);
    assert.match(status.course.queue[0].reason,/подтверждени/);
    assert.equal(events[`${course}:submit`]||0,course==='confirm-honor'?1:0);
    assert.equal(events[`${course}:confirm`]||0,0);
    assert.equal(solves,previousSolves+(['honor','collapsed'].includes(course)?0:1));
    await command('stop');
    }
    console.log('MODERN_BROWSER_PASSED (h2 SPA navigation and stale-content guard, ARIA prompts, Pendo survey excluded, delayed submit once, modern routes, Russian reading, confirmation queue)');
  } finally {
    if(context) await context.close();
    if(server) await new Promise(resolve=>server.close(resolve));
    assert.equal(path.dirname(profile),path.resolve(os.tmpdir()));
    assert.equal(path.basename(profile).startsWith('coursera-modern-'),true);
    fs.rmSync(profile,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
