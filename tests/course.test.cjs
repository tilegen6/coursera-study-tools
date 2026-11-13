const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const core = require('../extension/core.js');

function harness({ pauseStart = false, pausePhase = null, video = null, modules = [], itemPath = null, progress = {}, links = [], terminal=false, resumeError=null, clock=null, navigationPending=()=>false } = {}) {
  let stored = null, clickCount = 0, seeks = 0, reloads = 0, interval, release, reached, change, done=false;
  const ready = new Promise(resolve => reached = resolve);
  const paused = new Promise(resolve => release = resolve);
  const url = `https://www.coursera.org/learn/demo/${itemPath || (video ? 'lecture/video/title' : 'supplement/read/title')}`;
  const chrome = { runtime: { sendMessage: async request => {
    if (request.action === 'start') {
      const record = { id: request.data.runId, scope: 'https://www.coursera.org/learn/demo/', settings: { speed: 2, skipVideo: true, ...request.data.settings }, progress: { item: core.itemKey(url), phase: 'lesson', visited: [], submitted: [], pages: [], actionAt: Date.now(), ...progress } };
      stored = record;
      if (pauseStart) { reached(); await paused; }
      return { ok: true, data: record };
    }
    if (request.action === 'resume') return resumeError?{ok:false,error:resumeError}:{ ok: true, data: stored };
    if (request.action === 'navigation') return {ok:true,data:navigationPending()};
    if (request.action === 'stop') { if (stored?.id === request.data.runId) stored = null; return { ok: true, data: null }; }
    if (request.action === 'save') {
      if (stored?.id !== request.data.runId) return { ok: false, error: 'Stopped' };
      stored.progress = request.data.progress;
      if (request.data.progress.phase === pausePhase) { reached(); await paused; }
      return { ok: true, data: stored };
    }
    throw new Error('Unexpected request');
  } } };
  const context = { CourseraStudy: core, CourseraQueue: require('../extension/queue.js'), chrome, location: { href: url, pathname: new URL(url).pathname, reload: () => reloads++ }, document: { querySelectorAll: selector => selector.includes('button[aria-expanded="false"]') ? modules.filter(module => !module.expanded) : selector.includes('a[href]') ? links : [], querySelector: selector => selector === 'video' ? video : null }, crypto: webcrypto, TextEncoder, URL, Uint8Array, queueMicrotask, setInterval: callback => { interval = callback; return 1; }, clearInterval: () => {} };
  if(clock)context.Date={now:()=>clock.now};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/course.js'), 'utf8'), context);
  const button = { isConnected: true, click: () => clickCount++ };
  const nextButton={isConnected:true,href:'https://www.coursera.org/learn/demo/supplement/next/title',click:()=>clickCount++};
  const adapter = { scope: () => ({ querySelectorAll: selector => terminal&&selector.includes('course-completed')?[{}]:[] }), completed: () => done, completeButton: () => button, nextButton:()=>nextButton, watch:callback=>{change=callback;return()=>{change=null;};}, enabled: element => !element.hidden, label: element => element?.getAttribute?.('aria-label') || element?.textContent || '', cancel: () => {}, log: () => {}, visible: element => !element?.hidden, finishVideo: () => { if(!video.seekable.length) throw new Error('Not seekable yet'); seeks++; } };
  return { adapter, create: () => context.CourseraCourse.create(adapter), ready, release, stored: () => stored, url: () => context.location.href, route:value=>{context.location.href=value;context.location.pathname=new URL(value).pathname;}, clicks: () => clickCount, seeks: () => seeks, reloads: () => reloads, complete:()=>{done=true;change?.();}, change:()=>change?.(), step: async () => { interval?.(); await new Promise(resolve => setImmediate(resolve)); } };
}

test('resume reports the actual rejection and remains stopped instead of silently showing ready',async()=>{
  const environment=harness({resumeError:'Аккаунт Coursera изменился. Запустите отдельный сеанс.'});
  const messages=[];environment.adapter.log=message=>messages.push(message);
  const runner=environment.create();await runner.resume();
  assert.equal(runner.isRunning(),false);assert.equal(environment.clicks(),0);
  assert(messages.some(message=>message.includes('Аккаунт Coursera изменился')));
});

