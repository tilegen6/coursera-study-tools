// Fixed page-world adapter. Only source text and known editor identities cross this boundary.
async function courseraEditorBridge(action, payload = {}) {
  const visible = element => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const notebook = globalThis.Jupyter?.notebook;
  const entries = [];
  let context = '';
  let contextTruncated = false;
  if (notebook?.get_cells) {
    const cells = notebook.get_cells();
    const allowedKey = Symbol.for('coursera.study.editable-cells');
    const allowedCells = globalThis[allowedKey] ||= new WeakSet();
    const fullContext = cells.map((cell, index) => `Cell ${index + 1} (${cell.cell_type}):\n${cell.metadata?.hidden || cell.metadata?.tags?.some(tag => ['hidden', 'grader'].includes(tag)) ? '[protected hidden cell]' : cell.get_text()}`).join('\n\n');
    contextTruncated = fullContext.length > 90000;
    context = fullContext.slice(0, 90000);
    cells.forEach((cell, index) => {
      const starter = cell.get_text();
      if (cell.cell_type !== 'code' || cell.metadata?.editable === false || cell.metadata?.hidden || cell.metadata?.nbgrader?.grade === true || cell.metadata?.nbgrader?.locked === true || cell.metadata?.tags?.some(tag => ['hidden', 'grader'].includes(tag))) return;
      if (!allowedCells.has(cell) && !/YOUR CODE|TODO|NotImplemented|START CODE|GRADED FUNCTION/i.test(starter) && starter.trim() && cell.metadata?.nbgrader?.solution !== true) return;
      allowedCells.add(cell);
      const metadata = cell.metadata || {};
      entries.push({ id: `notebook:${index}`, identity: `${notebook.notebook_path || notebook.notebook_name || ''}:${cell.cell_id || metadata.id || index}:${JSON.stringify({ editable: metadata.editable, deletable: metadata.deletable, tags: metadata.tags, id: metadata.id, nbgrader: metadata.nbgrader })}`, label: `Notebook code cell ${index + 1}`, starter, read: () => cell.get_text(), write: text => cell.set_text(text) });
    });
  } else {
    const editors = globalThis.monaco?.editor?.getEditors?.() || [];
    editors.forEach((editor, index) => {
      const model = editor.getModel();
      if (!model || !visible(editor.getDomNode()) || editor.getRawOptions?.().readOnly) return;
      entries.push({ id: `monaco:${index}`, identity: model.uri.toString(), label: model.uri.path?.split('/').at(-1) || `Code editor ${index + 1}`, starter: model.getValue(), read: () => model.getValue(), write: text => model.setValue(text) });
    });
    [...document.querySelectorAll('.CodeMirror')].forEach((node, index) => {
      const editor = node.CodeMirror;
      if (!editor || !visible(node) || editor.getOption?.('readOnly')) return;
      entries.push({ id: `codemirror:${index}`, identity: node.id || `codemirror-${index}`, label: node.getAttribute('aria-label') || `Code editor ${index + 1}`, starter: editor.getValue(), read: () => editor.getValue(), write: text => { editor.setValue(text); editor.save?.(); } });
    });
  }
  if (entries.length > 80 || entries.some(entry => entry.starter.length > 100000)) throw new Error('Редактор слишком большой.');
  if (['apply', 'run', 'submit', 'interrupt'].includes(action)) {
    const actual = { url: location.origin + location.pathname, fields: entries.map(({ id, identity, starter }) => ({ id, identity, starter })) };
    const expected = payload.expected;
    if (!expected || actual.url !== expected.url || JSON.stringify(actual.fields) !== JSON.stringify(expected.fields)) throw new Error('Редактор или задание изменилось перед действием.');
  }
  if (action === 'apply') {
    if (!Array.isArray(payload.values) || !payload.values.length) throw new Error('Нет значений редактора.');
    const plan = payload.values.map(value => {
      const entry = entries.find(entry => entry.id === value.id);
      if (!entry || entry.identity !== value.identity || entry.read() !== value.starter || typeof value.text !== 'string' || value.text.length > 100000) throw new Error('Редактор или исходный код изменился.');
      return { entry, text: value.text };
    });
    for (const item of plan) item.entry.write(item.text);
    if (plan.some(item => item.entry.read() !== item.text)) throw new Error('Редактор не сохранил код.');
    if (notebook?.save_notebook) await notebook.save_notebook();
    return { applied: true };
  }
  if (action === 'run') {
    if (!entries.length) return { ran: false };
    if (notebook?.execute_all_cells) { notebook.execute_all_cells(); return { ran: true }; }
    const button = [...document.querySelectorAll('button,[role="button"]')].find(element => visible(element) && !element.matches(':disabled') && /^(run tests|run code|run all|test code|запустить тесты|выполнить всё|запустить код)$/i.test((element.getAttribute('aria-label') || element.textContent).trim()));
    if (button) { button.click(); return { ran: true }; }
    return { ran: false };
  }
  if (action === 'interrupt') { notebook?.kernel?.interrupt?.(); return { interrupted: !!notebook?.kernel }; }
  if (action === 'submit') {
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(element => visible(element) && !element.matches(':disabled') && /^(submit|submit assignment|submit solution|отправить|отправить задание|сдать работу)$/i.test((element.getAttribute('aria-label') || element.textContent).trim()));
    if (buttons.length !== 1) throw new Error('Однозначная кнопка отправки в лабораторной не найдена.');
    buttons[0].click();
    return { submitted: true };
  }
  if (action !== 'snapshot') throw new Error('Неизвестное действие редактора.');
  return { url: location.origin + location.pathname, title: document.title, context, contextTruncated, fields: entries.map(({ id, identity, label, starter }) => ({ id, identity, label, starter })), busy: notebook?.kernel?.status === 'busy', feedback: [...document.querySelectorAll('.output_area,.jp-OutputArea,[role="alert"],[role="status"],[data-test="assignment-result"]')].filter(visible).map(element => element.innerText).join('\n').slice(0, 20000) };
}
if (typeof module === 'object' && module.exports) module.exports = { courseraEditorBridge };
