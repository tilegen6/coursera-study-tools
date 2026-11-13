(function (root) {
  'use strict';
  const types = ['text', 'number', 'richtext', 'code', 'select', 'radio', 'checkbox', 'file'];
  const statuses = ['pending_grade', 'needs_input', 'blocked_dependency', 'failed', 'completed'];
  const safeName = name => typeof name === 'string' && name.length <= 100 && /^[\w][\w .-]*\.(?:txt|md|csv|json|ipynb|py|r|sql|js|ts|html|css|c|cpp|h|java|xml|yaml|yml)$/i.test(name) && !name.includes('..');

  function validateTask(task) {
    if (!task || task.kind !== 'assignment' || typeof task.url !== 'string' || !/^https:\/\/(?:www\.)?coursera\.org\/learn\//.test(task.url) ||
      !['peer', 'review', 'programming', 'lab', 'generic'].includes(task.type) || typeof task.instructions !== 'string' || task.instructions.length < 10 || task.instructions.length > 100000 ||
      !Array.isArray(task.fields) || !task.fields.length || task.fields.length > 80) throw new Error('Недостаточно доступных данных задания.');
    const ids = new Set();
    for (const field of task.fields) {
      if (!field || typeof field.id !== 'string' || !/^[\w:-]{1,100}$/.test(field.id) || ids.has(field.id) || !types.includes(field.type) ||
        typeof field.label !== 'string' || !field.label || field.label.length > 4000 || typeof field.required !== 'boolean' ||
        !Array.isArray(field.options) || field.options.length > 100 || field.options.some(value => typeof value !== 'string' || value.length > 4000) ||
        typeof field.starter !== 'string' || field.starter.length > 100000 || typeof field.accept !== 'string' || field.accept.length > 1000) throw new Error('Неподдерживаемая структура полей задания.');
      ids.add(field.id);
    }
    if (JSON.stringify(task).length > 200000) throw new Error('Задание слишком большое для одного запроса.');
    return task;
  }

  function validatePlan(plan, task) {
    validateTask(task);
    if (plan?.status === 'needs_input') return { status: 'needs_input', reason: String(plan.reason || 'Модели не хватает данных.').slice(0, 1000), values: [] };
    if (plan?.status !== 'ready' || !Array.isArray(plan.values) || !plan.values.length) throw new Error('Ответ модели не содержит проверяемого решения.');
    const seen = new Set();
    for (const value of plan.values) {
      const field = task.fields.find(field => field.id === value?.id);
      if (!field || seen.has(value.id) || typeof value.text !== 'string' || value.text.length > 100000 || !Array.isArray(value.choices) || !Array.isArray(value.files)) throw new Error('Модель вернула неизвестное или некорректное поле.');
      seen.add(value.id);
      if (['radio', 'checkbox', 'select'].includes(field.type)) {
        if ((field.required && !value.choices.length) || (field.type !== 'checkbox' && value.choices.length !== 1) || new Set(value.choices).size !== value.choices.length || value.choices.some(index => !Number.isInteger(index) || index < 1 || index > field.options.length)) throw new Error('Некорректный выбор вариантов.');
      } else if (field.type === 'file') {
        if ((field.required && !value.files.length) || value.files.length > 5) throw new Error('Не подготовлен обязательный файл.');
        for (const file of value.files) {
          if (!safeName(file?.name) || typeof file.content !== 'string' || !file.content.length || file.content.length > 150000) throw new Error('Недопустимое имя или содержимое файла.');
          const extension = '.' + file.name.split('.').at(-1).toLowerCase();
          const accepted = field.accept.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
          const mime = ({ '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.ipynb': 'application/json', '.py': 'text/x-python', '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.xml': 'application/xml' })[extension];
          if (accepted.length && !accepted.includes(extension) && !accepted.includes('text/*') && !accepted.includes('*/*') && !accepted.includes(mime)) throw new Error('Формат файла не соответствует полю загрузки.');
          if (extension === '.json') { try { JSON.parse(file.content); } catch { throw new Error('JSON-файл содержит некорректный JSON.'); } }
          if (extension === '.ipynb') {
            let notebook;
            try { notebook = JSON.parse(file.content); } catch { throw new Error('Notebook должен быть корректным JSON.'); }
            if (notebook.nbformat !== 4 || !Number.isInteger(notebook.nbformat_minor) || !notebook.metadata || !Array.isArray(notebook.cells) || notebook.cells.some(cell => !['code', 'markdown', 'raw'].includes(cell.cell_type) || !cell.metadata || !Array.isArray(cell.source) || cell.source.some(line => typeof line !== 'string') || (cell.cell_type === 'code' && (!Array.isArray(cell.outputs) || (cell.execution_count !== null && !Number.isInteger(cell.execution_count)))))) throw new Error('Некорректный формат notebook.');
          }
        }
      } else if (field.required && !value.text.trim()) throw new Error('Не заполнено обязательное поле.');
      if (field.type === 'number' && (!value.text.trim() || !Number.isFinite(Number(value.text)))) throw new Error('Числовое поле требует число.');
      if (field.type !== 'file' && value.files.length) throw new Error('Файл возвращён для другого типа поля.');
    }
    if (task.fields.some(field => field.required && !seen.has(field.id))) throw new Error('Модель пропустила обязательное поле.');
    if (JSON.stringify(plan).length > 200000) throw new Error('Ответ задания слишком большой.');
    return plan;
  }

  function updateQueue(queue, entry, now = Date.now()) {
    if (!statuses.includes(entry.status) || typeof entry.key !== 'string' || typeof entry.url !== 'string') throw new Error('Некорректное состояние очереди.');
    const prior = queue.find(item => item.key === entry.key);
    const checks = entry.checks ?? (prior?.checks || 0);
    const delay = [60000, 120000, 300000, 600000, 1800000][Math.min(checks, 4)];
    const nextCheckAt = ['pending_grade', 'blocked_dependency'].includes(entry.status) ? now + delay : null;
    return [...queue.filter(item => item.key !== entry.key), { ...prior, ...entry, checks, checkedAt: now, nextCheckAt, manualCheck: false, reason: String(entry.reason || '').slice(0, 1000) }];
  }

  function due(queue, now = Date.now()) {
    return queue.filter(item => (['pending_grade', 'blocked_dependency'].includes(item.status) || item.manualCheck) && Number.isFinite(item.nextCheckAt) && item.nextCheckAt <= now).sort((a, b) => a.nextCheckAt - b.nextCheckAt)[0] || null;
  }

  const api = { validateTask, validatePlan, safeName, updateQueue, due };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CourseraAssignments = api;
})(globalThis);