test('completed sidebar items repair pending queues without opening them and preserve the perfect-score target',async()=>{
  for(const target100 of [false,true]){
    const base='https://www.coursera.org/learn/demo/';
    const paths=['supplement/done/title','quiz/passed/title','quiz/perfect/title','supplement/hidden/title'];
    const links=paths.map((path,index)=>({href:base+path,textContent:path,done:index!==3,closest:()=>null,getAttribute:()=>null}));
    const journal=[{item:core.itemKey(links[1].href),at:Date.now(),confirmed:true}];
    const environment=harness({links,progress:{phase:'waiting',feedbackResultRecoveryVersion:3,submitted:journal,quizReviews:{[core.itemKey(links[2].href)]:{score:100}},queue:links.map(link=>({key:core.itemKey(link.href),url:link.href,status:'pending_grade',nextCheckAt:Date.now()+3600000}))}});
    environment.adapter.itemCompleted=link=>link.done;
    const runner=environment.create();await runner.start({speed:2,target100});await environment.step();
    const progress=environment.stored().progress;
    assert(progress.visited.includes(core.itemKey(links[0].href)),'confirmed reading should be skipped');
    assert.equal(progress.visited.includes(core.itemKey(links[1].href)),!target100,'completion is not proof of a perfect grade');
    assert(progress.visited.includes(core.itemKey(links[2].href)),'a confirmed 100% quiz should never be reopened');
    assert(!progress.visited.includes(core.itemKey(links[3].href)),'a hidden icon is not proof');
    assert.equal(progress.queue.find(item=>item.key===core.itemKey(links[0].href)).status,'completed');
    assert.deepEqual(JSON.parse(JSON.stringify(progress.submitted)),journal,'completion discovery must preserve the submission journal');
    assert.equal(environment.clicks(),0);assert.equal(environment.url(),base+'supplement/read/title');await runner.stop();
  }
});

test('browser-confirmed pending navigation survives two minutes and stops after cancellation',async()=>{
  const clock={now:Date.now()};
  let pending=true;
  const environment=harness({clock,navigationPending:()=>pending,progress:{phase:'advancing',actionAt:clock.now}});
  const runner=environment.create();await runner.start({speed:2});await environment.step();
  clock.now+=121000;await environment.step();
  assert.equal(runner.isRunning(),true,'a browser-confirmed pending navigation must preserve the run');
  pending=false;clock.now+=1000;await environment.step();
  assert.equal(runner.isRunning(),false,'a cancelled navigation must still stop');
  assert.equal(environment.stored(),null);
});

test('video-mark reload waits for browser-confirmed navigation and still stops after cancellation',async()=>{
  const clock={now:Date.now()};
  let pending=true;
  const environment=harness({clock,navigationPending:()=>pending});
  environment.adapter.fastReady=()=>true;
  environment.adapter.fastVideos=async()=>({acceptedCount:1,items:[]});
  const runner=environment.create();await runner.start({speed:2});await environment.step();
  assert.equal(environment.reloads(),1);
  assert.equal(environment.stored().progress.phase,'fast-reloading');
  clock.now+=121000;await environment.step();
  assert.equal(runner.isRunning(),true,'a confirmed video-mark reload must survive slow Coursera loading');
  pending=false;clock.now+=1000;await environment.step();
  assert.equal(runner.isRunning(),false,'a cancelled reload must still stop');
  assert.equal(environment.stored(),null);
});

test('temporary player and material-completion timeouts defer work and keep the runner active',async()=>{
  for(const phase of ['lesson','marking']){
    const clock={now:Date.now()},next='https://www.coursera.org/learn/demo/supplement/later/title';
    let pending=true;
    const environment=harness({clock,navigationPending:()=>pending,itemPath:phase==='lesson'?'lecture/unavailable/title':null,progress:{phase,actionAt:clock.now,inventory:[{key:core.itemKey(next),url:next,kind:'reading'}]}});
    environment.adapter.visible=element=>!!element&&!element.hidden;
    const runner=environment.create();await runner.start({speed:2});await environment.step();
    // activate resets an interrupted marking action; emulate its single completion click.
    if(phase==='marking')assert.equal(environment.clicks(),1);
    clock.now+=30000;await environment.step();
    assert.equal(runner.isRunning(),true,'pending browser navigation cannot stop the course');
    assert.equal(environment.stored().progress.queue.length,0);
    pending=false;await environment.step();
    assert.equal(runner.isRunning(),true,'temporary item failure must not end the course');
    assert.equal(environment.stored().progress.queue[0].status,'blocked_dependency');
    assert.equal(environment.url(),next,'later materials must continue');
    assert.equal(environment.clicks(),phase==='marking'?1:0,'a pending completion click must not repeat');
    await runner.stop();
  }
});

test('a same-activity result route does not trip the guard for unchanged content of a different activity',async()=>{
  const url='https://www.coursera.org/learn/demo/assignment-submission/work/title/attempt';
  for(const sameActivity of [true,false]){
    const clock={now:Date.now()},key=core.itemKey(url);
    const environment=harness({clock,itemPath:'assignment-submission/work/title/attempt',progress:{phase:'waiting',queue:[{key,url,status:'needs_input',reason:'Waiting for input'}]}});
    const identity={};environment.adapter.materialIdentity=()=>[identity,'Assessment'];
    const runner=environment.create();await runner.start({speed:2});await environment.step();
    environment.route(sameActivity?url.replace('/attempt',''):url.replace('/work/','/another/'));
    await environment.step();clock.now+=26000;await environment.step();
    assert.equal(runner.isRunning(),sameActivity);
    await runner.stop();
  }
});

