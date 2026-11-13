const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="monaco" style="width:400px;height:200px"></div><button onclick="window.runs++">Run tests</button>');
    await page.addScriptTag({ path: path.join(__dirname, '../extension/editor-bridge.js') });
    const command = async (action, payload = {}) => {
      if (['apply', 'run', 'submit', 'interrupt'].includes(action) && !payload.expected) {
        const snapshot = await page.evaluate(() => courseraEditorBridge('snapshot'));
        payload.expected = { url: snapshot.url, fields: snapshot.fields.map(({ id, identity, starter }) => ({ id, identity, starter })) };
      }
      return page.evaluate(({ action, payload }) => courseraEditorBridge(action, payload), { action, payload });
    };
    await page.evaluate(() => {
      window.runs = 0; window.source = '# TODO'; window.protectedSource = 'protected';
      const model = { uri: { toString: () => 'file:///answer.py', path: '/answer.py' }, getValue: () => window.source, setValue: text => window.source = text };
      const protectedModel = { ...model, getValue: () => window.protectedSource, setValue: text => window.protectedSource = text };
      window.monaco = { editor: { getEditors: () => [{ getModel: () => model, getDomNode: () => document.getElementById('monaco'), getRawOptions: () => ({ readOnly: false }) }, { getModel: () => protectedModel, getDomNode: () => document.getElementById('monaco'), getRawOptions: () => ({ readOnly: true }) }] } };
    });
    let snapshot = await command('snapshot'); assert.equal(snapshot.fields.length, 1);
    await assert.rejects(() => command('apply', { values: [{ ...snapshot.fields[0], starter: 'stale', text: 'bad' }] }));
    assert.equal(await page.evaluate(() => window.source), '# TODO');
    await command('apply', { values: [{ ...snapshot.fields[0], text: 'def answer():\n    return 42' }] });
    assert.equal(await page.evaluate(() => window.protectedSource), 'protected');
    assert.equal((await command('run')).ran, true); assert.equal(await page.evaluate(() => window.runs), 1);
    const stale = await command('snapshot');
    await page.evaluate(() => { window.monaco.editor.getEditors()[0].getModel().uri.toString = () => 'file:///another.py'; });
    await assert.rejects(() => command('run', { expected: { url: stale.url, fields: stale.fields.map(({ id, identity, starter }) => ({ id, identity, starter })) } }));
    assert.equal(await page.evaluate(() => window.runs), 1);

    await page.setContent('<div class="CodeMirror" id="cm" style="height:100px;width:400px"></div>');
    await page.evaluate(() => {
      delete window.monaco;
      window.source = '# TODO'; window.saved = 0;
      document.getElementById('cm').CodeMirror = { getValue: () => window.source, setValue: text => window.source = text, save: () => window.saved++, getOption: () => false };
    });
    snapshot = await command('snapshot'); assert.equal(snapshot.fields[0].id, 'codemirror:0');
    await command('apply', { values: [{ ...snapshot.fields[0], text: 'SELECT 42;' }] });
    assert.equal(await page.evaluate(() => window.source), 'SELECT 42;'); assert.equal(await page.evaluate(() => window.saved), 1);

    await page.setContent('<div>Classic notebook</div>');
    await page.evaluate(() => {
      window.saved = 0; window.runs = 0;
      const cell = (type, source, metadata, id) => ({ cell_type: type, metadata, cell_id: id, get_text() { return source; }, set_text(text) { source = text; } });
      window.cells = [cell('markdown', 'Implement answer().', {}, 'intro'), cell('code', 'protected_grader()', { editable: false, tags: ['grader'] }, 'grade'), cell('code', 'def answer():\n    # YOUR CODE HERE\n    pass', { editable: true, nbgrader: { grade_id: 'answer' } }, 'solution'), cell('code', '# TODO protected test', { nbgrader: { grade: true } }, 'protected-test')];
      window.Jupyter = { notebook: { notebook_path: 'assignment.ipynb', get_cells: () => window.cells, save_notebook: async () => { window.saved++; }, execute_all_cells: () => { window.runs++; }, kernel: { status: 'idle', interrupt: () => window.interrupted = true } } };
    });
    snapshot = await command('snapshot'); assert.equal(snapshot.fields.length, 1); assert.equal(snapshot.context.includes('protected_grader()'), false);
    const before = await page.evaluate(() => JSON.stringify(window.cells.map(cell => cell.metadata)));
    await command('apply', { values: [{ ...snapshot.fields[0], text: 'def answer():\n    return 42' }] });
    assert.equal(await page.evaluate(() => window.cells[1].get_text()), 'protected_grader()');
    assert.equal(await page.evaluate(() => JSON.stringify(window.cells.map(cell => cell.metadata))), before);
    assert.equal(await page.evaluate(() => window.saved), 1);
    assert.equal((await command('run')).ran, true); await command('interrupt');
    assert.equal(await page.evaluate(() => window.interrupted), true);
    console.log('EDITORS_BROWSER_PASSED (Monaco/CodeMirror/classic-notebook API fixtures; protected metadata and stale source preserved)');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
