(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let tabId;
  let refreshing = false;
  let noticeUntil = 0;
  let recoveryPending = false;
  let queueShown = false;
  const connectedButtons = [...document.querySelectorAll('[data-connected]')];

  function feedback(text, error = false, transient = false) {
    $('feedback').textContent = text;
    $('feedback').classList.toggle('error', error);
    if (transient) noticeUntil = Date.now() + 5000;
  }

  function connected(value) {
    connectedButtons.forEach(button => button.disabled = !value);
    $('dot').classList.toggle('connected', value);
    if (!value) $('dot').classList.remove('running');
  }

  async function send(action, data = {}) {
    if (!Number.isInteger(tabId)) throw new Error('Откройте материал курса на Coursera и нажмите ↻.');
    let response;
    try { response = await chrome.tabs.sendMessage(tabId, { source: 'coursera-study-tools', action, data }); }
    catch { throw new Error('Не удалось связаться со страницей. Обновите вкладку курса и нажмите ↻.'); }
    if (!response?.ok) throw new Error(response?.error || 'Страница не ответила.');
    return response.data;
  }

  function render(state, force = false) {
    $('title').textContent = state.title;
    $('kind').textContent = state.course?.phase === 'completed' ? 'Обработка завершена' : ({ video: 'Видеолекция', reading: 'Материал для чтения', practice: 'Практика', manual: 'Тест или пропускаемое задание' })[state.kind];
    $('dot').classList.toggle('running', state.running || state.courseRunning);
    $('start').disabled = state.running || state.solving || state.courseRunning || state.kind === 'manual';
    $('stop').disabled = !state.running && !state.solving && !state.courseRunning && !recoveryPending;
    $('run-course').disabled = state.running || state.solving || state.courseRunning || recoveryPending;
    $('run-course').textContent = recoveryPending ? 'Восстанавливаем запуск…' : state.courseRunning ? `Курс выполняется · завершено: ${state.course?.count || 0}` : 'Пройти курс автоматически';
    $('queue-summary').textContent = `Ожидают проверки: ${state.course?.pending || 0} · Нужны данные: ${state.course?.needsInput || 0} · Пропущено заданий: ${state.course?.skipped || 0}`;
    $('auto-honor-code').disabled = state.courseRunning || state.solving;
    $('target-100').disabled = state.courseRunning || state.solving;
    const queue = state.course?.queue || [];
    $('queue-items').replaceChildren(...queue.map(entry => {
      const li = document.createElement('li');
      const label = ({ skipped: 'Пропущено', pending_grade: 'Ожидает оценки', blocked_dependency: 'Заблокировано', needs_input: 'Нужны данные', failed: 'Не пройдено' })[entry.status] || entry.status;
      let title = document.createElement('span');
      try {
        const url = new URL(entry.url), root = CourseraStudy.courseRoot(state.url);
        if (url.protocol === 'https:' && ['www.coursera.org','coursera.org'].includes(url.hostname) && !url.port && !url.username && !url.password && root && CourseraStudy.courseRoot(url.href) === root) {
          title = document.createElement('a');
          title.href = url.href; title.target = '_blank'; title.rel = 'noopener noreferrer';
        }
      } catch {}
      title.textContent = entry.title || 'Задание';
      li.append(title, document.createTextNode(` — ${label}: ${entry.reason || 'Причина не указана'}${entry.nextCheckAt ? ' · проверка после ' + new Date(entry.nextCheckAt).toLocaleTimeString('ru-RU') : ''}`));
      return li;
    }));
    if (queue.length && !queueShown) { $('queue-items').closest('details').open = true; queueShown = true; }
    $('solve').disabled = state.solving || state.running || state.courseRunning || !state.isQuiz;
    $('solve').textContent = state.solving ? 'Codex решает…' : 'Решить автоматически';
    $('check-queue').disabled = !state.courseRunning;
    $('apply-speed').disabled = !state.hasVideo;
    $('skip').disabled = !state.hasVideo;
    $('complete').disabled = state.kind === 'manual';
    if (force || Date.now() > noticeUntil) feedback(state.message);
    $('logs').replaceChildren(...(state.logs.length ? state.logs.map(item => {
      const li = document.createElement('li');
      li.textContent = `${item.time} · ${item.text}`;
      return li;
    }) : [Object.assign(document.createElement('li'), { textContent: 'Пока нет действий' })]));
  }

  async function connect() {
    connected(false);
    tabId = undefined;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || (tab.url && !CourseraStudy.courseRoot(tab.url))) {
      $('kind').textContent = 'Вкладка Coursera не найдена';
      $('title').textContent = 'Откройте материал курса';
      feedback('Откройте https://www.coursera.org/learn/… в текущем окне браузера.', true);
      return;
    }
    tabId = tab.id;
    try {
      await chrome.tabs.sendMessage(tabId, { source: 'coursera-study-tools', action: 'status' });
    } catch {
      if (!CourseraStudy.courseRoot(tab.url)) throw new Error('Откройте материал курса, обновите страницу и нажмите ↻.');
      await chrome.scripting.executeScript({ target: { tabId }, files: ['core.js', 'queue.js', 'fast-videos.js', 'activity.js', 'course.js', 'content.js'] });
    }
    const state = await send('status');
    if (!CourseraStudy.courseRoot(state.url)) throw new Error('Откройте материал курса на Coursera.');
    connected(true);
    await refreshRecovery();
    render(state, true);
  }
  async function refreshRecovery() {
    try { const response = await chrome.runtime.sendMessage({source:'coursera-study-solver',action:'recoveryStatus'}); recoveryPending = response?.ok && response.data?.running && response.data.tabId === tabId; }
    catch { recoveryPending = false; }
  }

  const settings = () => ({ speed: Number($('speed').value), skipVideo: $('skip-video').checked, autoNext: $('auto-next').checked, resumeQueue: $('resume-queue').checked, autoHonorCode: $('auto-honor-code').checked, target100:$('target-100').checked });
  const saveSettings = () => { const { resumeQueue, ...saved } = settings(); return chrome.storage.local.set({ settings: saved }); };
  function bind(id, action) {
    $(id).addEventListener('click', async () => {
      try { await action(); }
      catch (error) {
        feedback(error.message, true, true);
        const { connectionDiagnostics } = await chrome.storage.local.get('connectionDiagnostics');
        if (connectionDiagnostics) $('connection-diagnostics').textContent = JSON.stringify(connectionDiagnostics, null, 2);
      }
    });
  }

  connected(false);
  bind('refresh', connect);
  bind('start', async () => { await saveSettings(); render(await send('start', settings()), true); });
  bind('run-course', async () => {
    await saveSettings();
    if (await CourseraRecovery.prepare(tabId, settings())) return;
    render(await send('courseStart', settings()), true);
  });
  bind('check-queue', async () => render(await send('queueCheck'), true));
  bind('stop', async () => {
    try { await chrome.runtime.sendMessage({source:'coursera-study-solver',action:'cancelRecovery'}); } catch {}
    recoveryPending=false; render(await send('stop'), true);
  });
  bind('apply-speed', async () => { await saveSettings(); render(await send('speed', settings()), true); });
  for (const action of ['complete', 'next', 'skip']) bind(action, async () => render(await send(action), true));
  bind('solve', async () => render(await send('solve'), true));
  bind('connect-solver', async () => {
    if (await CourseraRecovery.prepare(tabId, settings(), 'connect')) return;
    $('solver-connection').textContent = 'Подключаем локальный сервис…';
    const response = await chrome.runtime.sendMessage({ source:'coursera-study-solver', action:'connect' });
    if (!response?.ok) { $('solver-connection').textContent = 'Автоподключение не выполнено.'; throw new Error(response?.error || 'Не удалось подключиться.'); }
    $('solver-connection').textContent = 'Codex подключён автоматически.';
    feedback('Сервис готов к запуску курса.', false, true);
  });
  bind('connect-manual', async () => {
    const bridgeToken = $('bridge-token').value.trim();
    if (!/^[a-f0-9]{64}$/.test(bridgeToken)) throw new Error('Вставьте полный код из окна Start-Bridge.ps1.');
    const response = await chrome.runtime.sendMessage({ source: 'coursera-study-solver', action: 'health', data: { bridgeToken } });
    if (!response?.ok || response.data?.ready !== true) {
      $('solver-connection').textContent = 'Код не подтверждён. Проверьте локальный сервис.';
      throw new Error(response?.error || 'Не удалось подключиться.');
    }
    await chrome.storage.local.set({ bridgeToken });
    $('bridge-token').value = '';
    $('solver-connection').textContent = 'Codex подключён. Можно решать тесты.';
    feedback('Сервис подключён. Нажмите «Решить автоматически».', false, true);
  });
  for(const id of ['speed','skip-video','auto-next','auto-honor-code','target-100'])$(id).addEventListener('change',()=>saveSettings().catch(error=>feedback(error.message,true)));

  async function init() {
    $('extension-version').textContent = `v${chrome.runtime.getManifest().version}`;
    const stored = await chrome.storage.local.get(['settings', 'fastCourseDefaults']);
    const value = stored.settings || {};
    if (stored.fastCourseDefaults !== true) {
      value.speed = 2; value.skipVideo = true;
      await chrome.storage.local.set({ settings: value, fastCourseDefaults: true });
    }
    if ([1, 1.25, 1.5, 1.75, 2].includes(Number(value.speed))) $('speed').value = String(value.speed);
    $('skip-video').checked = value.skipVideo === true;
    $('auto-next').checked = value.autoNext !== false;
    $('auto-honor-code').checked = value.autoHonorCode === true;
    $('target-100').checked = value.target100 !== false;
    $('resume-queue').checked = false;
    $('solver-connection').textContent = 'Материалы работают сразу. Codex подключится при первом задании.';
    await connect();
    const { recoveryError, connectionDiagnostics } = await chrome.storage.local.get(['recoveryError','connectionDiagnostics']);
    if (connectionDiagnostics) $('connection-diagnostics').textContent = JSON.stringify(connectionDiagnostics, null, 2);
    if (recoveryError) { feedback(recoveryError, true); noticeUntil = Date.now() + 60000; }
  }
  init().catch(error => feedback(error.message, true));
  setInterval(async () => {
    if (!tabId || refreshing) return;
    refreshing = true;
    try { const state = await send('status'); await refreshRecovery(); connected(true); render(state); }
    catch (error) { connected(false); feedback(error.message, true); }
    finally { refreshing = false; }
  }, 1500);
})();