test('Stop during pending start durably prevents resume after document replacement', async () => {
  const environment = harness({ pauseStart: true });
  const oldDocument = environment.create();
  const starting = oldDocument.start({ speed: 2 });
  await environment.ready;
  await oldDocument.stop();
  assert.equal(environment.stored(), null);
  const newDocument = environment.create();
  await newDocument.resume();
  assert.equal(newDocument.isRunning(), false);
  environment.release();
  await starting;
  assert.equal(environment.stored(), null);
  assert.equal(environment.clicks(), 0);
});

test('Stop while an action checkpoint is pending prevents its DOM click', async () => {
  const environment = harness({ pausePhase: 'marking' });
  const runner = environment.create();
  await runner.start({ speed: 2 });
  await environment.ready;
  await runner.stop();
  environment.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(environment.clicks(), 0);
  assert.equal(environment.stored(), null);
});

test('Stop during a retake checkpoint prevents consuming another attempt',async()=>{
  const environment=harness({pausePhase:'retake-opening',itemPath:'quiz/q/title'});
  let retakes=0;environment.adapter.questionGroups=()=>[];environment.adapter.quizGrade=()=>80;
  environment.adapter.quizFeedback=()=>'{"question":"Fixture","feedback":"Incorrect"}';
  environment.adapter.retakeButton=()=>({isConnected:true,click:()=>retakes++});
  const runner=environment.create();await runner.start({speed:2,target100:true});
  await environment.ready;await runner.stop();environment.release();await environment.step();
  assert.equal(retakes,0);assert.equal(environment.stored(),null);
});

test('Stop during feedback result return prevents the pending Back click',async()=>{
  const environment=harness({pausePhase:'feedback-closing',itemPath:'assignment-submission/q/review/view-feedback'});
  let backs=0;environment.adapter.questionGroups=()=>[];environment.adapter.quizGrade=()=>null;
  environment.adapter.feedbackReady=()=>true;environment.adapter.feedbackBackButton=()=>({isConnected:true,click:()=>backs++});
  const runner=environment.create();await runner.start({speed:2,target100:true});
  await environment.ready;await runner.stop();environment.release();await environment.step();
  assert.equal(backs,0);assert.equal(environment.stored(),null);
});

test('result recovery makes only submitted quiz cover and feedback checks due once',async()=>{
  const base='https://www.coursera.org/learn/demo/',feedback=base+'assignment-submission/q/review/view-feedback',cover=base+'assignment-submission/r/review',other=base+'quiz/other/title';
  for(const [version,target100,recovered] of [[undefined,true,true],[1,true,true],[2,true,true],[3,true,false],[undefined,false,false]]){
    const journal=[{item:core.itemKey(feedback),attempt:1,at:Date.now(),confirmed:true},{item:core.itemKey(cover),at:Date.now(),confirmed:true}];
    const environment=harness({progress:{feedbackResultRecoveryVersion:version,submitted:journal,queue:[{key:core.itemKey(feedback),url:feedback,status:'pending_grade',nextCheckAt:Date.now()+1800000},{key:core.itemKey(cover),url:cover,status:'pending_grade',nextCheckAt:Date.now()+1800000},{key:core.itemKey(other),url:other,status:'pending_grade',nextCheckAt:Date.now()+1800000}]}});
    const runner=environment.create();await runner.start({speed:2,target100});await environment.step();
    const progress=environment.stored().progress;
    assert.equal(progress.queue[0].manualCheck===true,recovered);assert.equal(progress.queue[1].manualCheck===true,recovered);assert.equal(progress.queue[2].manualCheck===true,false);
    assert.equal(progress.queue[0].nextCheckAt<=Date.now(),recovered);assert.deepEqual(progress.submitted,journal);await runner.stop();
  }
});

test('feedback Back waits for confirmed navigation and never clicks twice',async()=>{
  const clock={now:Date.now()};let pending=true,backs=0;
  const environment=harness({clock,navigationPending:()=>pending,itemPath:'assignment-submission/q/review/view-feedback'});
  environment.adapter.questionGroups=()=>[];environment.adapter.quizGrade=()=>null;environment.adapter.feedbackReady=()=>true;
  environment.adapter.feedbackBackButton=()=>({isConnected:true,click:()=>backs++});
  const runner=environment.create();await runner.start({speed:2,target100:true});await environment.step();
  clock.now+=121000;await environment.step();assert.equal(backs,1);assert.equal(runner.isRunning(),true);assert.equal(runner.status().needsInput,0);
  pending=false;await environment.step();assert.equal(backs,1);assert.equal(runner.status().needsInput,0);assert.equal(runner.status().pending,1);await runner.stop();
});

