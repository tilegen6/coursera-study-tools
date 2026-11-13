const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createBridge } = require('../bridge/server.cjs');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'coursera-course-test-'));
const extension = path.join(profile, 'extension');
const token = 'c'.repeat(64);
const counts = {};
const solvers = {};
let heldAbort;
const holdCancelled = new Promise(resolve => heldAbort = resolve);
const wav = Buffer.alloc(44 + 32000);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
const media = `data:audio/wav;base64,${wav.toString('base64')}`;
const page = body => `<!doctype html><html lang="en"><main>${body}</main></html>`;
const eventScript = name => `fetch('/__event?course=${name}&event=' + event, {method:'POST'})`;
function question(prompt) {
  return `<fieldset><legend>${prompt}</legend><label><input type="radio" name="answer">3</label><label><input type="radio" name="answer">4</label></fieldset>`;
}
function fixture(url) {
  const name = url.pathname.split('/')[2];
  const base = `/learn/${name}`;
  if (url.pathname.endsWith('/home/completed')) return page('<h1 data-test="course-completed">Course completed</h1>');
  if (url.pathname.endsWith('/home/overview')) return page(`<h1>Course overview</h1><a href="${base}/supplement/read/intro">Start learning</a>`);
  if (url.pathname.includes('/supplement/')) {
    const last = url.pathname.includes('/last/');
    const next = name === 'boundary' ? '/learn/another/lecture/v/title' : name === 'unsupported' ? `${base}/peer/p/project` : last ? `${base}/home/completed` : `${base}/lecture/video/intro`;
    return page(`<h1>${last ? 'Final reading' : 'Reading'}</h1><button id="complete">Mark as complete</button><a href="${next}">Next</a><script>document.getElementById('complete').onclick=()=>{document.getElementById('complete').outerHTML='<button disabled>Completed</button>';};</script>`);
  }
  if (url.pathname.includes('/lecture/')) return page(`<h1>Video</h1><aside data-testid="left-nav"><a href="${base}/lecture/video/intro"><span id="video-status"></span></a></aside><video src="${media}" controls style="width:500px;height:200px"></video><a href="${base}/exam/test/intro">Next</a><script>const player=document.querySelector('video');player.onended=()=>{document.body.dataset.ended='yes';${name==='buffering'?'':`document.getElementById('video-status').innerHTML='<svg data-testid="learn-item-success-icon" width="20" height="20"></svg>';`}};${name==='buffering'?`const seekable=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'seekable').get;document.body.dataset.bufferReady='no';Object.defineProperty(player,'seekable',{get(){return document.body.dataset.bufferReady==='yes'?seekable.call(this):{length:0};}});`:''}</script>`);
  if (url.pathname.endsWith('/exam/test/intro')) return page(name === 'open-boundary' ? '<h1>Quiz</h1><a href="https://www.coursera.org/learn/another/exam/test/attempt">Start quiz</a>' : `<h1>Quiz</h1><button onclick="location.href='${base}/exam/test/attempt'">Start quiz</button>`);
  if (url.pathname.endsWith('/exam/test/result')) return page(`<h1>Quiz result</h1><section data-test="quiz-result" data-score="${name==='failed'?0:100}"><h2>${name === 'failed' ? 'You did not pass' : 'You passed!'}</h2></section><fieldset><legend>Reviewed answer</legend><input type="text" readonly value="42"></fieldset><fieldset disabled><legend>Disabled reviewed choice</legend><label><input type="radio" checked>4</label></fieldset><a href="${base}/supplement/last/reading">Next</a>`);
  if (url.pathname.endsWith('/exam/test/attempt')) {
    const report = eventScript(name);
    if (name === 'rerender') {
      const choices = '<legend>Select the prime numbers</legend><label><input type="checkbox" value="a">2</label><label><input type="checkbox" value="b">3</label><label><input type="checkbox" value="c">4</label>';
      return page(`<h1>Checkbox quiz</h1><fieldset id="choices">${choices}</fieldset><button onclick="const event='submit';${report}">Submit</button><script>document.getElementById('choices').onchange=()=>{if(!window.changed){window.changed=true;document.getElementById('choices').innerHTML=${JSON.stringify(choices.replace('value="a"', 'value="a" checked'))};}};</script>`);
    }
    const submit = `async function send(){const event='submit';await ${report};${name === 'ambiguous' ? 'location.reload();' : `document.body.insertAdjacentHTML('beforeend','<div role="dialog"><h2>Submit answers?</h2><button id="confirm">Submit answers</button></div>');document.getElementById('confirm').onclick=async()=>{const event='confirm';await ${report};location.href='${base}/exam/test/result';};`}}`;
    return page(`<h1>Quiz attempt</h1><section data-test="quiz-result"><h2>You passed!</h2></section><form id="quiz">${question('What is 2 + 2?')}<button type="button" id="page">Next</button></form><a href="${base}/supplement/last/reading">Next lesson</a><script>${submit};document.getElementById('page').onclick=()=>{document.getElementById('quiz').innerHTML=${JSON.stringify(question('What is 8 divided by 2?') + '<button type="button" id="submit">Submit</button>')};document.getElementById('submit').onclick=send;};</script>`);
  }
  return page('<h1>Unsupported assignment</h1>');
}

