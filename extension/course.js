(() => {
  'use strict';
  const { activityKind, itemKey, quizResult, quizSnapshot } = globalThis.CourseraStudy;
  const { updateQueue, due } = globalThis.CourseraQueue;

  function create(adapter) {
    let run = null, timer, busy = false, starting = false, generation = 0, pendingId = null, pendingWake = false, unwatch;
    let filledHash = null, filledAnswers = null;
    let observedUrl=location.href,observedContent=adapter.materialIdentity?.(),changingAt=0;
    const inspectedModules = new Set();
    let last = { count: 0, phase: 'idle', pending: 0, needsInput: 0, queue: [] };
    const current = task => run === task;
    const fail = message => { throw new Error(message); };
    const questionSelector = '[data-test="question"], [data-testid="question"], .rc-FormPartsQuestion, .rc-QuizQuestion, fieldset, [role="radiogroup"], [role="group"][aria-labelledby]';
    const untrustedContent = questionSelector + ',[data-testid="chat-message-llm"],[data-testid="chat-message-user"],[data-testid="peer-artifact"],[data-test="peer-artifact"],.rc-PeerSubmission';
    const excluded = url => !['video','reading','practice','quiz','assessment','outline'].includes(activityKind(new URL(url).pathname));
    const confirmationNeeded = task => { adapter.confirmHonor?.(task.settings.autoHonorCode === true,()=>current(task));return adapter.personalConfirmation?.(); };
    const submitLabel = /^(submit|submit (?:answers|quiz|assessment|all)|отправить|отправить (?:ответы|тест|решение))$/i;
    const submitButton = () => adapter.buttons().find(element => element.tagName === 'BUTTON' && submitLabel.test(adapter.label(element)) && (!element.closest('[role="dialog"], dialog') || element.closest('[role="dialog"], dialog') === adapter.scope()));
    const pageButton = () => adapter.buttons().find(element => element.tagName === 'BUTTON' && /^(next|next question|next page|далее|следующий вопрос|следующая страница)$/i.test(adapter.label(element)) && !!element.closest('form, [data-test="quiz-form"]'));
    const openButton = () => adapter.buttons().find(element => /^(start|start (?:quiz|attempt|assignment)|begin (?:quiz|attempt|assignment)|resume (?:quiz|attempt|assignment)|continue (?:attempt|assignment)|начать (?:тест|попытку|задание)|(?:продолжить|возобновить) (?:тест|попытку|задание))$/i.test(adapter.label(element)));
    const summary = progress => {
      const queue = (progress.queue || []).filter(entry => entry.status !== 'completed');
      return { count: progress.visited.length, phase: progress.phase, pending: queue.filter(entry => ['pending_grade', 'blocked_dependency'].includes(entry.status)).length, skipped: queue.filter(entry=>entry.status==='skipped').length, needsInput: queue.filter(entry => ['needs_input', 'failed'].includes(entry.status)).length, queue: queue.map(({ key, url, title, status, reason, nextCheckAt }) => ({ url, title: title || progress.inventory?.find(item=>item.key===key)?.title, status, reason, nextCheckAt })) };
    };

    function click(task, element) {
      if (!current(task) || !element?.isConnected || !adapter.enabled(element)) return false;
      if (itemKey(location.href) !== task.progress.item) fail('Материал изменился до выполнения действия.');
      if (element.href && !new URL(element.href, location.href).href.startsWith(task.scope)) fail('Ссылка ведёт за пределы текущего курса.');
      element.click();
      return true;
    }

    async function request(action, data = {}) {
      const response = await chrome.runtime.sendMessage({ source: 'coursera-study-course', action, data: { ...data, accountHint: adapter.accountHint?.() || '' } });
      if (!response?.ok) fail(response?.error || 'Сеанс курса недоступен.');
      return response.data;
    }

    async function save(task, patch) {
      if (!current(task)) fail('Сеанс остановлен.');
      const progress = { ...task.progress, ...patch };
      await request('save', { runId: task.id, progress });
      if (!current(task)) fail('Сеанс остановлен.');
      if (itemKey(location.href) !== progress.item) fail('Материал изменился во время сохранения действия.');
      task.progress = progress;
      last = summary(progress);
    }

    async function stop(reason = 'Прохождение курса остановлено') {
      generation++;
      starting = false;
      const previous = run;
      const runId = previous?.id || pendingId;
      run = null;
      pendingId = null;
      clearInterval(timer);
      unwatch?.();unwatch=null;pendingWake=false;
      filledHash = null;
      filledAnswers = null;
      adapter.cancel();
      last.phase = 'stopped';
      adapter.log(reason);
      if (runId) {
        try { await request('stop', { runId, reason }); } catch { /* A newer run may already own this tab. */ }
      }
    }

    function activate(record) {
      run = record;
      inspectedModules.clear();
      record.progress.queue ||= [];
      record.progress.inventory ||= [];
      record.progress.visited = [...new Set(record.progress.visited.map(key=>itemKey(key)||key))].filter(key=>!excluded(key));
      record.progress.inventory = [...new Map(record.progress.inventory.map(entry=>[itemKey(entry.url),{...entry,key:itemKey(entry.url),kind:activityKind(new URL(entry.url).pathname)}])).values()];
      record.progress.queue=record.progress.queue.map(entry=>excluded(entry.url)?{...entry,status:'skipped',reason:'Задания отключены: обрабатываются только материалы и тесты.',actionRequired:null,manualCheck:false,nextCheckAt:null}:entry);
      record.progress.queue=record.progress.queue.map(entry=>activityKind(new URL(entry.url).pathname)==='assessment'&&entry.status==='skipped'&&entry.quizRecognitionVersion!==3?{...entry,status:'blocked_dependency',manualCheck:true,nextCheckAt:Date.now(),quizRecognitionVersion:3,reason:'Повторно проверяем обложку: тест мог быть ошибочно пропущен прежней версией.'}:entry);
      record.progress.queue=record.progress.queue.map(entry=>['quiz','assessment'].includes(activityKind(new URL(entry.url).pathname))&&entry.status==='needs_input'&&!entry.actionRequired&&entry.solverRecoveryVersion!==2&&/^Модель не смогла уверенно ответить на весь тест/.test(entry.reason||'')?{...entry,status:'blocked_dependency',manualCheck:true,nextCheckAt:Date.now(),solverRecoveryVersion:2,reason:'Повторно решаем тест после исправления изображений и анализа длинных тестов.'}:entry);
      if(record.settings.target100===true&&record.progress.perfectScoreVersion!==1){
        record.progress.visited=record.progress.visited.filter(key=>!['quiz','assessment'].includes(activityKind(new URL(key).pathname))||record.progress.quizReviews?.[key]?.score===100);
        record.progress.queue=record.progress.queue.map(entry=>['quiz','assessment'].includes(activityKind(new URL(entry.url).pathname))&&entry.status==='failed'?{...entry,status:'blocked_dependency',manualCheck:true,nextCheckAt:Date.now(),reason:'Проверяем оценку и доступность новой попытки для цели 100%.'}:entry);
        record.progress.perfectScoreVersion=1;
      }
      if(record.progress.feedbackRetakeRecoveryVersion!==2){
        record.progress.queue=record.progress.queue.map(entry=>{
          const pending=record.progress.retakePending?.[entry.key];
          if(entry.status!=='needs_input'||!pending||pending.confirmed||pending.before!==(record.progress.attempts?.[entry.key]||0)||!/^Новая попытка не открылась/.test(entry.reason||'')||!/\/view-feedback\/?$/.test(new URL(entry.url).pathname))return entry;
          record.progress.retakePending={...record.progress.retakePending,[entry.key]:null};
          return {...entry,status:'blocked_dependency',manualCheck:true,nextCheckAt:Date.now(),reason:'Повторяем запуск после исправления возврата из разбора на обложку.'};
        });
        record.progress.feedbackRetakeRecoveryVersion=2;
      }
      if(record.settings.target100===true&&record.progress.feedbackResultRecoveryVersion!==3){
        record.progress.queue=record.progress.queue.map(entry=>entry.status==='pending_grade'&&['quiz','assessment'].includes(activityKind(new URL(entry.url).pathname))&&record.progress.submitted.some(submission=>itemKey(submission.item)===entry.key)?{...entry,manualCheck:true,nextCheckAt:Date.now(),reason:'Проверяем актуальную оценку отправленного теста после исправления ожидания результата.'}:entry);
        record.progress.feedbackResultRecoveryVersion=3;
      }
      if(record.settings.target100===true&&record.progress.quizControlRecoveryVersion!==1){
        record.progress.queue=record.progress.queue.map(entry=>entry.status==='needs_input'&&!entry.actionRequired&&!record.progress.retakePending?.[entry.key]&&['quiz','assessment'].includes(activityKind(new URL(entry.url).pathname))&&/^(?:Не удалось вернуться из разбора к результату\.|Оценка [\d.,]+%\. Не найдена поддерживаемая кнопка новой попытки|Итоговая оценка не прочитана\.)/.test(entry.reason||'')?{...entry,status:'blocked_dependency',manualCheck:true,nextCheckAt:Date.now(),reason:'Повторно проверяем загрузку результата и кнопок теста без повторной отправки.'}:entry);
        record.progress.quizControlRecoveryVersion=1;
      }
      pendingId = null;
      filledHash = null;
      filledAnswers = null;
      if (record.progress.item === itemKey(location.href) && ['video-wait', 'video-confirming', 'marking'].includes(record.progress.phase)) {
        record.progress.phase = 'lesson';
        record.progress.actionAt = Date.now();
      }
      if(record.progress.phase==='fast-reloading')record.progress.phase='lesson';
      if(record.progress.phase==='result-waiting'&&record.progress.item===itemKey(location.href))record.progress.actionAt=Date.now();
      last = summary(record.progress);
      clearInterval(timer);
      unwatch?.();unwatch=adapter.watch?.(()=>void tick());
      timer = setInterval(() => void tick(), 750);
      void tick();
    }

    async function start(settings) {
      const previousStop = stop('Подключение полного режима курса');
      const version = ++generation;
      starting = true;
      const id = crypto.randomUUID();
      pendingId = id;
      try {
        await previousStop;
        if (version !== generation) return;
        const record = await request('start', { settings, runId: id });
        if (version !== generation) {
          await request('stop', { runId: record.id });
          return;
        }
        starting = false;
        adapter.log('Запущена обработка материалов и тестов. Остальные задания пропускаются.');
        activate(record);
      } catch (error) {
        if (version === generation) { starting = false; pendingId = null; adapter.log(error.message); }
        throw error;
      }
    }

    async function resume() {
      const version = generation;
      try {
        const record = await request('resume');
        if(record?.inactive){if(version===generation&&!run&&!starting)adapter.log(record.reason);return;}
        if (record && version === generation && !run && !starting) {
          adapter.log('Продолжаем сеанс курса после загрузки страницы.');
          activate(record);
        }
      } catch(error) { if(version===generation&&!run&&!starting)adapter.log(`Не удалось восстановить сеанс: ${error.message}`); }
    }

    function courseDone() {
      if ([...adapter.scope().querySelectorAll('[data-test="course-completed"], [data-testid="course-completed"]')].some(element=>adapter.visible(element)&&!element.closest?.(untrustedContent))) return true;
      return [...adapter.scope().querySelectorAll('h1, h2')].filter(adapter.visible).some(element => !element.closest(untrustedContent) && /^(?:congratulations[!,]?\s*)?(?:you(?:'ve| have) completed (?:this|the) course|course completed|курс (?:успешно )?заверш[её]н)[!.\s]*$/i.test(adapter.label(element)));
    }

    function result() {
      const areas = [...adapter.scope().querySelectorAll('[data-test="quiz-result"], [data-testid="quiz-result"], .rc-QuizSubmissionGradeInfo, .rc-GradeSummary')].filter(adapter.visible);
      const headings = [...adapter.scope().querySelectorAll('h1, h2, [role="status"]')].filter(element => adapter.visible(element) && !element.closest(questionSelector));
      return quizResult([...areas, ...headings].map(element => element.innerText || element.textContent).join('\n'));
    }

    async function fingerprint() {
      const questions = adapter.quizExport().questions;
      return hash(quizSnapshot(questions));
    }
    async function hash(value) { const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join(''); }

    function availableLinks(task) {
      return [...document.querySelectorAll('a[href]')].filter(element => {
        if (!adapter.visible(element) || !element.href.startsWith(task.scope) || element.closest(untrustedContent)) return false;
        const kind = activityKind(new URL(element.href).pathname);
        if (kind === 'outline') return false;
        if (kind !== 'manual') return true;
        const relative = new URL(element.href).pathname.slice(new URL(task.scope).pathname.length);
        return !!element.closest('[data-testid="left-nav"]') && /^[^/]+\/[^/]+/.test(relative) && !/^(?:home|resources|discussions|announcements|info|grades)\//.test(relative);
      });
    }

    async function observeItems(task, items = []) {
      const inventory = new Map(task.progress.inventory.map(entry => [entry.key, entry]));
      const visited = new Set(task.progress.visited);
      let queue = task.progress.queue;
      const observed = [...availableLinks(task).map(link => ({ url: link.href, title: adapter.label(link), completed: adapter.itemCompleted?.(link)===true, sidebar: !!link.closest('[data-testid="left-nav"]'), locked: !adapter.enabled(link) || !!link.closest('[aria-disabled="true"],[data-locked="true"],.locked') || /locked|заблокирован/i.test(link.getAttribute('aria-label') || '') })), ...items];
      for (const entry of observed) {
        let url;try { url = new URL(entry.url); } catch { continue; }
        if (!url.href.startsWith(task.scope)) continue;
        const kind = activityKind(url.pathname), key = itemKey(url.href);
        if (kind === 'outline' || (kind === 'manual' && !entry.sidebar)) continue;
        const title = String(entry.title || url.pathname.split('/').filter(Boolean).at(-1)).slice(0, 200);
        if (kind !== 'video') inventory.set(key, { key, url: url.href, title, kind });
        if(excluded(url.href)){if(!queue.some(item=>item.key===key&&item.status==='skipped'))queue=updateQueue(queue,{key,url:url.href,title,status:'skipped',reason:'Задания отключены: обрабатываются только материалы и тесты.'});continue;}
        const quiz=['quiz','assessment'].includes(kind);
        if((entry.completed && (!quiz || task.settings.target100!==true)) || (quiz && task.progress.quizReviews?.[key]?.score===100)){
          visited.add(key);
          if(queue.some(item=>item.key===key&&item.status!=='completed'))queue=updateQueue(queue,{key,url:url.href,title,status:'completed',reason:'Coursera подтвердила выполнение; повторная обработка не требуется.',actionRequired:null});
          continue;
        }
        if (task.progress.visited.includes(key) || queue.some(item => item.key === key)) continue;
        if (entry.locked || kind === 'manual') queue = updateQueue(queue, { key, url: url.href, title, status: entry.locked ? 'blocked_dependency' : 'needs_input', reason: entry.locked ? 'Материал помечен как заблокированный; проверим после других заданий.' : 'Для этого формата задания пока нет автоматического обработчика. Откройте задание для выполнения.' });
      }
      const next = [...inventory.values()];
      if (JSON.stringify(next) !== JSON.stringify(task.progress.inventory) || queue !== task.progress.queue || visited.size!==task.progress.visited.length) await save(task, { inventory: next, queue, visited:[...visited] });
    }

    function candidateItem(task) {
      return task.progress.inventory.find(entry => !excluded(entry.url) && entry.key !== itemKey(location.href) && !task.progress.visited.includes(entry.key) && !task.progress.queue.some(item => item.key === entry.key && item.status !== 'completed'));
    }

    function nextModule() {
      const key = element => element.id || adapter.label(element.querySelector('[data-testid="module-number-heading"]'));
      return [...document.querySelectorAll('[data-testid="left-nav"] button[aria-expanded="false"]')].find(element => adapter.enabled(element) && element.querySelector('[data-testid="module-number-heading"]') && !inspectedModules.has(key(element)));
    }

    function discoverLocks(task) {
      let queue = task.progress.queue;
      for (const link of availableLinks(task)) {
        const key = itemKey(link.href);
        if (task.progress.visited.includes(key) || queue.some(entry => entry.key === key)) continue;
        if (link.closest('[aria-disabled="true"],[data-locked="true"],.locked') || /locked|заблокирован/i.test(link.getAttribute('aria-label') || '')) {
          queue = updateQueue(queue, { key, url: link.href, status: 'blocked_dependency', reason: 'Материал помечен как заблокированный; проверим после других заданий.' });
        }
      }
      return queue;
    }

    async function navigate(task, url, recheckingKey = null) {
      if (!url.startsWith(task.scope)) fail('Ссылка ведёт за пределы текущего курса.');
      const same = itemKey(url) === itemKey(location.href);
      const retryUnsubmitted = recheckingKey && !task.progress.submitted.some(entry => entry.item === recheckingKey);
      await save(task, { phase: same ? 'checking' : 'advancing', nextUrl: same ? null : url, recheckingKey, ...(retryUnsubmitted ? {pages:[],pageHash:null} : {}), actionAt: Date.now() });
      if (!current(task)) return;
      adapter.log('Открываем следующий материал; ждём загрузку Coursera.');
      if (same) location.reload();
      else location.href = url;
    }

    async function schedule(task) {
      await observeItems(task);
      const unresolved = task.progress.queue.filter(entry => !['completed','skipped'].includes(entry.status));
      const item = candidateItem(task);
      if (item) return navigate(task, item.url);
      const links = availableLinks(task);
      const candidate = links.find(element => !excluded(element.href) && adapter.enabled(element) && itemKey(element.href) !== itemKey(location.href) && !task.progress.visited.includes(itemKey(element.href)) && !task.progress.queue.some(entry => entry.key === itemKey(element.href) && entry.status !== 'completed') && !/locked|заблокирован/i.test(element.getAttribute('aria-label') || ''));
      if (candidate && itemKey(candidate.href) !== itemKey(location.href)) return navigate(task, candidate.href);
      const moduleKey = element => element.id || adapter.label(element.querySelector('[data-testid="module-number-heading"]'));
      const module = nextModule();
      if (module) {
        await save(task, { phase: 'waiting', nextUrl: null, recheckingKey: null });
        const before = adapter.moduleSnapshot?.();
        if (click(task, module)) {
          adapter.log('Раскрываем следующий модуль и ищем доступные материалы.');
          if (await adapter.waitModule?.(module,before) === false) fail('Модуль курса не загрузился. Повторите запуск после загрузки его материалов.');
          inspectedModules.add(moduleKey(module));
        }
        return;
      }
      const pending = due(task.progress.queue.filter(entry=>entry.manualCheck&&['quiz','assessment'].includes(activityKind(new URL(entry.url).pathname)))) || due(task.progress.queue);
      if (pending) return navigate(task, pending.url, pending.key);
      if (unresolved.length) {
        if (task.progress.phase !== 'waiting') {
          await save(task, { phase: 'waiting', nextUrl: null, recheckingKey: null });
          adapter.log(`Ожидаем: ${unresolved.filter(entry => ['pending_grade', 'blocked_dependency'].includes(entry.status)).length}; нужны данные: ${unresolved.filter(entry => ['needs_input', 'failed'].includes(entry.status)).length}. Доступные материалы обработаны, очередь будет проверяться позже.`);
        }
        return;
      }
      if(task.progress.queue.some(entry=>entry.status==='skipped')){const count=task.progress.queue.filter(entry=>entry.status==='skipped').length;await stop(`Материалы и тесты обработаны. Пропущено заданий: ${count}.`);last.phase='completed';return;}
      if (courseDone()) { await stop('Курс завершён: страница подтвердила окончание.'); if (!run && !starting) last.phase = 'completed'; return; }
      if (task.progress.terminalUrl && task.progress.terminalUrl !== location.href) return navigate(task, task.progress.terminalUrl);
      const summary = !task.progress.summaryChecked && [...document.querySelectorAll('a[href]')].find(link=>adapter.enabled(link) && link.href.startsWith(task.scope+'home/') && itemKey(link.href)!==itemKey(location.href));
      if(summary){await save(task,{summaryChecked:true});return navigate(task,summary.href);}
      fail('Материал завершён, но следующая кнопка не найдена. Проверьте конец курса.');
    }

    async function advance(task, key, complete = true) {
      let element = adapter.nextButton();
      const unresolved = task.progress.queue.filter(entry => !['completed','skipped'].includes(entry.status));
      if (element?.href && (excluded(element.href) || task.progress.queue.some(entry => entry.key === itemKey(element.href) && entry.status !== 'completed') || task.progress.visited.includes(itemKey(element.href)))) element = null;
      if (complete) {
        const visited = task.progress.visited.includes(key) ? task.progress.visited : [...task.progress.visited, key];
        const queue = task.progress.queue.some(entry => entry.key === key) ? updateQueue(task.progress.queue, { key, url: location.href, status: 'completed', reason: 'Сайт подтвердил успешный результат.' }) : task.progress.queue;
        await save(task, { visited, queue });
      }
      await observeItems(task);
      if (candidateItem(task)) return schedule(task);
      if (!element) return schedule(task);
      let nextUrl = null;
      if (element.href) {
        const target = new URL(element.href, location.href);
        if (!target.href.startsWith(task.scope)) fail('Следующая ссылка ведёт за пределы текущего курса.');
        if (activityKind(target.pathname) === 'manual') return defer(task, key, { status: 'needs_input', reason: 'Неизвестный формат следующего задания.', title: adapter.label(element), url: target.href, key: itemKey(target.href) });
        if (itemKey(target.href) === key || task.progress.visited.includes(itemKey(target.href))) fail('Обнаружен повторный переход к уже пройденному материалу.');
        nextUrl = target.href;
      }
      await save(task, { phase: 'advancing', nextUrl, recheckingKey: null, actionAt: Date.now() });
      if(element!==adapter.nextButton() || (nextUrl && element.href!==nextUrl)){
        await save(task,{phase:'lesson',nextUrl:null});pendingWake=true;return;
      }
      if (!click(task, element)) return;
      adapter.log('Переходим к следующему материалу курса');
    }

    async function defer(task, key, entry, scheduleOnly = false) {
      const targetKey = entry.key || key;
      const title = task.progress.inventory.find(item => item.key === targetKey)?.title || adapter.label(adapter.scope().querySelector?.('h1') || {getAttribute:()=>'',textContent:document.title || ''});
      const previous = task.progress.queue.find(item => item.key === targetKey);
      const checks = task.progress.recheckingKey === targetKey ? (previous?.checks || 0) + 1 : previous?.checks || 0;
      const queue = updateQueue(task.progress.queue, { key: targetKey, url: entry.url || location.href, title, ...entry, checks });
      await save(task, { queue, recheckingKey: null });
      adapter.log(`${entry.status}: ${entry.reason}`);
      if (targetKey !== key || scheduleOnly) return schedule(task);
      return advance(task, key, false);
    }

    const deferConfirmation = (task, key) => defer(task, key, { status: 'needs_input', actionRequired: 'personal_confirmation', reason: 'Нужно личное подтверждение кодекса чести на Coursera. Откройте задание и выполните подтверждение самостоятельно.' }, true);

    async function skipAssignment(task,key){
      await defer(task,key,{status:'skipped',actionRequired:null,quizRecognitionVersion:3,reason:'Задания отключены: обрабатываются только материалы и тесты.'},true);
    }

    async function material(task, kind, key) {
      if(adapter.locked?.())return defer(task,key,{status:'blocked_dependency',reason:'Coursera закрыла материал до выполнения предыдущего задания. Проверим позже.'},true);
      if (adapter.completed() || (kind==='video' && task.progress.visited.includes(key))) return advance(task, key);
      if (kind === 'video') {
        const video = document.querySelector('video');
        if (!adapter.visible(video) || !Number.isFinite(video.duration) || video.duration <= 0) {
          if (Date.now() - task.progress.actionAt > 25000) {
            const navigating=await request('navigation',{runId:task.id});if(!current(task)||navigating)return;
            return defer(task,key,{status:'blocked_dependency',reason:'Видеоплеер ещё не загрузился. Продолжаем другие материалы и проверим видео позже.'},true);
          }
          return;
        }
        video.playbackRate = task.settings.speed;
        if (!video.ended) {
          if (task.settings.skipVideo && task.progress.phase !== 'video-wait') {
            if (!video.seekable.length) {
              if (Date.now() - task.progress.actionAt > 25000) return defer(task, key, { status: 'needs_input', reason: 'Плеер не разрешил перемотку после загрузки. Проверьте видео.' }, true);
              return;
            }
            await save(task, { phase: 'video-wait', actionAt: Date.now() });
            if (current(task)) adapter.finishVideo({silent:true});
          } else if (!task.settings.skipVideo && video.paused) {
            await video.play();
            if (current(task)) adapter.log('Воспроизведение видео; ждём окончания');
          } else if (task.settings.skipVideo && Date.now() - task.progress.actionAt > 20000) return defer(task,key,{status:document.hidden&&video.paused?'blocked_dependency':'needs_input',reason:'Плеер не подтвердил окончание видео. Продолжаем другие материалы.'},true);
          return;
        }
        if (!adapter.completeButton()) {
          if (task.progress.phase !== 'video-confirming') await save(task, { phase: 'video-confirming', actionAt: Date.now() });
          else if (Date.now() - task.progress.actionAt > 25000) return defer(task, key, { status: 'needs_input', reason: 'Видео закончилось, но Coursera не подтвердила его завершение.' }, true);
          return;
        }
      }
      if (task.progress.phase === 'marking') {
        if (Date.now() - task.progress.actionAt > 15000) {
          const navigating=await request('navigation',{runId:task.id});if(!current(task)||navigating)return;
          return defer(task,key,{status:'blocked_dependency',reason:'Coursera ещё не подтвердила завершение материала. Продолжаем другие пункты и проверим отметку позже.'},true);
        }
        return;
      }
      const button = adapter.completeButton();
      if (!button) {
        if (Date.now() - task.progress.actionAt > 25000) {
          const navigating=await request('navigation',{runId:task.id});if(!current(task)||navigating)return;
          return defer(task,key,{status:'blocked_dependency',reason:'Материал ещё не показал кнопку завершения или сообщение о блокировке. Проверим позже и продолжим доступные пункты.'},true);
        }
        return;
      }
      await save(task, { phase: 'marking', actionAt: Date.now() });
      if (click(task, button)) {
        adapter.log('Материал: ожидаем подтверждение завершения');
      }
    }

    async function closeFeedback(task,key){
      const back=adapter.feedbackBackButton?.();
      if(back&&adapter.enabled(back)&&task.progress.phase!=='feedback-closing'){
        await save(task,{phase:'feedback-closing',actionAt:Date.now()});
        if(click(task,back))adapter.log('Возвращаемся из разбора на обложку, чтобы проверить актуальную оценку.');
      }else if(!back||Date.now()-task.progress.actionAt>15000){
        const navigating=await request('navigation',{runId:task.id});if(!current(task)||navigating)return;
        const cover=task.progress.inventory.find(entry=>entry.key===key&&!/\/(?:attempt|view-feedback)\/?$/.test(new URL(entry.url).pathname));
        return defer(task,key,{status:'blocked_dependency',...(cover?{url:cover.url}:{}),reason:'Не удалось вернуться из разбора к результату. Проверим известную страницу теста позже без новой отправки.'},true);
      }
    }

    async function improve(task,key,score,attempt){
      if(confirmationNeeded(task))return deferConfirmation(task,key);
      let review=task.progress.quizReviews?.[key];
      if(!review||review.attempt!==attempt||review.score!==score)review={attempt,score,observedAt:Date.now()};
      const remember=async value=>{review=value;await save(task,{quizReviews:{...task.progress.quizReviews,[key]:value}});};
      if(!review.reviewed){
        const feedback=adapter.quizFeedback?.();
        if(feedback!==null&&feedback!==undefined)await remember({...review,feedback:String(feedback).slice(0,32000),reviewed:true});
        else{
          const button=adapter.feedbackButton?.();
          if(button&&adapter.enabled(button)&&!review.requestedAt){
            await remember({...review,requestedAt:Date.now()});
            await save(task,{phase:'feedback-opening',actionAt:Date.now()});click(task,button);return;
          }
          if(review.requestedAt&&Date.now()-review.requestedAt<15000)return;
          await remember({...review,feedback:'',reviewed:true});
        }
      }
      if(adapter.feedbackOpen?.())return closeFeedback(task,key);
      const button=adapter.retakeButton?.();
      if(!button&&Date.now()-(review.observedAt||0)<15000)return;
      if(!button)return defer(task,key,{status:'blocked_dependency',reason:`Оценка ${score}%. Кнопка новой попытки пока не найдена. Проверим доступность позже.`},true);
      if(!adapter.enabled(button))return defer(task,key,{status:'blocked_dependency',reason:`Оценка ${score}%. Ожидаем доступную попытку, затем продолжим до 100%.`},true);
      await save(task,{phase:'retake-opening',retakePending:{...task.progress.retakePending,[key]:{item:key,before:attempt,at:Date.now(),confirmed:false}},actionAt:Date.now()});
      if(click(task,button))adapter.log(`Оценка ${score}%. Открываем новую попытку для достижения 100%.`);
    }

    async function quiz(task, key) {
      const questions = adapter.questionGroups();
      const pending=task.progress.retakePending?.[key];
      if(pending?.item===key){
        if(questions.length){
          filledHash=null;filledAnswers=null;
          await save(task,{attempts:{...task.progress.attempts,[key]:pending.before+1},retakePending:{...task.progress.retakePending,[key]:null},phase:'lesson',pages:[],pageHash:null,actionAt:Date.now()});return;
        }
        if(task.settings.target100!==true){await save(task,{retakePending:{...task.progress.retakePending,[key]:null},phase:'lesson'});return;}
        if(confirmationNeeded(task))return deferConfirmation(task,key);
        const confirmation=adapter.retakeConfirmation?.();
        if(confirmation&&!pending.confirmed){await save(task,{retakePending:{...task.progress.retakePending,[key]:{...pending,confirmed:true,at:Date.now()}}});click(task,confirmation);return;}
        if(Date.now()-pending.at>25000){
          const navigating=await request('navigation',{runId:task.id});if(!current(task)||navigating)return;
          return defer(task,key,pending.confirmed?{status:'blocked_dependency',reason:'Новая попытка подтверждена, но форма ещё не загрузилась. Проверим позже без повторного запуска.'}:{status:'needs_input',reason:'Новая попытка не открылась. Повторное нажатие заблокировано, чтобы не расходовать попытки вслепую.'},true);
        }
        return;
      }
      const attempt=task.progress.attempts?.[key]||0;
      const submission = task.progress.submitted.find(entry => entry.item === key&&(entry.attempt||0)===attempt);
      const resume=!questions.length&&!submission&&adapter.resumeButton?.();
      // An old grade beside an active attempt cannot authorize navigation.
      const outcome = questions.length === 0 ? result() : null;
      const gradePending=task.settings.target100===true&&!!submission&&/\/attempt\/?$/.test(location.pathname)&&!adapter.quizResultReady?.();
      if(!questions.length&&task.settings.target100===true&&!gradePending){
        const score=adapter.quizGrade?.()??null;
        if(score===100){await save(task,{quizReviews:{...task.progress.quizReviews,[key]:{attempt,score:100,feedback:''}}});return advance(task,key);}
        if(score!==null&&!resume)return improve(task,key,score,attempt);
        if(score===null&&adapter.feedbackReady?.()){
          const review=task.progress.quizReviews?.[key];
          if(task.progress.phase==='feedback-opening'&&review?.attempt===attempt&&review.requestedAt&&Number.isFinite(review.score))return improve(task,key,review.score,attempt);
          return closeFeedback(task,key);
        }
        if(outcome&&!resume&&!submission){if(Date.now()-task.progress.actionAt<15000)return;return defer(task,key,{status:'pending_grade',reason:'Итоговая оценка ещё не прочитана. Проверим позже без запуска новой попытки.'},true);}
      }
      if (outcome === 'passed'&&task.settings.target100!==true&&!gradePending&&!resume) return advance(task, key);
      if (outcome === 'failed'&&task.settings.target100!==true&&!gradePending&&!resume) return defer(task, key, { status: 'failed', reason: 'Тест не пройден. Включите режим повторения до 100% для пересдачи.' });
      if (confirmationNeeded(task)) return deferConfirmation(task, key);
      const known = task.progress.queue.find(entry => entry.key === key);
      if (known && !task.progress.recheckingKey && ['needs_input', 'failed'].includes(known.status)) return schedule(task);
      if (submission) {
        const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')].find(element => element !== adapter.scope() && adapter.visible(element) && !element.querySelector(questionSelector) && /submit|отправ/i.test(element.innerText));
        const confirmation = dialog && [...dialog.querySelectorAll('button')].find(element => adapter.enabled(element) && /^(submit|submit (?:all|answers)|yes,? submit|confirm submission|отправить|подтвердить отправку)$/i.test(adapter.label(element)));
        if (confirmation && !submission.confirmed) {
          await save(task, { submitted: task.progress.submitted.map(entry => entry===submission ? { ...entry, confirmed: true } : entry) });
          if (confirmationNeeded(task)) return deferConfirmation(task, key);
          click(task, confirmation);
          return;
        }
        if(!questions.length){
          if(task.progress.phase!=='result-waiting'){
            await save(task,{phase:'result-waiting',actionAt:Date.now()});adapter.log('Ожидаем загрузку актуальной оценки на странице результата.');return;
          }
          if(Date.now()-task.progress.actionAt<60000)return;
          const navigating=await request('navigation',{runId:task.id});if(!current(task)||navigating)return;
        }
        if (Date.now() - submission.at > 45000) return defer(task,key,{status:'pending_grade',reason:'Ответы отправлены, но результат ещё не подтверждён. Проверим позже без повторной отправки.'},true);
        return;
      }
      if (!questions.length) {
        const button = resume || openButton();
        if (button && task.progress.phase !== 'opening') {
          if (button.href && (!button.href.startsWith(task.scope) || !['quiz', 'assessment'].includes(activityKind(new URL(button.href).pathname)))) fail('Ссылка открытия теста ведёт за пределы текущего курса или к неподдерживаемому заданию.');
          await save(task, { phase: 'opening', actionAt: Date.now() });
          if (click(task, button)) adapter.log('Открываем попытку теста');
        } else if (Date.now() - task.progress.actionAt > 25000) fail('Не удалось открыть поддерживаемый тест или прочитать его результат.');
        return;
      }
      const hash = await fingerprint();
      if (!current(task)) return;
      if (task.progress.phase === 'paging' && task.progress.pageHash === hash) {
        if (Date.now() - task.progress.actionAt > 15000) fail('Следующая страница вопросов не открылась.');
        return;
      }
      if (task.progress.pages.includes(hash)) fail('Повторилась уже обработанная страница вопросов. Прохождение остановлено.');
      if (filledHash !== hash) {
        await save(task, { phase: 'solving', actionAt: Date.now() });
        let answers;
        try { answers = await adapter.solve(task.progress.quizReviews?.[key]?.feedback||''); }
        catch (error) {
          if (!current(task)) return;
          if(['BRIDGE_UNAVAILABLE','SOLVER_TEMPORARY','QUIZ_CHANGED'].includes(error.code))return defer(task,key,{status:'blocked_dependency',reason:error.message},true);
          if(['SOLVER_UNCERTAIN','QUIZ_MEDIA_UNSUPPORTED','SOLVER_ERROR'].includes(error.code))return defer(task,key,{status:'needs_input',solverRecoveryVersion:2,reason:error.message},true);
          throw error;
        }
        if (!current(task)) return;
        if (await fingerprint() !== hash) return defer(task,key,{status:'blocked_dependency',reason:'Вопросы изменились после решения. Тест будет решён заново после загрузки.'},true);
        if (!current(task)) return;
        filledHash = hash;
        filledAnswers = answers;
        await save(task, { phase: 'filled', actionAt: Date.now() });
      }
      adapter.verifyApplied(filledAnswers);
      if (confirmationNeeded(task)) return deferConfirmation(task, key);
      const submit = submitButton();
      const nextPage = pageButton();
      if (!submit && nextPage) {
        if (task.progress.pages.length >= 20) fail('Достигнут предел страниц теста. Продолжите вручную.');
        await save(task, { phase: 'paging', pageHash: hash, pages: [...task.progress.pages, hash], actionAt: Date.now() });
        if (!current(task)) return;
        if (await fingerprint() !== hash) fail('Вопросы изменились перед переходом на следующую страницу.');
        if (!current(task)) return;
        adapter.verifyApplied(filledAnswers);
        if (click(task, nextPage)) { filledHash = null; adapter.log('Переходим к следующей странице вопросов'); }
        return;
      }
      if (!submit) {
        // Coursera enables submission asynchronously after applying answers and consent.
        if (Date.now() - task.progress.actionAt < 15000) return;
        return defer(task,key,{status:'needs_input',reason:'Кнопка отправки теста недоступна после ожидания. Проверьте обязательные поля или разметку страницы.'},true);
      }
      const incomplete = adapter.questionGroups().some(group => group.type === 'text' ? !group.controls[0].value.trim() : !group.controls.some(control => control.checked));
      if (incomplete) fail('В тесте остались незаполненные поля. Отправка остановлена.');
      // Persist intent before the irreversible click; reloads must never resend.
      await save(task, { phase: 'awaiting', submitted: [...task.progress.submitted, { item: key, attempt, at: Date.now(), confirmed: false }], actionAt: Date.now() });
      if (!current(task)) return;
      if (await fingerprint() !== hash) fail('Вопросы изменились перед отправкой.');
      if (!current(task)) return;
      adapter.verifyApplied(filledAnswers);
      if (confirmationNeeded(task)) return deferConfirmation(task, key);
      if (click(task, submit)) {
        adapter.log('Ответы отправлены; ожидаем подтверждённый результат теста');
      }
    }

    async function outline(task) {
      const links = [...adapter.scope().querySelectorAll('a[href]')].filter(element=>adapter.enabled(element)&&!excluded(element.href));
      const button = links.find(element => /^(resume|continue learning|start learning|start course|продолжить|продолжить обучение|начать обучение|начать курс)$/i.test(adapter.label(element)) && element.href.startsWith(task.scope) && !task.progress.visited.includes(itemKey(element.href)) && !task.progress.queue.some(entry => entry.key === itemKey(element.href) && entry.status !== 'completed')) ||
        links.find(element => element.href.startsWith(task.scope) && !['outline', 'manual'].includes(activityKind(new URL(element.href).pathname)) && !task.progress.visited.includes(itemKey(element.href)) && !task.progress.queue.some(entry => entry.key === itemKey(element.href) && entry.status !== 'completed'));
      if (!button) {
        if (Date.now() - task.progress.actionAt > 25000) return schedule(task);
        return;
      }
      await save(task, { phase: 'advancing', nextUrl: button.href, actionAt: Date.now() });
      click(task, button);
    }

    async function tick() {
      const task = run;
      if (!task) return;
      if (busy) {pendingWake=true;return;}
      busy = true;
      try {
        if (!location.href.startsWith(task.scope)) fail('Открыта страница за пределами текущего курса.');
        const identity=adapter.materialIdentity?.();
        if(location.href!==observedUrl && itemKey(location.href)!==itemKey(observedUrl) && identity && observedContent && identity.every((value,index)=>value===observedContent[index])){
          changingAt ||= Date.now();if(Date.now()-changingAt>25000)fail('Новое содержимое материала не загрузилось.');return;
        }
        observedUrl=location.href;observedContent=identity;changingAt=0;
        if(task.progress.phase==='fast-reloading'){
          if(Date.now()-task.progress.actionAt>15000){
            const pending=await request('navigation',{runId:task.id});
            if(!current(task)||pending)return;
            fail('Не удалось обновить отметки курса. Проверьте вкладку.');
          }
          return;
        }
        const confirmed=(adapter.confirmedVideos?.() || []).filter(url=>url.startsWith(task.scope) && activityKind(new URL(url).pathname)==='video').map(itemKey);
        const fresh=confirmed.filter(key=>!task.progress.visited.includes(key));
        if(fresh.length && task.progress.item===itemKey(location.href)){
          const queue=task.progress.queue.map(entry=>confirmed.includes(entry.key)?{...entry,status:'completed',reason:'Coursera подтвердила завершение видео.',nextCheckAt:null}:entry);
          await save(task,{visited:[...new Set([...task.progress.visited,...fresh])],queue});
        }
        const key = itemKey(location.href);
        if (key !== task.progress.item) {
          if (task.progress.nextUrl && itemKey(task.progress.nextUrl) !== key) fail('Открыт другой материал вместо запланированного перехода.');
          filledHash = null;
          await save(task, { item: key, phase: 'lesson', pages: [], pageHash: null, nextUrl: null, actionAt: Date.now() });
          pendingWake=true;
          return;
        }
        await observeItems(task);
        if (courseDone()) {
          if (task.progress.phase !== 'waiting' || task.progress.terminalUrl !== location.href) await save(task, { phase: 'waiting', nextUrl: null, terminalUrl: location.href });
          return await schedule(task);
        }
        if (task.progress.phase === 'advancing') {
          if (Date.now() - task.progress.actionAt > 15000) {
            const pending=await request('navigation',{runId:task.id});
            if(!current(task))return;
            if(itemKey(location.href)!==key){pendingWake=true;return;}
            if(!pending)fail('Браузер не подтвердил переход к следующему материалу. Проверьте загрузку Coursera.');
          }
          return;
        }
        const kind = activityKind(location.pathname);
        if(excluded(location.href))return await skipAssignment(task,key);
        if(kind!=='outline' && task.progress.visited.includes(key))return await advance(task,key);
        if(kind==='assessment'&&adapter.isQuiz&&!adapter.isQuiz()&&!result()&&!task.progress.retakePending?.[key]){
          const knownQuiz=task.progress.submitted.some(entry=>entry.item===key)||!!task.progress.quizReviews?.[key];
          if(!knownQuiz&&adapter.nonQuizForm?.())return await skipAssignment(task,key);
          if(Date.now()-task.progress.actionAt>25000){
            const navigating=await request('navigation',{runId:task.id});if(!current(task)||navigating)return;
            return await defer(task,key,{status:knownQuiz?'pending_grade':'blocked_dependency',reason:'Страница теста ещё не загрузилась. Проверим позже; отсутствие формы не считается заданием другого типа.'},true);
          }
          return;
        }
        if(['quiz','assessment'].includes(kind))adapter.confirmHonor?.(task.settings.autoHonorCode===true,()=>current(task));
        const confirmation = task.progress.queue.find(entry => entry.key === key && entry.actionRequired === 'personal_confirmation' && entry.status === 'needs_input');
        if (confirmation && !adapter.personalConfirmation?.()) {
          await save(task, { phase: 'checking', recheckingKey: key, queue: task.progress.queue.map(entry=>entry===confirmation?{...entry,actionRequired:null}:entry), pages: [], pageHash: null });
        }
        if (task.progress.phase === 'waiting') return await schedule(task);
        if(task.settings.skipVideo && !task.progress.fastVideosAttempted && adapter.fastVideos && (!adapter.fastReady || adapter.fastReady())){
          await save(task,{fastVideosAttempted:true,phase:'fast-videos',actionAt:Date.now()});
          const result=await adapter.fastVideos(task.id);
          if(!current(task))return;
          await observeItems(task,result.items || []);
          if(result.acceptedCount){
            await save(task,{phase:'fast-reloading',actionAt:Date.now()});
            if(current(task))location.reload();
          }else{await save(task,{phase:'lesson',actionAt:Date.now()});pendingWake=true;}
          return;
        }
        const discovered = discoverLocks(task);
        if (discovered !== task.progress.queue) await save(task, { queue: discovered });
        if (kind === 'quiz' || kind === 'assessment') await quiz(task,key);
        else if(kind==='outline')await outline(task);
        else await material(task,kind,key);
      } catch (error) {
        if (current(task)) await stop(error.message);
      } finally { busy = false;if(pendingWake&&run){pendingWake=false;queueMicrotask(()=>void tick());} }
    }

    async function retryQueue() {
      const task = run;
      if (!task) fail('Сначала запустите или восстановите сеанс курса.');
      await save(task, { queue: task.progress.queue.map(entry => ['completed','skipped'].includes(entry.status) ? entry : { ...entry, manualCheck: true, nextCheckAt: Date.now() }) });
      adapter.log('Очередь будет перепроверена; отправленные работы повторно не отправляются.');
      if (!busy) void tick();
    }
    return { start, stop, resume, retryQueue, isActive: id => run?.id === id, isRunning: () => !!run || starting, status: () => ({ ...last, phase: starting ? 'connecting' : last.phase }) };
  }
  globalThis.CourseraCourse = { create };
})();