test('a loading assessment is automatically deferred and never skipped because its quiz controls are late',async()=>{
  for(const submitted of [false,true]){
    const clock={now:Date.now()},key='https://www.coursera.org/learn/demo/assignment-submission/q';let pending=true;
    const journal=submitted?[{item:key,at:clock.now-120000,confirmed:true}]:[];
    const environment=harness({clock,navigationPending:()=>pending,itemPath:'assignment-submission/q/review',progress:{submitted:journal}});
    environment.adapter.isQuiz=()=>false;environment.adapter.nonQuizForm=()=>false;
    const runner=environment.create();await runner.start({speed:2,target100:true});await environment.step();
    clock.now+=26000;await environment.step();
    assert.equal(runner.status().skipped,0);assert.equal(runner.status().pending,0,'confirmed navigation must remain awaited');
    pending=false;await environment.step();
    assert.equal(runner.isRunning(),true);assert.equal(runner.status().skipped,0);assert.equal(runner.status().needsInput,0);assert.equal(runner.status().pending,1);
    assert.equal(environment.stored().progress.queue[0].status,submitted?'pending_grade':'blocked_dependency');assert.deepEqual(environment.stored().progress.submitted,journal);await runner.stop();
  }
});

test('a slowly loading reading cannot stop the course before its lock message appears',async()=>{
  const clock={now:Date.now()},link={href:'https://www.coursera.org/learn/demo/quiz/next/review',textContent:'Next quiz',isConnected:true,getAttribute:()=>'',closest:()=>null};let pending=true;
  const environment=harness({clock,navigationPending:()=>pending,links:[link]});environment.adapter.completeButton=()=>null;
  const runner=environment.create();await runner.start({speed:2});await environment.step();clock.now+=26000;await environment.step();
  assert.equal(runner.isRunning(),true);assert.equal(runner.status().pending,0);
  pending=false;await environment.step();assert.equal(runner.isRunning(),true);assert.equal(runner.status().pending,1);assert.equal(environment.url(),link.href);assert.equal(environment.clicks(),0);await runner.stop();
});

test('a real written assessment remains excluded while old timeout-based skips are checked once',async()=>{
  for(const version of [2,3]){
    const key='https://www.coursera.org/learn/demo/assignment-submission/q',url=key+'/review';
    const environment=harness({itemPath:'assignment-submission/q/review',progress:{phase:'waiting',queue:[{key,url,status:'skipped',quizRecognitionVersion:version}]}});
    const runner=environment.create();await runner.start({speed:2});await environment.step();
    assert.equal(environment.reloads(),version===2?1:0);await runner.stop();
  }
  const clock={now:Date.now()},environment=harness({clock,itemPath:'assignment-submission/written/essay',progress:{queue:[{key:'https://www.coursera.org/learn/demo/supplement/locked',url:'https://www.coursera.org/learn/demo/supplement/locked/solution',status:'blocked_dependency',nextCheckAt:clock.now+60000}]}});
  environment.adapter.isQuiz=()=>false;environment.adapter.nonQuizForm=()=>true;
  const runner=environment.create();await runner.start({speed:2});await environment.step();
  assert.equal(runner.status().skipped,1);assert.equal(environment.stored().progress.queue.find(entry=>entry.status==='skipped').quizRecognitionVersion,3);assert.equal(environment.clicks(),0);await runner.stop();
});

test('missing retake controls are rechecked without another submission or permanent needs-input',async()=>{
  const clock={now:Date.now()},key='https://www.coursera.org/learn/demo/quiz/q';
  const journal=[{item:key,at:clock.now-120000,confirmed:true}];
  const environment=harness({clock,itemPath:'quiz/q/title',progress:{submitted:journal,quizReviews:{[key]:{attempt:0,score:80,observedAt:clock.now-20000,reviewed:true,feedback:'Saved feedback'}}}});
  environment.adapter.questionGroups=()=>[];environment.adapter.quizGrade=()=>80;environment.adapter.retakeButton=()=>null;
  const runner=environment.create();await runner.start({speed:2,target100:true});await environment.step();
  assert.equal(runner.status().needsInput,0);assert.equal(runner.status().pending,1);assert.deepEqual(environment.stored().progress.submitted,journal);assert.equal(environment.clicks(),0);await runner.stop();
});

test('a passed heading without a grade is checked later and cannot complete the perfect-score target',async()=>{
  const clock={now:Date.now()},environment=harness({clock,itemPath:'quiz/q/title'});
  environment.adapter.questionGroups=()=>[];environment.adapter.quizGrade=()=>null;
  environment.adapter.scope=()=>({querySelectorAll:selector=>selector.includes('[role="status"]')?[{innerText:'You passed!',closest:()=>null}]:[]});
  const runner=environment.create();await runner.start({speed:2,target100:true});await environment.step();clock.now+=16000;await environment.step();
  assert.equal(runner.status().needsInput,0);assert.equal(runner.status().pending,1);assert.equal(runner.status().count,0);assert.equal(environment.stored().progress.queue[0].status,'pending_grade');assert.equal(environment.clicks(),0);await runner.stop();
});