(async () => {
  let context, server;
  try {
    server = createBridge({ token, solve: async (quiz, signal) => {
      const name = new URL(quiz.url).pathname.split('/')[2];
      solvers[name] = (solvers[name] || 0) + 1;
      if (name === 'hold') return new Promise((resolve, reject) => signal.addEventListener('abort', () => { heldAbort(); reject(new Error('cancelled')); }, { once: true }));
      return { status: 'solved', answers: quiz.questions.map(question => ({ id: question.id, choices: question.type === 'checkbox' ? [1, 2] : [2], text: '' })) };
    } });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    fs.cpSync(path.join(root,'extension'),extension,{recursive:true});
    const worker=path.join(extension,'background.js');
    fs.writeFileSync(worker,fs.readFileSync(worker,'utf8').replace('http://127.0.0.1:43179',`http://127.0.0.1:${server.address().port}`));
    context = await chromium.launchPersistentContext(path.join(profile,'browser'), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required'], viewport: { width: 1000, height: 900 } });
    await context.route('https://www.coursera.org/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__event') {
        const key = `${url.searchParams.get('course')}:${url.searchParams.get('event')}`;
        counts[key] = (counts[key] || 0) + 1;
        return route.fulfill({ contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ contentType: 'text/html', body: fixture(url) });
    });
    const manage = await context.newPage();
    await manage.goto('chrome://extensions/');
    const item = manage.locator('extensions-item').filter({ hasText: 'Coursera Study Tools' });
    await item.waitFor();
    const id = await item.getAttribute('id');
    const course = await context.newPage();
    let popup;
    async function openPopup() {
      if (popup && !popup.isClosed()) await popup.close();
      popup = await context.newPage();
      await popup.goto(`chrome-extension://${id}/popup.html`);
      await popup.setViewportSize({ width: 420, height: 900 });
      await popup.evaluate(token => chrome.storage.local.set({ bridgeToken: token }), token);
      await course.bringToFront();
      await popup.evaluate(() => document.getElementById('refresh').click());
      await popup.waitForFunction(() => document.getElementById('dot').classList.contains('connected'));
    }
    async function command(action, data = {}) {
      return popup.evaluate(async ({ action, data }) => {
        let tabs;
        for(let attempt=0;attempt<30;attempt++){
        tabs = await chrome.tabs.query({});
        // The test tab is the only other non-extension task page in this profile.
        for (const tab of tabs) {
          try {
            const status = await chrome.tabs.sendMessage(tab.id, { source: 'coursera-study-tools', action: 'status' });
            if (status?.ok) return chrome.tabs.sendMessage(tab.id, { source: 'coursera-study-tools', action, data });
          } catch {}
        }
        await new Promise(resolve=>setTimeout(resolve,100));
        }
        throw new Error('Course tab not found: '+JSON.stringify(tabs.map(tab=>({id:tab.id,url:tab.url}))));
      }, { action, data });
    }

    await course.goto('https://www.coursera.org/learn/buffering/lecture/video/intro');
    await openPopup();
    await command('courseStart', { speed: 2, skipVideo: true });
    await popup.waitForTimeout(1200);
    assert.equal((await command('status')).data.courseRunning,true,'buffering must not stop the course');
    await course.evaluate(()=>document.body.dataset.bufferReady='yes');
    await course.waitForFunction(()=>document.body.dataset.ended==='yes');
    await popup.waitForTimeout(1000);
    assert.equal(course.url().includes('/lecture/'),true,'ended playback is not site completion');
    assert.equal((await command('status')).data.course.count,0);
    await course.evaluate(()=>document.getElementById('video-status').innerHTML='<svg data-testid="learn-item-success-icon" width="20" height="20"></svg>');
    await course.waitForURL('**/learn/buffering/home/completed',{timeout:45000});
    await command('stop');

    await course.goto('https://www.coursera.org/learn/happy/home/overview');
    await openPopup();
    await popup.locator('#skip-video').check();
    await popup.locator('#run-course').click();
    await popup.waitForFunction(() => document.getElementById('run-course').textContent.includes('выполняется'));
    await popup.close();
    await course.waitForURL('**/learn/happy/home/completed', { timeout: 60000 });
    await openPopup();
    await popup.waitForFunction(() => document.getElementById('feedback').textContent.includes('Курс завершён'));
    assert.equal(counts['happy:submit'], 1);
    assert.equal(counts['happy:confirm'], 1);
    assert.equal(solvers.happy, 2); // Different question pages at the same URL.
    assert.equal((await command('status')).data.courseRunning, false);
    fs.mkdirSync(path.join(root, 'output/playwright'), { recursive: true });
    await popup.screenshot({ path: path.join(root, 'output/playwright/course-finished.png'), fullPage: true });

    for (const [name, expected] of [['failed', 'Тест не пройден'], ['boundary', 'за пределы текущего курса'], ['unsupported', 'отдельной поддержки'], ['open-boundary', 'за пределы текущего курса']]) {
      await course.goto(`https://www.coursera.org/learn/${name}/${name === 'failed' ? 'exam/test/attempt' : name === 'open-boundary' ? 'exam/test/intro' : 'supplement/read/intro'}`);
      await openPopup();
      assert.equal((await command('courseStart', { speed: 2, skipVideo: true })).ok, true);
      if (['failed', 'unsupported'].includes(name)) {
        await popup.waitForFunction(status => document.getElementById('queue-items').textContent.includes(status), name === 'failed' ? 'Не пройдено' : 'Пропущено', { timeout: 30000 });
        if(name==='unsupported')await popup.waitForFunction(()=>document.getElementById('kind').textContent==='Обработка завершена');
        let current=(await command('status')).data;
        // The new document can answer before its saved course has resumed.
        for(let wait=0;name==='failed'&&current.course.phase==='idle'&&wait<50;wait++){
          await popup.waitForTimeout(100);current=(await command('status')).data;
        }
        assert.equal(current.courseRunning, name==='failed',JSON.stringify(current));
        await command('stop');
      } else {
        await popup.waitForFunction(expected => document.getElementById('feedback').textContent.includes(expected), expected, { timeout: 30000 });
        assert.equal((await command('status')).data.courseRunning, false);
      }
      if (name === 'failed') assert.equal(counts['failed:submit'], 1);
      else assert.equal(course.url().includes(`/learn/${name}/`), true);
    }

    await course.goto('https://www.coursera.org/learn/ambiguous/exam/test/attempt');
    await openPopup();
    await command('courseStart', { speed: 2, skipVideo: true });
    await course.waitForEvent('load', { timeout: 30000 });
    await popup.waitForTimeout(2500);
    assert.equal(counts['ambiguous:submit'], 1);
    assert.equal(solvers.ambiguous, 2); // Reload after submission must not solve again.
    await command('stop');

    await course.goto('https://www.coursera.org/learn/rerender/exam/test/attempt');
    await openPopup();
    await command('courseStart', { speed: 2, skipVideo: true });
    await popup.waitForFunction(() => document.getElementById('feedback').textContent.includes('не сохранила выбранные ответы'));
    assert.equal(counts['rerender:submit'] || 0, 0);
    assert.equal((await command('status')).data.courseRunning, false);

    await course.goto('https://www.coursera.org/learn/hold/exam/test/attempt');
    await openPopup();
    await command('courseStart', { speed: 2, skipVideo: true });
    await popup.waitForFunction(() => document.getElementById('solve').textContent.includes('решает'));
    await command('stop');
    await Promise.race([holdCancelled, new Promise((resolve, reject) => setTimeout(() => reject(new Error('Course stop did not cancel model')), 6000))]);
    assert.equal(counts['hold:submit'] || 0, 0);
    assert.equal(await course.locator('input:checked').count(), 0);
    assert.equal((await command('status')).data.courseRunning, false);
    console.log('COURSE_BROWSER_PASSED (full navigation, paginated quiz, submit/confirm/pass, popup closure, stop, failures and boundaries)');
  } finally {
    if (context) await context.close();
    if (server) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
    assert.equal(path.basename(profile).startsWith('coursera-course-test-'), true);
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
