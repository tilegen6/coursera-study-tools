(() => {
  'use strict';
  if (globalThis.__courseraStudyInstalled) return;
  globalThis.__courseraStudyInstalled = true;
  document.documentElement.setAttribute('data-coursera-study-tools-version','1.8.10');
  const { normalize, courseRoot, lessonKind, activityKind, itemKey, parseAnswers, validateAnswers, quizSnapshot } = globalThis.CourseraStudy;
  let running = false;
  let timer;
  let busy = false;
  let options = { speed: 1.5, skipVideo: false, autoNext: true };
  let message = 'Готово к работе';
  let lastUrl = location.href;
  let lastContent, transitionAt=0;
  let clickedAt = 0;
  let pendingNext = 0;
  let lastProgress = Date.now();
  const documentNonce = crypto.randomUUID();
  let solverTask = null;
  let courseRunner;
  let launcherRender;
  let materialWatch, pendingWake=false, fastController, quietVideo, quietMuted, quietEnded;
  const logs = [];
  const feedbackUI = '#pendo-guide-container';
  const scope = () => [...document.querySelectorAll('[role="dialog"], dialog[open]')].find(element => !element.closest(feedbackUI) && visible(element) && element.querySelector('[role="radiogroup"][aria-labelledby], [role="group"][aria-labelledby], [data-test="quiz-form"], [data-testid="honor-code-legal-name-input"], .rc-FormPartsQuestion, .rc-QuizQuestion')) || document.querySelector('main, [role="main"], #main-container') || document.body;
  const visible = element => !!element && !element.hidden && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const enabled = element => visible(element) && !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true';
  const label = element => normalize(element.getAttribute('aria-label') || element.innerText || element.textContent);
  const buttons = () => [...scope().querySelectorAll('button, a, [role="button"]')].filter(element => enabled(element) && !element.closest(feedbackUI));
  const completeButton = () => buttons().find(element => /^(mark as (complete|completed|done)|mark complete|(?:отметить|пометить) как (выполненное|выполнено|завершенное|завершённое)|отметить выполненным|завершить чтение)$/i.test(label(element)));
  const nextButton = () => buttons().find(element => /^(next|next item|next lesson|next video|go to next item|перейти к следующему пункту|следующий|следующее|далее|следующий (урок|материал)|следующее видео)(\s*[→›»])?$/i.test(label(element)));
  const completed = () => [...scope().querySelectorAll('[data-test="item-completed"], [data-testid="item-completed"], [data-test="completed-button"]')].some(visible) || [...scope().querySelectorAll('button, h2, h3, [role="status"]')].filter(visible).some(element => /^(completed|reading completed|чтение завершено|завершено|выполнено)$/i.test(label(element))) || [...document.querySelectorAll('[data-testid="left-nav"] a[href]')].some(link => itemKey(link.href) === itemKey(location.href) && visible(link.querySelector('[data-testid="learn-item-success-icon"]')));
  const personalField = element => element.matches('[data-testid="honor-code-legal-name-input"], [data-test="honor-code-legal-name-input"], #agreement-checkbox-base, [data-testid="honor-code-checkbox"], [data-test="honor-code-checkbox"]') || /honor|pledge|consent|agreement|signature/i.test(`${element.id} ${element.name}`);
  const personalConfirmation = () => [...document.querySelectorAll('input')].some(element => (visible(element) || [...(element.labels || [])].some(visible)) && personalField(element) && (element.type !== 'checkbox' || !element.checked));
  const locked=()=>/^(?:Чтобы разблокировать,? выполните предыдущее задание|To unlock,? complete (?:the )?previous (?:item|assignment)|This (?:item|assignment) is locked)/i.test(normalize(scope().innerText));

  function log(text) {
    message = text;
    logs.unshift({ time: new Date().toLocaleTimeString('ru-RU'), text });
    logs.splice(12);
    launcherRender?.();
  }

  function stopMaterials(reason = 'Автоматизация остановлена', cancelSolver = true) {
    if (cancelSolver) cancelSolve();
    running = false;
    clearInterval(timer);
    timer = null;
    materialWatch?.();materialWatch=null;pendingWake=false;
    fastController?.abort();fastController=null;
    restoreAudio();
    clickedAt = 0;
    pendingNext = 0;
    if (reason) log(reason);
  }

  function stop(reason = 'Автоматизация остановлена') {
    const stopped = courseRunner?.stop(reason);
    stopMaterials(reason);
    return stopped;
  }

  function state() {
    const video = document.querySelector('video');
    return {
      title: normalize(scope().querySelector('h1')?.textContent || document.title),
      url: location.href,
      kind: lessonKind(location.pathname),
      running, solving: !!solverTask, courseRunning: !!courseRunner?.isRunning(), course: courseRunner?.status(), message, logs,
      hasVideo: visible(video),
      speed: video?.playbackRate || options.speed,
      questions: scope().querySelectorAll('.rc-FormPartsQuestion, .rc-QuizQuestion, [data-test="question"], [role="radiogroup"][aria-labelledby]').length,
      isQuiz:isQuiz()
    };
  }

  function applySpeed(value) {
    const speed = Number(value);
    if (![1, 1.25, 1.5, 1.75, 2].includes(speed)) throw new Error('Недопустимая скорость видео.');
    const video = document.querySelector('video');
    if (!visible(video)) throw new Error('На странице не найден видеоплеер.');
    video.playbackRate = speed;
    options.speed = speed;
    return video;
  }

  function restoreAudio(){
    if(quietVideo){quietVideo.removeEventListener('ended',quietEnded);quietVideo.muted=quietMuted;quietVideo=null;}
  }
  function finishVideo({silent=false}={}) {
    const video = document.querySelector('video');
    if (!visible(video) || !Number.isFinite(video.duration) || video.duration <= 0 || !video.seekable.length) {
      throw new Error('Видео ещё не загружено или не поддерживает перемотку.');
    }
    if(silent && quietVideo!==video){restoreAudio();quietVideo=video;quietMuted=video.muted;quietEnded=()=>{if(quietVideo===video)restoreAudio();};video.addEventListener('ended',quietEnded,{once:true});video.muted=true;}
    video.currentTime = Math.max(0,video.duration-0.1);
    video.play().catch(error => {if(quietVideo===video)restoreAudio();if(!video.ended)log(document.hidden?'Браузер приостановил скрытый плеер. Материал ожидает подтверждения.':'Для запуска видео нажмите Play на странице.');});
    log('Перемотка к концу видео. Завершение определяет Coursera.');
  }

  function next(automatic = false) {
    const element = nextButton();
    if (!element) throw new Error('Кнопка следующего материала не найдена.');
    if (element.href) {
      const target = new URL(element.href, location.href);
      if (target.origin !== location.origin || courseRoot(target.href) !== courseRoot(location.href)) throw new Error('Ссылка ведёт за пределы текущего курса.');
      if (automatic && lessonKind(target.pathname) === 'manual') {
        stop('Дальше задание или тест. Продолжите вручную.');
        return;
      }
    }
    element.click();
    pendingNext = Date.now();
    log('Переход к следующему материалу');
  }

  async function tick() {
    if (!running) return;
    if (busy) {pendingWake=true;return;}
    busy = true;
    try {
      if (!courseRoot(location.href)) return stop('Открыта страница за пределами курса.');
      const identity=materialIdentity();
      if(location.href!==lastUrl&&lastContent&&identity.every((value,index)=>value===lastContent[index])){
        transitionAt ||= Date.now();if(Date.now()-transitionAt>25000)stop('Новое содержимое материала не загрузилось.');return;
      }
      lastContent=identity;transitionAt=0;
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        clickedAt = 0;
        pendingNext = 0;
        lastProgress = Date.now();
        pendingWake=true;
        return; // Wait one tick for SPA content to settle.
      }
      const kind = lessonKind(location.pathname);
      if (kind === 'manual') return stop('Тест, обсуждение или неподдерживаемое задание: продолжите вручную.');
      if (pendingNext) {
        if (Date.now() - pendingNext > 10000) stop('После нажатия «Далее» адрес не изменился. Проверьте страницу.');
        return;
      }
      const video = kind === 'video' ? document.querySelector('video') : null;
      if (video && visible(video)) {
        video.playbackRate = options.speed;
        if (!video.ended && !completed()) {
          if (options.skipVideo && !clickedAt) {
            finishVideo({silent:true});
            clickedAt = Date.now();
          }
          if (!options.skipVideo) {
            // Playback is user-controlled: a paused video is never resumed by the loop.
            message = video.paused ? 'Видео на паузе. Нажмите Play на странице.' : 'Ожидание окончания видео';
            return;
          }
          if (Date.now() - clickedAt > 15000) stop('Плеер не подтвердил окончание. Проверьте видео вручную.');
          return;
        }
      }
      if (completed() || video?.ended) {
        if (options.autoNext) next(true);
        else stop('Материал завершён. Автопереход выключен.');
        return;
      }
      if (clickedAt) {
        if (Date.now() - clickedAt > 10000) stop('Сайт не подтвердил завершение материала. Проверьте страницу.');
        return;
      }
      const button = completeButton();
      if (button) {
        button.click();
        clickedAt = Date.now();
        log('Нажата кнопка завершения; ожидаем подтверждение страницы');
      } else if (Date.now() - lastProgress > 15000) {
        stop('Поддерживаемая кнопка завершения не найдена. Выполните материал вручную.');
      } else message = 'Ожидание плеера или кнопки завершения';
    } catch (error) { stop(error.message); }
    finally { busy = false;if(pendingWake&&running){pendingWake=false;queueMicrotask(()=>void tick());} }
  }

  function start(settings = {}) {
    const speed = Number(settings.speed ?? 1.5);
    if (![1, 1.25, 1.5, 1.75, 2].includes(speed)) throw new Error('Недопустимая скорость.');
    if (lessonKind(location.pathname) === 'manual') throw new Error('Запустите автоматизацию на странице видео, чтения или практики.');
    stop('Настройки автоматизации обновлены');
    options = { speed, skipVideo: settings.skipVideo === true, autoNext: settings.autoNext !== false };
    running = true;
    lastUrl = location.href;
    lastContent=materialIdentity();
    transitionAt=0;
    lastProgress = Date.now();
    log('Автоматизация запущена; остановка доступна в этом окне');
    timer = setInterval(tick, 750);
    materialWatch=globalThis.CourseraActivity?.watch(()=>void tick());
    void tick();
  }

  function optionText(control) {
    const element=control.labels?.[0]||control.closest('label');
    const text=node=>{
      if(node.nodeType===Node.TEXT_NODE)return node.textContent;
      if(node.nodeType!==Node.ELEMENT_NODE||node.matches('input,textarea,select,script,style,[aria-hidden="true"]'))return '';
      if(node.matches('br'))return ' ';
      const value=[...node.childNodes].map(text).join('');
      if(!value.trim())return value;
      if(node.matches('em,i'))return '*'+value+'*';
      if(node.matches('strong,b'))return '**'+value+'**';
      if(node.matches('sup'))return '^{'+value+'}';
      if(node.matches('sub'))return '_{'+value+'}';
      return value;
    };
    return normalize(element?text(element):control.getAttribute('aria-label'));
  }

  function questionGroups() {
    // shortcut: only visible standard form controls; custom widgets need a course-specific adapter.
    const controls = [...scope().querySelectorAll('input[type="radio"], input[type="checkbox"], textarea, input[type="text"], input[type="number"]')].filter(element => !element.closest(feedbackUI+',[data-testid="assignment-feedback-view"]') && !personalField(element) && (visible(element) || [...(element.labels || [])].some(visible)) && !element.matches(':disabled') && !element.readOnly);
    const groups = new Map();
    for (const control of controls) {
      const container = control.closest('[data-test="question"], [data-testid="question"], .rc-FormPartsQuestion, .rc-QuizQuestion, fieldset, [role="group"], [role="radiogroup"]');
      if (!container) continue;
      const key = container;
      if (!groups.has(key)) groups.set(key, { container, controls: [] });
      groups.get(key).controls.push(control);
    }
    return [...groups.values()].map((group, index) => {
      const referenced = (group.container.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)).filter(element => element && scope().contains(element) && element.getAttribute('aria-hidden') !== 'true');
      const heading = group.container.querySelector('[data-test="question-prompt"], .rc-FormPartsQuestion__question, legend, h2:not([aria-hidden="true"]), h3:not([aria-hidden="true"]), [role="heading"]:not([aria-hidden="true"])');
      const question = normalize(referenced.length ? referenced.map(element => element.textContent).join(' ') : heading?.textContent);
      if (!question) throw new Error('Не удалось выделить текст вопроса. Эта разметка теста не поддерживается.');
      const types = new Set(group.controls.map(control => ['radio', 'checkbox'].includes(control.type) ? control.type : 'text'));
      if (types.size !== 1 || (types.has('text') && group.controls.length !== 1)) throw new Error('Вопрос содержит неподдерживаемую комбинацию полей.');
      const type = [...types][0];
      const images=[...new Set([...group.container.querySelectorAll('img'),...referenced.flatMap(element=>[...element.querySelectorAll('img')])])].filter(visible).map(image=>({url:image.currentSrc||image.src,alt:(image.alt||'').slice(0,2000)}));
      return {
        id: index + 1,
        question,
        type,
        options: type === 'text' ? [] : group.controls.map(optionText),
        ...(images.length?{images}:{}),
        controls: group.controls
      };
    });
  }

  const quizMarkers='[data-test="quiz-form"], [data-test="question"], [data-testid="question"], .rc-QuizQuestion, .rc-FormPartsQuestion, [role="radiogroup"][aria-labelledby], [role="group"][aria-labelledby]';
  function isQuiz(){
    const kind=activityKind(location.pathname);if(kind==='quiz')return true;if(kind!=='assessment')return false;
    if([...scope().querySelectorAll(quizMarkers)].some(element=>!element.closest(feedbackUI)))return true;
    const cover=scope().querySelector('[data-testid="assignment-cover-redesign"]');
    if(cover?.querySelector('[data-testid="CoverPageActionButton"]')&&!cover.querySelector('textarea,input[type="file"],[contenteditable="true"],.monaco-editor'))return true;
    return /\b(?:quiz|assessment|test|exam)\b|тест|экзамен/i.test(scope().querySelector('h1')?.textContent||'')&&!scope().querySelector('textarea,input[type="file"],[contenteditable="true"],.monaco-editor');
  }
  const nonQuizForm=()=>!isQuiz()&&!!scope().querySelector('textarea,input[type="file"],[contenteditable="true"]');
  function quizGrade(){
    const values=[...document.querySelectorAll('[data-testid="result-banner"] [data-testid="grade"],[data-test="quiz-result"][data-score],[data-testid="quiz-result"][data-score]')].filter(element=>visible(element)&&!element.closest(feedbackUI+',fieldset,[data-test="question"],[data-testid="question"],[data-testid^="part-Submission_"]')).map(element=>globalThis.CourseraStudy.gradePercent(element.hasAttribute('data-score')?element.getAttribute('data-score')+'%':element.textContent)).filter(value=>value!==null);
    return values.length&&new Set(values).size===1?values[0]:null;
  }
  const quizResultReady=()=>!!retakeButton()||[...scope().querySelectorAll('[data-test="quiz-result"],[data-testid="quiz-result"],.rc-QuizSubmissionGradeInfo,.rc-GradeSummary')].some(element=>visible(element)&&!element.closest(feedbackUI+',fieldset,[data-test="question"],[data-testid="question"],[data-testid^="part-Submission_"]'));
  const quizAction = selector => [...document.querySelectorAll(selector)].find(element=>visible(element)&&!element.closest(feedbackUI+',fieldset,[data-test="question"],[data-testid="question"],[data-testid^="part-Submission_"]'));
  const feedbackButton=()=>quizAction('[data-testid="view-feedback-button"]');
  const feedbackBackButton=()=>quizAction('[data-testid="tunnel-vision-back-button"]');
  const feedbackOpen=()=>visible(document.querySelector('[data-testid="assignment-feedback-view"]'));
  const feedbackReady=()=>feedbackOpen()&&!!document.querySelector('[data-testid="assignment-feedback-view"] [data-testid^="part-Submission_Graded"]');
  const resumeButton=()=>{
    if(feedbackOpen())return null;
    const button=quizAction('[data-testid="CoverPageActionButton"]');
    return button&&/^(?:(?:resume|continue) (?:quiz|attempt|assignment)|(?:продолжить|возобновить) (?:тест|попытку|задание))$/i.test(label(button))?button:null;
  };
  const retakeButton=()=>{
    const button=quizAction('[data-testid="CoverPageActionButton"],[data-test="retake-quiz"]');
    return button&&/^(?:retake(?: (?:quiz|test|assessment))?|try again|retry(?: attempt)?|повторить (?:попытку|тест)|пройти (?:заново|ещ[её] раз))$/i.test(label(button))?button:null;
  };
  function retakeConfirmation(){
    for(const dialog of document.querySelectorAll('[role="dialog"],[role="alertdialog"]')){
      if(!visible(dialog)||dialog.closest(feedbackUI+',fieldset,[data-test="question"],[data-testid="question"],[data-testid^="part-Submission_"]')||dialog.querySelector(quizMarkers))continue;
      const title=normalize(dialog.querySelector('h1,h2,[role="heading"]')?.textContent||dialog.innerText);
      if(!/^(?:Начать новую попытку|Start (?:a )?new attempt)\s*\?/i.test(title))continue;
      const button=[...dialog.querySelectorAll('button')].find(element=>enabled(element)&&/^(?:continue|продолжить|start(?: (?:attempt|quiz|assignment))?|begin (?:attempt|quiz)|начать (?:попытку|тест|задание))$/i.test(label(element)));
      if(button)return button;
    }
    return null;
  }
  function quizFeedback(){
    const root=document.querySelector('[data-testid="assignment-feedback-view"]');
    if(!root||!visible(root))return null;
    const parts=[...root.querySelectorAll('[data-testid^="part-Submission_Graded"]')];
    parts.sort((a,b)=>Number(!!b.querySelector('[data-testid="icon-incorrect"]'))-Number(!!a.querySelector('[data-testid="icon-incorrect"]')));
    let feedback='Previous Coursera grade: '+quizGrade()+'%.\n';
    for(const part of parts){
      const selected=[...part.querySelectorAll('input:checked,textarea,input[type="text"]')].map(control=>control.type==='checkbox'||control.type==='radio'?optionText(control):control.value);
      const block=normalize(part.innerText).slice(0,6000)+'\nPreviously selected: '+JSON.stringify(selected)+'\n';
      if(feedback.length+block.length>32000)continue;
      feedback+=block;
    }
    return parts.length?feedback:normalize(root.innerText).slice(0,32000);
  }
  function confirmHonor(allowed,isCurrent){
    if(allowed!==true||!isCurrent()||!isQuiz())return;
    for(const field of scope().querySelectorAll('#agreement-checkbox-base,[data-testid="honor-code-checkbox"],[data-test="honor-code-checkbox"]')){
      if(!isCurrent())return;
      if(field.type==='checkbox'&&!field.checked&&!field.disabled&&(visible(field)||[...(field.labels||[])].some(visible))&&!field.closest('[data-test="question"],[data-testid="question"],.rc-QuizQuestion,.rc-FormPartsQuestion,[role="radiogroup"],[role="group"][aria-labelledby]'))field.click();
    }
  }

  function quizExport() {
    if(!isQuiz())throw new Error('Автоматическое решение доступно только в тестах.');
    const questions = questionGroups().map(({ controls, ...question }) => question);
    if (!questions.length) throw Object.assign(new Error('Видимые стандартные вопросы не найдены. Откройте страницу теста.'),{code:'QUIZ_CHANGED'});
    if (questions.some(question => !question.question || (question.type !== 'text' && question.options.some(option => !option)))) throw new Error('Не удалось прочитать подписи вопросов или вариантов.');
    return {url:location.href,questions};
  }

  function quizApply(raw, { fromSolver = false } = {}) {
    if (fromSolver) stopMaterials('Заполняем полученные ответы', false);
    else stop('Автоматизация остановлена для работы с ответами');
    const groups = questionGroups();
    const answers = validateAnswers(parseAnswers(raw), groups);
    for (const answer of answers) {
      const group = groups.find(question => question.id === answer.id);
      if (group.type === 'text' && group.controls[0].type === 'number') {
        const control = group.controls[0];
        const probe = document.createElement('input');
        probe.type = 'number';
        for (const attribute of ['min', 'max', 'step']) if (control.hasAttribute(attribute)) probe.setAttribute(attribute, control.getAttribute(attribute));
        probe.value = answer.text.trim();
        if (!probe.value || !probe.checkValidity()) throw new Error(`Вопрос ${answer.id} требует допустимое число. Ответ не применён.`);
      }
    }
    // Validate the entire payload before changing a single control.
    for (const answer of answers) {
      const group = groups.find(question => question.id === answer.id);
      if (group.type === 'text') {
        const control = group.controls[0];
        const prototype = control.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(control, control.type === 'number' ? answer.text.trim() : answer.text);
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        group.controls.forEach((control, index) => {
          const selected = answer.choices.includes(index + 1);
          if (control.checked !== selected && (group.type === 'checkbox' || selected)) control.click();
        });
      }
    }
    log(`Заполнено вопросов: ${answers.length}. Проверьте ответы и отправьте самостоятельно.`);
    return message;
  }

  function verifyApplied(payload) {
    const groups = questionGroups();
    const answers = validateAnswers(payload, groups);
    for (const answer of answers) {
      const group = groups.find(question => question.id === answer.id);
      const expected = group.type === 'text' ? (group.controls[0].type === 'number' ? answer.text.trim() : answer.text.replace(/\r\n/g, '\n')) : [...answer.choices].sort((a, b) => a - b);
      const actual = group.type === 'text' ? group.controls[0].value : group.controls.flatMap((control, index) => control.checked ? [index + 1] : []);
      if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Страница не сохранила выбранные ответы. Автоматическая отправка остановлена.');
    }
  }

  async function solverRequest(action, data = {}) {
    let response;
    try { response = await chrome.runtime.sendMessage({ source: 'coursera-study-solver', action, data }); }
    catch { throw new Error('Обновите расширение и вкладку курса, затем повторите.'); }
    if (!response?.ok) {
      const error = new Error(response?.error || 'Решатель не ответил.');
      if (['BRIDGE_UNAVAILABLE','SOLVER_TEMPORARY'].includes(response?.code)) error.code = response.code;
      throw error;
    }
    return response.data;
  }

  function cancelSolve(error = new Error('Решение отменено.')) {
    if (!solverTask) return;
    const task = solverTask;
    clearInterval(task.timer);
    solverTask = null;
    task.reject?.(error);
    void solverRequest('cancel', { nonce: task.nonce }).catch(() => {});
  }

  async function solveAutomatically({ forCourse = false, feedback = '' } = {}) {
    if (solverTask) throw new Error('Тест уже решается. Дождитесь ответа или нажмите «Стоп».');
    const quiz = quizExport();
    if (forCourse) stopMaterials();
    else stop();
    const task = { nonce: crypto.randomUUID(), url: quiz.url, snapshot: quizSnapshot(quiz.questions), busy: false, started: Date.now() };
    task.finished = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
    task.finished.catch(() => {}); // Standalone solving is observed through status, not a pending popup promise.
    solverTask = task;
    log(`Codex решает тест. Изображений: ${quiz.questions.reduce((count,q)=>count+(q.images?.length||0),0)}. Вкладку курса оставьте открытой.`);
    try {
      await solverRequest('start', { nonce: task.nonce, documentNonce, url: quiz.url, questions: quiz.questions, ...(feedback?{feedback}: {}) });
      if (solverTask !== task) { await solverRequest('cancel', { nonce: task.nonce }); return state(); }
      task.timer = setInterval(() => void pollSolve(task), 1200);
    } catch (error) {
      if (solverTask === task) { cancelSolve(error); log(error.message); }
      throw error;
    }
    return state();
  }

  async function pollSolve(task) {
    if (solverTask !== task || task.busy) return;
    task.busy = true;
    try {
      if (itemKey(location.href) !== itemKey(task.url)) throw new Error('Страница теста изменилась. Решение отменено.');
      if (Date.now() - task.started > 240000) throw Object.assign(new Error('Время ожидания ответа истекло. Тест будет проверен позже.'),{code:'SOLVER_TEMPORARY'});
      const result = await solverRequest('poll', { nonce: task.nonce });
      if (solverTask !== task) return;
      if (result.status === 'running') return;
      if (result.status !== 'done') throw Object.assign(new Error(result.error || 'Решение отменено.'),{code:result.code||'SOLVER_ERROR'});
      if (itemKey(location.href) !== itemKey(task.url)) throw new Error('Страница теста изменилась. Решение отменено.');
      let snapshot;
      try { snapshot=quizSnapshot(quizExport().questions); }
      catch { throw Object.assign(new Error('Форма теста временно недоступна. Проверим сохранённую попытку позже.'),{code:'QUIZ_CHANGED'}); }
      if (snapshot !== task.snapshot) throw Object.assign(new Error('Вопросы или варианты изменились. Тест будет решён заново после загрузки.'),{code:'QUIZ_CHANGED'});
      quizApply(JSON.stringify(result.result), { fromSolver: true });
      await new Promise(resolve => setTimeout(resolve, 50));
      if (solverTask !== task) return;
      verifyApplied(result.result);
      clearInterval(task.timer);
      solverTask = null;
      task.resolve(result.result);
    } catch (error) {
      if (solverTask === task) { cancelSolve(error); log(error.message); }
    } finally { task.busy = false; }
  }

  const accountHint=()=>document.querySelector('header [data-user-id]')?.getAttribute('data-user-id') || (()=>{const link=document.querySelector('header a[href*="/user/"]');try{return link?new URL(link.href).pathname:'';}catch{return '';}})();
  function materialIdentity(){const region=scope(),heading=region.querySelector('h1')||region.querySelector('h2'),video=document.querySelector('video');return [heading,heading?.textContent,video,video?.currentSrc||video?.src,completeButton()];}
  const videoLinks=()=>[...(document.querySelector('[data-testid="left-nav"]')||document).querySelectorAll('a[href]')].filter(link=>visible(link)&&!link.closest('[aria-disabled="true"],[data-locked="true"],.locked')&&!/locked|заблокирован/i.test(link.getAttribute('aria-label')||'')&&new URL(link.href).origin===location.origin&&new URL(link.href).pathname.startsWith(courseRoot(location.href)+'lecture/'));
  const itemCompleted=link=>visible(link.querySelector('[data-testid="learn-item-success-icon"]'));
  const moduleSnapshot=()=>[...document.querySelectorAll('[data-testid="left-nav"] a[href]')].filter(visible).map(link=>link.href);
  function moduleReady(button,signal,before=[]){
    return globalThis.CourseraActivity.until(()=>{
      const panel=document.getElementById(button.getAttribute('aria-controls'));
      return button.getAttribute('aria-expanded')==='true' && (panel?!![...panel.querySelectorAll('a[href]')].find(visible):moduleSnapshot().some(url=>!before.includes(url)));
    },{signal,timeout:25000});
  }
  async function fastVideos(runId){
    const url=location.href,profile=accountHint(),controller=new AbortController();fastController=controller;
    const active=()=>courseRunner.isActive(runId)&&location.href===url&&accountHint()===profile;
    const links=new Set(),items=new Map();const seen=new Set();
    const collect=()=>{
      for(const link of videoLinks())if(!itemCompleted(link))links.add(link.href);
      for(const link of document.querySelectorAll('[data-testid="left-nav"] a[href]')){
        if(!visible(link)||!link.href.startsWith(location.origin+courseRoot(url)))continue;
        const kind=activityKind(new URL(link.href).pathname);
        if(['video','outline'].includes(kind))continue;
        const relative=new URL(link.href).pathname.slice(courseRoot(url).length);
        if(kind==='manual'&&(!/^[^/]+\/[^/]+/.test(relative)||/^(?:home|resources|discussions|announcements|info|grades)\//.test(relative)))continue;
        items.set(itemKey(link.href),{url:link.href,title:label(link).slice(0,200),sidebar:true,completed:itemCompleted(link),locked:!enabled(link)||!!link.closest('[aria-disabled="true"],[data-locked="true"],.locked')||/locked|заблокирован/i.test(link.getAttribute('aria-label')||'')});
      }
    };
    try{
      for(let count=0;count<100;count++){
        controller.signal.throwIfAborted();if(!active())throw new DOMException('Страница курса изменилась','AbortError');
        collect();
        const module=[...document.querySelectorAll('[data-testid="left-nav"] button[aria-expanded="false"]')].find(button=>enabled(button)&&button.querySelector('[data-testid="module-number-heading"]')&&!seen.has(button.id||label(button)));
        if(!module)break;const before=moduleSnapshot();module.click();
        if(!await moduleReady(module,controller.signal,before)){const error=new Error('Модуль курса не загрузился. Повторите запуск после загрузки его материалов.');error.code='MODULE_UNAVAILABLE';throw error;}
        seen.add(module.id||label(module));
      }
      collect();
      const result=await globalThis.CourseraFastVideos.complete({url,links:[...links],signal:controller.signal,isCurrent:active});
      if(result.accepted.length)log(`Отправлены отметки окончания видео: ${result.accepted.length}. Проверяем обновлённые отметки Coursera.`);
      else if(result.unsupported)log('Пакетное завершение недоступно. Продолжаем через видеоплеер.');
      return {acceptedCount:result.accepted.length,items:[...items.values()]};
    }catch(error){if(error.name==='AbortError'||error.code==='MODULE_UNAVAILABLE')throw error;log('Пакетное завершение недоступно. Продолжаем через видеоплеер.');return {acceptedCount:0,items:[...items.values()]};}
    finally{if(fastController===controller)fastController=null;}
  }
  courseRunner = globalThis.CourseraCourse.create({
    scope, visible, enabled, label, buttons, completeButton, nextButton, completed, personalConfirmation, confirmHonor, isQuiz, nonQuizForm, locked, finishVideo, questionGroups, quizExport, verifyApplied, quizGrade, quizResultReady, quizFeedback, feedbackButton, feedbackBackButton, feedbackOpen, feedbackReady, resumeButton, retakeButton, retakeConfirmation, log,
    cancel: () => stopMaterials('', true),
    watch:callback=>globalThis.CourseraActivity?.watch(callback),
    fastReady:()=>!!globalThis.CourseraFastVideos&&['video','reading','practice','outline'].includes(activityKind(location.pathname))&&videoLinks().length>0&&![...scope().querySelectorAll('input,textarea,select,[contenteditable="true"]')].some(field=>visible(field)&&!field.disabled&&!field.readOnly&&!['range','button','submit','reset'].includes(field.type)),
    fastVideos,
    confirmedVideos:()=>videoLinks().filter(itemCompleted).map(link=>link.href),
    itemCompleted,
    moduleSnapshot,
    waitModule:async (button,before)=>{const controller=new AbortController();fastController=controller;try{return await moduleReady(button,controller.signal,before);}finally{if(fastController===controller)fastController=null;}},
    materialIdentity,
    accountHint,
    solve: async feedback => {
      await solveAutomatically({ forCourse: true, feedback });
      const task = solverTask;
      if (!task) throw new Error('Решение теста не запущено.');
      return task.finished;
    }
  });

  const actions = {
    status: () => state(),
    start: data => { start(data); return state(); },
    stop: async () => { await stop(); return state(); },
    speed: data => { applySpeed(data.speed); log(`Скорость: ${options.speed}×`); return state(); },
    skip: () => { finishVideo(); return state(); },
    complete: () => {
      if (lessonKind(location.pathname) === 'manual') throw new Error('Для этого задания автоматическое завершение не поддерживается.');
      const button = completeButton();
      if (!button) throw new Error('Кнопка завершения не найдена.');
      button.click();
      log('Нажата кнопка завершения. Проверьте результат на странице.');
      return state();
    },
    next: () => { next(); return state(); },
    quizExport, quizApply: data => quizApply(data.raw), solve: () => solveAutomatically(),
    courseStart: async data => {
      if (data.recoveryGuard) {
        const guard = data.recoveryGuard;
        const profile = document.querySelector('header [data-user-id]')?.getAttribute('data-user-id') || document.querySelector('header a[href*="/user/"]')?.getAttribute('href') || '';
        if (location.href !== guard.url || profile !== guard.profile || !Number.isFinite(guard.expiresAt) || guard.expiresAt <= Date.now() || guard.expiresAt > Date.now()+60000 || running || solverTask || courseRunner.isRunning()) throw new Error('Вкладка или сеанс изменились. Восстановленный запуск отменён.');
      }
      stopMaterials(); await courseRunner.start(data); return state();
    },
    queueCheck: async () => { await courseRunner.retryQueue(); return state(); },
    solverCheck: data => data.documentNonce === documentNonce && !!solverTask && solverTask.nonce === data.nonce && itemKey(solverTask.url) === itemKey(location.href),

  };
  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (request?.source !== 'coursera-study-tools' || sender.id !== chrome.runtime.id) return;
    if (!Object.hasOwn(actions, request.action)) { respond({ ok: false, error: 'Неизвестная команда.' }); return; }
    try {
      if (!courseRoot(location.href)) throw new Error('Откройте материал курса на Coursera.');
      const result = actions[request.action](request.data || {});
      if (result instanceof Promise) {
        result.then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
        return true;
      }
      respond({ ok: true, data: result });
    } catch (error) { respond({ ok: false, error: error.message }); }
  });
  function mountLauncher(){
    if(!courseRoot(location.href)||document.getElementById('coursera-study-launcher'))return;
    const host=document.createElement('div');host.id='coursera-study-launcher';
    host.dataset.extensionId=chrome.runtime.id;host.dataset.loadedVersion=chrome.runtime.getManifest().version;
    host.style.cssText='position:fixed;right:16px;top:88px;z-index:2147483646;max-width:calc(100vw - 32px);width:310px';
    const shadow=host.attachShadow({mode:'open'});
    shadow.innerHTML='<style>:host{font:13px/1.4 system-ui;color:#182b24}section{background:#fbfcf8;border:1px solid #a7b7a2;border-radius:12px;box-shadow:0 5px 24px #0002;padding:12px}strong{font-size:14px}p{margin:8px 0;white-space:pre-wrap}button{font:inherit;border:1px solid #668060;border-radius:6px;background:white;color:#173a25;padding:7px 9px;cursor:pointer}button:disabled{opacity:.55;cursor:default}button:first-of-type{background:#285e3c;color:white}nav{display:flex;gap:6px;margin-top:8px}details{margin-top:8px}ol{padding-left:20px;max-height:180px;overflow:auto}li{margin-bottom:8px}a{color:#285e3c}</style><section aria-label="Coursera Study Tools"><strong>Coursera Study Tools</strong><p role="status" aria-live="polite"></p><nav><button type="button">Запустить курс</button><button type="button">Стоп</button></nav><details><summary>Очередь тестов и пропуски</summary><ol></ol><button type="button">Проверить очередь</button></details></section>';
    const [startButton,stopButton,retryButton]=shadow.querySelectorAll('button'),status=shadow.querySelector('[role="status"]'),list=shadow.querySelector('ol');
    let pending=false,queueKey='',launchGeneration=0;
    launcherRender=()=>{
      const current=state(),active=current.courseRunning||current.running||current.solving,course=current.course||{};
      const text=`${course.phase==='completed'?'Обработка завершена':pending?'Подключение…':active?'Выполняется':'Готово'} · обработано: ${course.count||0}\n${current.message}${course.needsInput?'\nНужны данные: '+course.needsInput:''}${course.pending?'\nОжидают проверки: '+course.pending:''}${course.skipped?'\nПропущено заданий: '+course.skipped:''}`;
      if(status.textContent!==text)status.textContent=text;
      startButton.disabled=!!active||pending;stopButton.disabled=!active&&!pending;retryButton.disabled=!current.courseRunning;
      const queue=course.queue||[],key=JSON.stringify(queue);
      if(key!==queueKey){queueKey=key;list.replaceChildren(...queue.map(entry=>{
        const item=document.createElement('li'),title=document.createElement('a');
        try{const url=new URL(entry.url);if(url.origin===location.origin&&courseRoot(url.href)===courseRoot(location.href)){title.href=url.href;title.target='_blank';title.rel='noopener noreferrer';}}catch{}
        title.textContent=entry.title||'Задание';item.append(title,document.createTextNode(' — '+(entry.reason||entry.status)));return item;
      }));}
    };
    startButton.addEventListener('click',async event=>{
      if(!event.isTrusted||pending||courseRunner.isRunning()||solverTask||running)return;
      const version=++launchGeneration;
      pending=true;launcherRender();
      try{const preferences=await chrome.runtime.sendMessage({source:'coursera-study-course',action:'preferences',data:{}});if(version!==launchGeneration)return;await actions.courseStart({...(preferences?.ok?preferences.data:{speed:2,skipVideo:true,autoNext:true}),resumeQueue:true});}
      catch(error){if(version===launchGeneration)log(error.message);}finally{if(version===launchGeneration)pending=false;launcherRender();}
    });
    stopButton.addEventListener('click',async event=>{if(!event.isTrusted)return;launchGeneration++;pending=false;try{await actions.stop();}catch(error){log(error.message);}launcherRender();});
    retryButton.addEventListener('click',async event=>{if(!event.isTrusted)return;try{await actions.queueCheck();}catch(error){log(error.message);}launcherRender();});
    document.documentElement.append(host);launcherRender();setInterval(launcherRender,1000);
  }
  mountLauncher();
  void courseRunner.resume().then(()=>launcherRender?.());
})();