test('old transient quiz needs-input entries recover once without recovering personal or ambiguous retake actions',async()=>{
  const scope='https://www.coursera.org/learn/demo/',reasons=[
    'Не удалось вернуться из разбора к результату. Попытка не расходуется.',
    'Оценка 80%. Не найдена поддерживаемая кнопка новой попытки для достижения 100%.',
    'Итоговая оценка не прочитана. Новая попытка не расходуется без известного результата.',
    'Нужно личное подтверждение кодекса чести на Coursera.',
    'Новая попытка не открылась. Повторное нажатие заблокировано.',
    'Модель не смогла уверенно ответить на весь тест. Нужен дополнительный контекст.'
  ];
  for(const applied of [false,true]){
    const queue=reasons.map((reason,index)=>({key:scope+'quiz/q'+index,url:scope+'quiz/q'+index+'/title',status:'needs_input',reason,solverRecoveryVersion:2,...(index===3?{actionRequired:'personal_confirmation'}:{})}));
    const environment=harness({progress:{phase:'waiting',quizControlRecoveryVersion:applied?1:undefined,queue}});
    const runner=environment.create();await runner.start({speed:2,target100:true});await new Promise(resolve=>setImmediate(resolve));
    const saved=environment.stored().progress.queue;
    for(let index=0;index<reasons.length;index++)assert.equal(saved[index].status,!applied&&index<3?'blocked_dependency':'needs_input',reasons[index]);
    assert.equal(environment.clicks(),0);assert.equal(environment.stored().progress.submitted.length,0);await runner.stop();
  }
});

test('an old submission waits for fresh result hydration instead of immediately queuing the cover',async()=>{
 for(const initialPhase of ['lesson','result-waiting']){
  const clock={now:Date.now()},url='https://www.coursera.org/learn/demo/assignment-submission/q/review',key=core.itemKey(url);
  const journal=[{item:key,attempt:1,at:clock.now-120000,confirmed:true}];let score=null;
  const environment=harness({clock,itemPath:'assignment-submission/q/review',progress:{phase:initialPhase,actionAt:clock.now-120000,attempts:{[key]:1},submitted:journal}});
  environment.adapter.questionGroups=()=>[];environment.adapter.quizGrade=()=>score;
  environment.adapter.scope=()=>({querySelectorAll:selector=>selector.includes('[role="status"]')?[{innerText:'You passed!',closest:()=>null}]:[]});
  const runner=environment.create();await runner.start({speed:2,target100:true});await environment.step();
  assert.equal(environment.stored().progress.phase,'result-waiting');assert.equal(environment.stored().progress.actionAt,clock.now);assert.equal(runner.status().pending,0);
  clock.now+=45000;await environment.step();assert.equal(runner.status().pending,0);assert.equal(runner.isRunning(),true);
  score=100;await environment.step();await environment.step();assert.equal(environment.stored().progress.quizReviews[key].score,100);assert.equal(runner.status().count,1);assert.deepEqual(environment.stored().progress.submitted,journal);await runner.stop();
 }
});

test('result hydration preserves confirmed browser loading and queues a missing grade after loading ends',async()=>{
  const clock={now:Date.now()},url='https://www.coursera.org/learn/demo/assignment-submission/q/review',key=core.itemKey(url);let pending=true;
  const journal=[{item:key,at:clock.now-120000,confirmed:true}];
  const environment=harness({clock,navigationPending:()=>pending,itemPath:'assignment-submission/q/review',progress:{submitted:journal}});
  environment.adapter.questionGroups=()=>[];environment.adapter.quizGrade=()=>null;
  const runner=environment.create();await runner.start({speed:2,target100:true});await environment.step();
  clock.now+=121000;await environment.step();assert.equal(runner.status().pending,0);assert.equal(runner.isRunning(),true);
  pending=false;await environment.step();assert.equal(runner.status().pending,1);assert.equal(runner.isRunning(),true);assert.deepEqual(environment.stored().progress.submitted,journal);await runner.stop();
});

test('a saved draft resumes only without a current submission intent and a 100% grade never resumes it',async()=>{
  const key='https://www.coursera.org/learn/demo/quiz/q';
  for(const [score,submitted,expected] of [[80,[],1],[80,[{item:key,attempt:1,at:Date.now(),confirmed:true}],0],[100,[],0]]){
    let resumes=0;
    const environment=harness({itemPath:'quiz/q/title',progress:{attempts:{[key]:1},submitted,quizReviews:{[key]:{attempt:1,score:80,reviewed:true,feedback:''}}}});
    environment.adapter.questionGroups=()=>[];environment.adapter.quizGrade=()=>score;
    environment.adapter.resumeButton=()=>({isConnected:true,click:()=>resumes++});
    environment.adapter.retakeButton=()=>null;environment.adapter.buttons=()=>[];
    const runner=environment.create();await runner.start({speed:2,target100:true});await environment.step();await environment.step();
    assert.equal(resumes,expected);assert.equal(environment.stored().progress.attempts[key],1);
    assert.equal(environment.stored().progress.submitted.length,submitted.length);await runner.stop();
  }
});

