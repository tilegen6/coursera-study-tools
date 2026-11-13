const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createBridge, PORT } = require('../bridge/server.cjs');
const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'extension');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'coursera-study-test-'));
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });
// Real, tiny PCM media also works across the extension's isolated JS world.
const wav = Buffer.alloc(44 + 8000 * 2 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
const media = `data:audio/wav;base64,${wav.toString('base64')}`;
const reading = `<!doctype html><html lang="en"><main><h1>Learning, at your pace</h1><p>Sample reading material.</p><button id="complete">Mark as complete</button><a href="/learn/demo/lecture/video/intro">Next</a><script>document.querySelector('#complete').onclick = event => { event.target.outerHTML = '<button disabled>Completed</button>'; };</script></main></html>`;
const video = `<!doctype html><main><h1>Video lesson</h1><video src="${media}" controls style="width:500px;height:200px"></video><a href="/learn/demo/quiz/q/test">Next</a></main>`;
const quiz = `<!doctype html><main><h1>Practice quiz</h1>
<fieldset><legend>Which value is even?</legend><label><input type="radio" name="q1" value="a">Three</label><label><input type="radio" name="q1" value="b">Four</label></fieldset>
<fieldset><legend>Select prime numbers</legend><label><input type="checkbox" value="a">Two</label><label><input type="checkbox" value="b">Three</label><label><input type="checkbox" value="c">Four</label></fieldset>
<fieldset><legend>What is 6 × 7?</legend><label>Answer <input type="text"></label></fieldset>
<button id="submit" onclick="document.body.dataset.submitted='true'">Submit</button><a href="https://evil.example/learn/demo/lecture/a/a">Next</a></main>`;

(async () => {
  let context, server;
  const bridgeToken = 'b'.repeat(64);
  let hold = false, release, aborted;
  try {
    server = createBridge({ token: bridgeToken, solve: async (quiz, signal) => {
      const output = { status: 'solved', answers: quiz.questions.map(question => ({ id: question.id, choices: question.type === 'radio' ? [2] : question.type === 'checkbox' ? [1, 2] : [], text: question.type === 'text' ? '42' : '' })) };
      if (!hold) return output;
      return new Promise((resolve, reject) => {
        release = () => resolve(output);
        aborted = new Promise(abortResolve => signal.addEventListener('abort', () => { abortResolve(); reject(new Error('cancelled')); }, { once: true }));
      });
    } });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--autoplay-policy=no-user-gesture-required'],
      viewport: { width: 1000, height: 900 }
    });
    const errors = [];
    await context.route('https://www.coursera.org/**', route => {
      const url = new URL(route.request().url());
      const body = url.pathname.includes('/quiz/') ? quiz : url.pathname.includes('/lecture/') ? video : reading;
      return route.fulfill({ contentType: 'text/html', body });
    });
    const management = await context.newPage();
    await management.goto('chrome://extensions/');
    const item = management.locator('extensions-item').filter({ hasText: 'Coursera Study Tools' });
    await item.waitFor();
    const id = await item.getAttribute('id');
    assert.match(id, /^[a-p]{32}$/);
    const course = await context.newPage();
    await course.goto('https://www.coursera.org/learn/demo/supplement/read/intro');
    let popup = await context.newPage();
    popup.on('pageerror', error => errors.push(error.message));
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.setViewportSize({ width: 420, height: 820 });
    await course.bringToFront();
    await popup.evaluate(() => document.getElementById('refresh').click());
    await popup.waitForFunction(() => document.getElementById('kind').textContent === 'Материал для чтения')
      .catch(async error => { console.error(await popup.locator('body').innerText()); throw error; });
    const courseId = await popup.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0].id;
    });
    assert.equal(await popup.locator('#speed').inputValue(), '2');
    assert.equal(await popup.locator('#skip-video').isChecked(), true);
    async function command(action, data = {}) {
      const result = await popup.evaluate(async ({ courseId, action, data }) => chrome.tabs.sendMessage(courseId, { source: 'coursera-study-tools', action, data }), { courseId, action, data });
      assert.equal(typeof result.ok, 'boolean');
      return result;
    }

    // Real extension messaging and DOM action, not a mocked Chrome API.
    assert.equal((await command('complete')).ok, true);
    await course.locator('main button:disabled').waitFor();
    assert.equal((await command('backup')).data.text.includes('Sample reading material.'), true);
    assert.equal((await command('shareLink')).ok, false);
    assert.equal((await command('notACommand')).ok, false);

    // Automatic reading completion -> SPA video navigation -> stop before quiz.
    await course.goto('https://www.coursera.org/learn/demo/supplement/read/intro');
    await course.evaluate(media => {
      document.querySelector('a').onclick = event => {
        event.preventDefault();
        history.pushState({}, '', '/learn/demo/lecture/video/intro');
        document.querySelector('main').innerHTML = '<h1>Video lesson</h1><video controls style="width:500px;height:200px"></video><a href="/learn/demo/quiz/q/test">Next</a>';
        const player = document.querySelector('video');
        player.src = media;
        void player.play();
      };
    }, media);
    assert.equal((await command('start', { speed: 1.5 })).ok, true);
    await course.waitForURL('**/lecture/video/intro');
    await popup.waitForFunction(() => document.getElementById('feedback').textContent.includes('Дальше задание'));
    const stopped = (await command('status')).data;
    assert.match(stopped.message, /Дальше задание/);
    assert.equal(course.url().includes('/lecture/'), true);

    // Stop means no subsequent completion click.
    await course.goto('https://www.coursera.org/learn/demo/supplement/read/intro');
    // Keep the document pending until Stop; a completed reading may already navigate before Stop arrives.
    await course.evaluate(() => { document.querySelector('#complete').remove(); document.querySelector('a').remove(); });
    assert.equal((await command('start')).ok, true);
    assert.equal((await command('stop')).data.running, false);
    await course.evaluate(() => { document.querySelector('main').innerHTML = '<button onclick="document.body.dataset.clicked=1">Mark as complete</button>'; });
    await popup.waitForTimeout(900);
    assert.equal(await course.getAttribute('body', 'data-clicked'), null);

    await course.goto('https://www.coursera.org/learn/demo/quiz/q/test');
    assert.equal((await command('start')).ok, false);
    assert.equal((await command('complete')).ok, false);
    assert.equal((await command('next')).ok, false);
    const exported = await command('quizExport');
    assert.equal(exported.ok, true);
    assert.equal(exported.data.questions.length, 3);
    assert.deepEqual(exported.data.questions[0].options, ['Three', 'Four']);
    const answers = { answers: exported.data.questions.map(question => question.type === 'text'
      ? { id: question.id, question: question.question, text: '42' }
      : { id: question.id, question: question.question, options: question.options, choices: question.type === 'radio' ? [2] : [1, 2] }) };
    const wrong = structuredClone(answers);
    wrong.answers[2].question = 'Stale question';
    assert.equal((await command('quizApply', { raw: JSON.stringify(wrong) })).ok, false);
    assert.equal(await course.locator('input:checked').count(), 0);
    assert.equal((await command('quizApply', { raw: JSON.stringify(answers) })).ok, true);
    assert.equal(await course.locator('input:checked').count(), 3);
    assert.equal(await course.locator('input[type=text]').inputValue(), '42');
    assert.equal(await course.getAttribute('body', 'data-submitted'), null);

    // A review link alone is not evidence that this is the user's submission.
    await course.goto('https://www.coursera.org/learn/demo/peer/work/title/submission');
    await course.locator('main').evaluate(element => {
      element.innerHTML = '<a href="/learn/other/peer/work/title/review/foreign">Shareable link</a><a href="/learn/demo/peer/work/title/review/another">Review a peer</a>';
    });
    assert.equal((await command('shareLink')).ok, false);
    await course.locator('main').evaluate(element => element.insertAdjacentHTML('beforeend', '<a href="/learn/demo/peer/work/title/review/mine">Shareable link</a>'));
    assert.equal((await command('shareLink')).data, 'https://www.coursera.org/learn/demo/peer/work/title/review/mine');
    await course.locator('main').evaluate(element => element.insertAdjacentHTML('beforeend', '<a href="/learn/demo/peer/work/title/review/ambiguous">Shareable link</a>'));
    assert.equal((await command('shareLink')).ok, false);
    await course.goto('https://www.coursera.org/learn/demo/quiz/q/test');

    // Popup export and apply exercise actual event handlers.
    await course.bringToFront();
    await popup.evaluate(() => document.getElementById('refresh').click());
    await popup.waitForFunction(() => document.getElementById('kind').textContent.includes('Задания и тесты'));
    await popup.locator('#quiz-section').evaluate(element => element.open = true);
    await popup.locator('#export-quiz').click();
    await popup.waitForFunction(() => document.getElementById('exchange').value.includes('Which value is even?'));
    await popup.locator('#exchange').fill(JSON.stringify(answers));
    await popup.locator('#apply-answers').click();
    await popup.waitForFunction(() => document.getElementById('feedback').textContent.includes('Заполнено вопросов: 3'));
    await popup.screenshot({ path: path.join(output, 'quiz.png'), fullPage: true });

    // Configure once, then solve without copying a prompt or keeping the popup open.
    await popup.locator('.solver-settings').evaluate(element => element.open = true);
    await popup.locator('#bridge-token').evaluate(element => element.closest('details').open = true);
    await popup.locator('#bridge-token').fill(bridgeToken);
    await popup.locator('#connect-manual').click();
    await popup.waitForFunction(() => document.getElementById('solver-connection').textContent.includes('Codex подключён'));
    assert.equal(await popup.locator('#bridge-token').inputValue(), '');
    await popup.locator('#bridge-token').fill('a'.repeat(64));
    await popup.locator('#connect-manual').click();
    await popup.waitForFunction(() => document.getElementById('solver-connection').textContent.includes('не подтверждён'));
    assert.equal(await popup.evaluate(async () => (await chrome.storage.local.get('bridgeToken')).bridgeToken), bridgeToken);
    await popup.locator('#bridge-token').fill(bridgeToken);
    await popup.locator('#connect-manual').click();
    await popup.waitForFunction(() => document.getElementById('solver-connection').textContent.includes('Codex подключён'));
    await course.goto('https://www.coursera.org/learn/demo/quiz/q/test');
    await popup.locator('#solve').click();
    await popup.waitForFunction(() => document.getElementById('solve').textContent.includes('решает'));
    await popup.close();
    await course.waitForFunction(() => document.querySelectorAll('input:checked').length === 3);
    assert.equal(await course.locator('input[type=text]').inputValue(), '42');
    assert.equal(await course.getAttribute('body', 'data-submitted'), null);
    popup = await context.newPage();
    popup.on('pageerror', error => errors.push(error.message));
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await course.bringToFront();
    await popup.evaluate(() => document.getElementById('refresh').click());
    await popup.waitForFunction(() => document.getElementById('kind').textContent.includes('Задания и тесты'));
    assert.equal((await command('status')).data.solving, false);
    await popup.locator('#quiz-section').evaluate(element => element.open = true);
    await popup.setViewportSize({ width: 420, height: 820 });
    await popup.screenshot({ path: path.join(output, 'automatic-quiz.png'), fullPage: true });

    // Cancellation terminates the job and prevents subsequent field changes.
    hold = true;
    await course.goto('https://www.coursera.org/learn/demo/quiz/q/test');
    assert.equal((await command('solve')).data.solving, true);
    await command('stop');
    await Promise.race([aborted, new Promise((resolve, reject) => setTimeout(() => reject(new Error('Cancellation did not reach bridge')), 3000))]);
    assert.equal(await course.locator('input:checked').count(), 0);
    assert.equal((await command('status')).data.solving, false);

    // Same URL/text/options with a changed input type is still a stale snapshot.
    assert.equal((await command('solve')).data.solving, true);
    await course.locator('input[type=radio]').evaluateAll(elements => elements.forEach(element => element.type = 'checkbox'));
    release();
    await popup.waitForFunction(() => document.getElementById('feedback').textContent.includes('Вопросы или варианты изменились'));
    assert.equal(await course.locator('input:checked').count(), 0);
    assert.equal((await command('status')).data.solving, false);
    hold = false;

    // Invalid numeric model text is rejected before any other answer is selected.
    await course.goto('https://www.coursera.org/learn/demo/quiz/q/test');
    await course.locator('input[type=text]').evaluate(element => element.type = 'number');
    const invalidNumber = structuredClone(answers);
    invalidNumber.answers[2].text = 'forty-two';
    assert.equal((await command('quizApply', { raw: JSON.stringify(invalidNumber) })).ok, false);
    assert.equal(await course.locator('input:checked').count(), 0);
    assert.equal((await command('quizApply', { raw: JSON.stringify(answers) })).ok, true);
    assert.equal(await course.locator('input[type=number]').inputValue(), '42');

    // Native media playback and seeking across the isolated extension world.
    await course.goto('https://www.coursera.org/learn/demo/lecture/video/intro');
    assert.equal((await command('speed', { speed: 2 })).ok, true);
    assert.equal(await course.locator('video').evaluate(element => element.playbackRate), 2);
    assert.equal((await command('speed', { speed: 100 })).ok, false);
    await course.locator('video').evaluate(element => { element.removeAttribute('src'); element.load(); });
    assert.equal((await command('skip')).ok, false); // Not loaded.
    await course.locator('video').evaluate((element, media) => { element.src = media; element.load(); }, media);
    await course.waitForFunction(() => document.querySelector('video').seekable.length > 0);
    assert.equal((await command('skip')).ok, true);
    assert.equal(await course.locator('video').evaluate(element => element.currentTime >= 1.75), true);

    // Popup connection failure is a visible actionable error.
    const unrelated = await context.newPage();
    await unrelated.goto('about:blank');
    await popup.evaluate(() => document.getElementById('refresh').click());
    await popup.waitForFunction(() => document.getElementById('feedback').classList.contains('error'));
    assert.equal(await popup.locator('#start').isDisabled(), true);
    assert.equal(errors.length, 0, errors.join('\n'));

    // Capture the default connected UI at its true popup width.
    await course.goto('https://www.coursera.org/learn/demo/supplement/read/intro');
    await course.bringToFront();
    await popup.evaluate(() => {
      document.querySelectorAll('details').forEach(element => element.open = false);
      document.getElementById('refresh').click();
    });
    await popup.waitForFunction(() => document.getElementById('kind').textContent === 'Материал для чтения');
    await popup.setViewportSize({ width: 420, height: 820 });
    assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth), 420);
    await popup.screenshot({ path: path.join(output, 'popup.png'), fullPage: true });
    await popup.locator('#backup').evaluate(element => element.closest('details').open = true);
    const downloadEvent = popup.waitForEvent('download');
    await popup.locator('#backup').click();
    const download = await downloadEvent;
    const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(backup.text.includes('Sample reading material.'), true);
    assert.equal(backup.links[0].url.includes('/learn/demo/lecture/'), true);
    console.log('BROWSER_CHECKS_PASSED (real unpacked extension; local fixtures; no live course)');
  } finally {
    if (context) await context.close();
    if (server) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
    assert.equal(path.basename(profile).startsWith('coursera-study-test-'), true);
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
