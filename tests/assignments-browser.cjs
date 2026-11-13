const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createBridge } = require('../bridge/server.cjs');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'coursera-assignments-test-'));
const extension=path.join(profile,'extension');
const token = 'd'.repeat(64);
const counts = {}, calls = {};
let graded = false;
const page = body => `<!doctype html><html lang="en"><main>${body}</main></html>`;
function fixture(url) {
  const name = url.pathname.split('/')[2], base = `/learn/${name}`;
  if (url.pathname.includes('/peer/')) {
    if (url.pathname.includes('/review/')) {
      if (url.pathname.endsWith('/result')) return page(`<h1>Review submitted</h1><div role="status">Review submitted</div><a href="${base}/home/completed">Next</a>`);
      return page(`<h1>Review your peer</h1><article data-test="peer-artifact">The submitted solution defines answer() and returns the integer 42, matching the stated requirement.</article><form data-test="peer-review-form"><section data-test="rubric"><fieldset><legend>Correctness: does answer() return 42?</legend><label><input type="radio" name="score" required>No, 0 points</label><label><input type="radio" name="score">Yes, 1 point</label></fieldset></section><label>Feedback<textarea required></textarea></label><button type="button" id="review">Submit review</button></form><script>document.getElementById('review').onclick=async()=>{await fetch('/__event?name=${name}&event=review',{method:'POST',body:JSON.stringify({score:document.querySelector('input:checked')?.parentElement.textContent})});location.href='${base}/peer/other/title/review/r1/result';};</script>`);
    }
    if (url.pathname.endsWith('/submission')) return page(`<h1>Project submission</h1><div role="status">${graded ? 'You passed!' : 'Submitted for review'}</div><a href="${base}/supplement/read/title">Next</a>`);
    if (name === 'missing') return page(`<h1>Peer project</h1><article>Use the missing private dataset and upload the required project.</article><a href="${base}/supplement/read/title">Next</a>`);
    return page(`<h1>Peer project</h1><section data-test="old-result"><h2>You passed!</h2></section><article data-test="assignment-instructions">Write a project title and explain a method for counting the elements of a list. Use the supplied task, without personal claims.</article><form id="answer"><label>Project title<input id="title" type="text" required></label><label>Method<textarea id="method" required></textarea></label><button type="button" id="submit">Submit assignment</button></form><script>document.getElementById('submit').onclick=async()=>{await fetch('/__event?name=${name}&event=peer',{method:'POST',body:JSON.stringify({title:document.getElementById('title').value,method:document.getElementById('method').value})});location.href='${base}/peer/p/title/submission';};</script>`);
  }
  if (url.pathname.includes('/supplement/')) return page(`<h1>Reading</h1><button onclick="this.outerHTML='<button disabled>Completed</button>'">Mark as complete</button><a href="${base}/programming/code/title">Next</a>`);
  if (url.pathname.includes('/programming/')) {
    if (url.pathname.endsWith('/result')) return page(`<h1>Programming result</h1><div role="status">You passed!</div><a href="${base}/lab/l/title">Next</a>`);
    return page(`<h1>Programming assignment</h1><article data-test="assignment-instructions">Create answer.py containing a Python function named answer that returns 42. Upload the source file.</article><form><label>Upload answer.py<input id="source" type="file" accept=".py" required></label><button type="button" id="submit">Submit solution</button></form><script>document.getElementById('submit').onclick=async()=>{const file=document.getElementById('source').files[0];await fetch('/__event?name=${name}&event=code',{method:'POST',body:JSON.stringify({name:file.name,content:await file.text()})});location.href='${base}/programming/code/title/result';};</script>`);
  }
  if (url.pathname.includes('/lab/')) {
    if (url.pathname.endsWith('/result')) return page(`<h1>Lab result</h1><div role="status">You passed!</div><a href="${base}/peer/other/title/review/r1">Next</a>`);
    return page(`<h1>Browser code lab</h1><section data-test="old-result"><h2>You passed!</h2></section><article data-test="assignment-instructions">Implement a Python function answer() that returns 42. Run the tests, then submit the assignment.</article><iframe id="lab" style="width:700px;height:400px" src="https://workspace.labs.coursera.org/editor"></iframe><script>addEventListener('message',async event=>{if(event.origin==='https://workspace.labs.coursera.org' && event.source===document.getElementById('lab').contentWindow && event.data.type==='submitted'){await fetch('/__event?name=${name}&event=lab',{method:'POST',body:JSON.stringify({content:event.data.source,name:'answer.py'})});location.href='${base}/lab/l/title/result';}});</script>`);
  }
  return page('<h1 data-test="course-completed">Course completed</h1>');
}
(async () => {
  let context, server;
  try {
    server = createBridge({ token, solve: async task => {
      assert.equal(task.kind, 'assignment');
      const name = new URL(task.url).pathname.split('/')[2]; calls[name] = (calls[name] || 0) + 1;
      return { status: 'ready', reason: '', values: task.fields.map(field => ({ id: field.id, text: field.type === 'file' ? '' : field.type === 'code' ? 'def answer():\n    return 42\n' : field.label.includes('title') ? 'Counting elements' : 'Iterate through the list, incrementing a counter for each element.', choices: ['radio', 'select', 'checkbox'].includes(field.type) ? [2] : [], files: field.type === 'file' ? [{ name: 'answer.py', content: 'def answer():\n    return 42\n' }] : [] })) };
    } });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    fs.cpSync(path.join(root,'extension'),extension,{recursive:true});
    const worker=path.join(extension,'background.js');
    fs.writeFileSync(worker,fs.readFileSync(worker,'utf8').replace('http://127.0.0.1:43179',`http://127.0.0.1:${server.address().port}`));
    context = await chromium.launchPersistentContext(path.join(profile,'browser'), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    await context.route('https://www.coursera.org/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__event') {
        const key = `${url.searchParams.get('name')}:${url.searchParams.get('event')}`;
        counts[key] = (counts[key] || 0) + 1;
        const body = JSON.parse(route.request().postData());
        if (key.endsWith(':code') || key.endsWith(':lab')) assert.equal(body.content, 'def answer():\n    return 42\n');
        else if (key.endsWith(':review')) assert.equal(body.score, 'Yes, 1 point');
        else assert.equal(body.title, 'Counting elements');
        return route.fulfill({ contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ contentType: 'text/html', body: fixture(url) });
    });
    await context.route('https://workspace.labs.coursera.org/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="editor" style="width:400px;height:200px"></div><button id="run">Run tests</button><button id="submit">Submit assignment</button><div role="status" id="output"></div><script>window.source="# TODO";const model={uri:{path:"/answer.py",toString:()=>"file:///answer.py"},getValue:()=>source,setValue:text=>source=text};window.monaco={editor:{getEditors:()=>[{getModel:()=>model,getDomNode:()=>document.getElementById("editor"),getRawOptions:()=>({readOnly:false})}]}};document.getElementById("run").onclick=()=>document.getElementById("output").textContent=source.includes("return 42")?"Tests passed":"AssertionError";document.getElementById("submit").onclick=()=>parent.postMessage({type:"submitted",source},"https://www.coursera.org");</script>' }));
    const manager = await context.newPage(); await manager.goto('chrome://extensions/');
    const extensionItem = manager.locator('extensions-item').filter({ hasText: 'Coursera Study Tools' }); await extensionItem.waitFor();
    const id = await extensionItem.getAttribute('id');
    const course = await context.newPage();
    let popup;
    async function connect() {
      if (popup && !popup.isClosed()) await popup.close();
      popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`); await popup.setViewportSize({ width: 420, height: 900 });
      await popup.evaluate(token => chrome.storage.local.set({ bridgeToken: token }), token);
      await course.bringToFront(); await popup.evaluate(() => document.getElementById('refresh').click());
      await popup.waitForFunction(() => document.getElementById('dot').classList.contains('connected'));
    }
    await course.goto('https://www.coursera.org/learn/generic/peer/p/title'); await connect();
    await popup.locator('#run-course').click();
    try {
      await course.waitForURL('**/learn/generic/home/completed', { timeout: 60000 });
    } catch(error) {
      console.error('Assignment transition state:',await popup.locator('#feedback').innerText(),await popup.locator('#queue-summary').innerText(),await course.locator('body').innerText());
      throw error;
    }
    await popup.waitForFunction(() => document.getElementById('queue-summary').textContent.includes('проверки: 1'));
    assert.equal(counts['generic:peer'], 1); assert.equal(counts['generic:code'], 1); assert.equal(counts['generic:lab'], 1); assert.equal(counts['generic:review'], 1); assert.equal(calls.generic, 4);
    await popup.waitForTimeout(1500);
    assert.equal(counts['generic:peer'], 1);
    const backups = await popup.evaluate(() => chrome.storage.local.get(null));
    const checkpoint = backups['checkpoint:https://www.coursera.org/learn/generic/'];
    assert.equal(checkpoint.progress.queue[0].status, 'pending_grade');
    assert.equal(JSON.stringify(checkpoint).includes('Iterate through the list'), false);
    fs.mkdirSync(path.join(root, 'output/playwright'), { recursive: true });
    await popup.locator('#queue-items').evaluate(element => element.closest('details').open = true);
    await popup.screenshot({ path: path.join(root, 'output/playwright/assignment-queue.png'), fullPage: true });

    graded = true;
    await course.reload();
    await popup.locator('#check-queue').evaluate(element => element.closest('details').open = true);
    await popup.locator('#check-queue').click();
    await popup.waitForFunction(() => document.getElementById('feedback').textContent.includes('Курс завершён'), null, { timeout: 30000 });
    assert.equal(counts['generic:peer'], 1); assert.equal(counts['generic:code'], 1); assert.equal(counts['generic:lab'], 1); assert.equal(counts['generic:review'], 1); assert.equal(calls.generic, 4);

    await course.goto('https://www.coursera.org/learn/missing/peer/p/title'); await connect();
    await popup.locator('#run-course').click();
    await course.waitForURL('**/learn/missing/home/completed', { timeout: 45000 });
    await popup.waitForFunction(() => document.getElementById('queue-summary').textContent.includes('данные: 1'));
    assert.equal(calls.missing, 3); // Later programming, lab and actual peer review, not the unsupported own peer page.
    assert.equal(counts['missing:peer'] || 0, 0);
    assert.equal(await popup.locator('#run-course').isDisabled(), true); // Waiting remains active, not falsely completed.
    await popup.locator('#stop').click();
    console.log('ASSIGNMENTS_BROWSER_PASSED (peer text, source upload, continued materials, durable pending queue, later grade, no resubmit, needs_input)');
  } finally {
    if (context) await context.close();
    if (server) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