test('a Next control reused as Retake during a checkpoint is not clicked',async()=>{
  const environment=harness({pausePhase:'advancing'});
  let retakes=0,nextClicks=0;
  const oldButton={isConnected:true,href:null,click:()=>retakes++};
  const newButton={isConnected:true,href:null,click:()=>nextClicks++};
  let selected=oldButton;
  environment.adapter.nextButton=()=>selected;
  environment.complete();
  const runner=environment.create();await runner.start({speed:2});
  await environment.ready;
  selected=newButton;
  environment.release();await environment.step();await environment.step();
  assert.equal(retakes,0,'a reused DOM node must not open another attempt');
  assert.equal(nextClicks,1,'the current Next control should be selected on the following tick');
  await runner.stop();
});

test('course waits for native seek readiness after metadata before skipping video', async () => {
  const video = { duration:60, ended:false, seekable:{length:0} };
  const environment = harness({video});
  const runner = environment.create();
  await runner.start({speed:2,skipVideo:true});
  await environment.step();
  assert.equal(runner.isRunning(),true);
  assert.equal(environment.seeks(),0);
  video.seekable.length=1;
  await environment.step();
  assert.equal(environment.seeks(),1);
  assert.equal(environment.stored().progress.phase,'video-wait');
  await runner.stop();
});

test('single-open module accordions cannot starve an overdue grading check', async () => {
  const modules = [1,2].map(number=>({id:`module-${number}`,isConnected:true,expanded:number===2,querySelector:()=>({textContent:`Module ${number}`})}));
  for(const module of modules)module.click=()=>modules.forEach(item=>item.expanded=item===module);
  const environment=harness({modules});
  const runner=environment.create();
  await runner.start({speed:2});
  await environment.step();
  const target='https://www.coursera.org/learn/demo/quiz/p/project';
  environment.stored().progress.phase='waiting';
  environment.stored().progress.queue=[{key:core.itemKey(target),url:target,status:'pending_grade',nextCheckAt:0}];
  for(let step=0;step<3;step++)await environment.step();
  assert.equal(environment.url(),target);
  await runner.stop();
});

test('retrying an unsubmitted paginated quiz clears page markers while preserving the submission journal',async()=>{
  const url='https://www.coursera.org/learn/demo/quiz/q/title',key=core.itemKey(url);
  for(const submitted of [[],[{item:key,at:Date.now(),confirmed:false}]]){
    const environment=harness({itemPath:'quiz/q/title',progress:{phase:'waiting',pages:['page-one'],pageHash:'page-two',submitted,queue:[{key,url,status:'blocked_dependency',nextCheckAt:0}]}});
    const runner=environment.create();await runner.start({speed:2});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(environment.reloads(),1);
    const progress=environment.stored().progress;
    assert.deepEqual(Array.from(progress.pages),submitted.length?['page-one']:[]);
    assert.equal(progress.pageHash,submitted.length?'page-two':null);
    assert.equal(progress.submitted.length,submitted.length);
    assert.equal(environment.clicks(),0);
    await runner.stop();
  }
});

test('a site completion wake during a pending checkpoint advances without an interval',async()=>{
  const environment=harness({pausePhase:'marking'}),runner=environment.create();
  await runner.start({speed:2});await environment.ready;
  environment.complete();environment.release();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(environment.stored().progress.visited.length,1);
  assert.equal(environment.clicks(),2);
  await runner.stop();environment.change();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(environment.clicks(),2);
});

const learningLink=(type,id,title)=>({href:`https://www.coursera.org/learn/demo/${type}/${id}/title`,textContent:title,isConnected:true,getAttribute:()=>title,closest:selector=>selector.includes('left-nav')?{}:null});
test('previous image-related uncertainty is recovered once and newly reported uncertainty stays queued',async()=>{
  const url='https://www.coursera.org/learn/demo/quiz/q/title',key=core.itemKey(url);
  for(const version of [undefined,2]){
    const environment=harness({itemPath:'quiz/q/title',progress:{phase:'waiting',queue:[{key,url,status:'needs_input',reason:'Модель не смогла уверенно ответить на весь тест. Нужен дополнительный контекст.',solverRecoveryVersion:version}]}});
    const runner=environment.create();await runner.start({speed:2});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(runner.status().needsInput,version===2?1:0);assert.equal(environment.reloads(),version===2?0:1);await runner.stop();
  }
});

test('feedback retake repair preserves confirmed or unrelated ambiguous intents',async()=>{
  for(const [confirmed,feedbackURL] of [[false,true],[true,true],[false,false]]){
    const key='https://www.coursera.org/learn/demo/quiz/q',url=key+(feedbackURL?'/title/view-feedback':'/title');
    const environment=harness({itemPath:'quiz/q/title',progress:{phase:'waiting',feedbackRetakeRecoveryVersion:1,retakePending:{[key]:{item:key,before:0,at:Date.now(),confirmed}},queue:[{key,url,status:'needs_input',reason:'Новая попытка не открылась. Повторное нажатие заблокировано.'}]}});
    environment.adapter.questionGroups=()=>[];environment.adapter.buttons=()=>[];
    const runner=environment.create();await runner.start({speed:2,target100:true});await environment.step();
    assert.equal(environment.stored().progress.retakePending[key]===null,!confirmed&&feedbackURL);
    await runner.stop();
  }
});

test('a confirmed retake waits for Chrome navigation, then keeps an unloaded form queued without another click',async()=>{
  const key='https://www.coursera.org/learn/demo/quiz/q',clock={now:Date.now()};let pending=true;
  const environment=harness({clock,navigationPending:()=>pending,itemPath:'quiz/q/title',progress:{phase:'retake-opening',retakePending:{[key]:{item:key,before:0,at:clock.now,confirmed:true}}}});
  environment.adapter.questionGroups=()=>[];environment.adapter.buttons=()=>[];
  const runner=environment.create();await runner.start({speed:2,target100:true});await environment.step();clock.now+=121000;await environment.step();
  assert.equal(runner.isRunning(),true);assert.equal(runner.status().needsInput,0);
  pending=false;await environment.step();assert.equal(runner.isRunning(),true);assert.equal(runner.status().pending,1);assert.equal(environment.clicks(),0);
  assert.equal(environment.stored().progress.retakePending[key].confirmed,true);await runner.stop();
});
test('explicitly recovered quizzes are checked before older automatically blocked readings',async()=>{
  const read='https://www.coursera.org/learn/demo/supplement/locked/title',quiz='https://www.coursera.org/learn/demo/quiz/pending/title';
  const environment=harness({progress:{phase:'waiting',queue:[{key:core.itemKey(read),url:read,status:'blocked_dependency',nextCheckAt:0},{key:core.itemKey(quiz),url:quiz,status:'blocked_dependency',nextCheckAt:1,manualCheck:true}]}});
  const runner=environment.create();await runner.start({speed:2});await new Promise(resolve=>setImmediate(resolve));assert.equal(environment.url(),quiz);await runner.stop();
});
test('a locked reading is deferred immediately and does not stop later materials or click a completion control',async()=>{
  const link=learningLink('supplement','next','Available reading'),environment=harness({links:[link]});let completionChecks=0;
  environment.adapter.locked=()=>true;
  environment.adapter.completeButton=()=>{completionChecks++;return null;};
  const runner=environment.create();await runner.start({speed:2});for(let i=0;i<4;i++)await environment.step();
  assert.equal(runner.isRunning(),true);assert.equal(completionChecks,0);
  assert(environment.stored().progress.queue.some(e=>e.status==='blocked_dependency'));
  assert.equal(environment.url(),link.href);await runner.stop();
});
test('unsubmitted model uncertainty or a temporary failure never switches off processing of other materials',async()=>{
  for(const code of ['SOLVER_UNCERTAIN','SOLVER_TEMPORARY','SOLVER_ERROR','QUIZ_CHANGED']){
    const link=learningLink('supplement','next','Next reading'),environment=harness({itemPath:'quiz/q/title',links:[link]});
    environment.adapter.questionGroups=()=>[{type:'radio',controls:[]}];
    environment.adapter.quizExport=()=>({questions:[{id:1,question:'Fixture question',type:'radio',options:['A','B']}]});
    environment.adapter.solve=async()=>{throw Object.assign(Error('Fixture solver failure'),{code});};
    const runner=environment.create();await runner.start({speed:2});
    for(let i=0;i<100&&environment.url()!==link.href;i++)await environment.step();
    assert.equal(runner.isRunning(),true,code);assert.equal(environment.url(),link.href,code);
    assert.equal(environment.stored().progress.submitted.length,0);
    assert(environment.stored().progress.queue.some(e=>e.status===(['SOLVER_TEMPORARY','QUIZ_CHANGED'].includes(code)?'blocked_dependency':'needs_input')));
    await runner.stop();
  }
});

test('a quiz waits for its submit control and queues a persistent absence without stopping other materials',async()=>{
  for(const readyLater of [true,false]){
    const clock={now:Date.now()},link=learningLink('supplement','next','Next reading');
    const environment=harness({clock,itemPath:'quiz/q/title',links:[link]});let ready=false,solves=0;
    const messages=[];environment.adapter.log=message=>messages.push(message);
    const submit={tagName:'BUTTON',textContent:'Отправить',isConnected:true,closest:()=>null,click:()=>{}};
    environment.adapter.questionGroups=()=>[{type:'radio',controls:[{checked:true}]}];
    environment.adapter.quizExport=()=>({questions:[{id:1,question:'Fixture question',type:'radio',options:['A','B']}]});
    environment.adapter.solve=async()=>{solves++;return [{id:1,choices:[2]}];};
    environment.adapter.verifyApplied=()=>{};
    environment.adapter.buttons=()=>ready?[submit]:[];
    const runner=environment.create();await runner.start({speed:2});
    for(let i=0;i<100&&environment.stored()?.progress.phase!=='filled';i++)await environment.step();
    assert.equal(environment.stored()?.progress.phase,'filled');
    assert.equal(runner.isRunning(),true,'a delayed button must not stop the run');
    assert.equal(solves,1);assert.equal(environment.stored().progress.submitted.length,0);
    if(readyLater){ready=true;for(let i=0;i<100&&!environment.stored()?.progress.submitted.length;i++)await environment.step();assert.equal(environment.stored().progress.submitted.length,1);}
    else{clock.now+=16000;for(let i=0;i<100&&environment.url()!==link.href;i++)await environment.step();assert.equal(environment.url(),link.href,JSON.stringify({messages,status:runner.status(),progress:environment.stored()?.progress}));assert.equal(environment.stored().progress.submitted.length,0);assert(runner.status().queue.some(e=>e.status==='needs_input'));}
    assert.equal(runner.isRunning(),true);assert.equal(solves,1);await runner.stop();
  }
});
test('non-quiz activities are skipped without consulting an editor, assignment solver or Coach',async()=>{
  for(const type of ['peer','programming','lab','coach','interactive']){
    const environment=harness({itemPath:`${type}/work/title`});let touched=0;
    const unexpected=()=>{touched++;throw Error('Excluded task was touched');};
    environment.adapter.assignment={status:unexpected,prepare:unexpected};
    environment.adapter.coach={snapshot:unexpected,prepare:unexpected};
    const runner=environment.create();await runner.start({speed:2});await environment.step();
    assert.equal(touched,0,type);assert.equal(runner.status().skipped,1,type);assert.equal(runner.status().needsInput,0,type);
    assert.equal(environment.stored()?.progress.submitted.length||0,0);await runner.stop();
  }
});
test('a sidebar-only unsupported task cannot disappear from the unresolved inventory',async()=>{
  const link=learningLink('interactive','dialog','Practice conversation'),environment=harness({links:[link],progress:{phase:'waiting'}}),runner=environment.create();
  await runner.start({speed:2});await new Promise(resolve=>setImmediate(resolve));
  assert(runner.status().queue.some(entry=>entry.url===link.href&&entry.status==='skipped'));
  assert(runner.status().queue.some(entry=>entry.title==='Practice conversation'));
  await runner.stop();
});
test('a terminal heading cannot bypass an observed unvisited assessment',async()=>{
  const link=learningLink('assignment-submission','exam','Assessment 5'),environment=harness({links:[link],terminal:true}),runner=environment.create();
  await runner.start({speed:2});await new Promise(resolve=>setImmediate(resolve));
  assert.notEqual(runner.status().phase,'completed');assert.equal(environment.url(),link.href);
  await runner.stop();
});
test('a resumed waiting run immediately exposes its pending task without another save',async()=>{
  const target='https://www.coursera.org/learn/demo/coach/a/title';
  const environment=harness({progress:{phase:'waiting',inventory:[{key:core.itemKey(target),url:target,title:'Conversation',kind:'manual'}],queue:[{key:core.itemKey(target),url:target,status:'needs_input',reason:'Unsupported'}]}}),runner=environment.create();
  await runner.start({speed:2});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(runner.status().needsInput,0);assert.equal(runner.status().skipped,1);assert.equal(runner.status().queue[0].title,'Conversation');
  await runner.stop();
});
test('tasks seen during a video batch remain candidates after their module is collapsed',async()=>{
  const target=learningLink('assignment-submission','exam','Assessment 5');
  const environment=harness(),runner=environment.create();
  environment.adapter.fastVideos=async()=>({acceptedCount:0,items:[{url:target.href,title:target.textContent,sidebar:true}]});
  await runner.start({speed:2});await new Promise(resolve=>setImmediate(resolve));
  environment.complete();await new Promise(resolve=>setImmediate(resolve));
  assert(environment.stored().progress.inventory.some(entry=>entry.url===target.href));
  assert.equal(environment.url(),target.href);await runner.stop();
});

test('an unloaded module stops discovery instead of allowing a terminal page to complete the course',async()=>{
  const module={id:'slow',isConnected:true,expanded:false,querySelector:()=>({textContent:'Module 2'}),click(){this.expanded=true;}};
  const environment=harness({modules:[module],terminal:true});let reason='';
  environment.adapter.waitModule=async()=>false;environment.adapter.log=message=>{reason=message;};
  const runner=environment.create();await runner.start({});await environment.step();
  assert.equal(runner.status().phase,'stopped');assert.match(reason,/Модуль курса не загрузился/);
});

