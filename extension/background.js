'use strict';
if (typeof importScripts === 'function') importScripts('core.js','recovery.js');
const base = 'http://127.0.0.1:43179';
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const operations = new Map();
const courseStarts = new Map();
const nativeHost = 'com.coursera.studytools';
let nativeConnection;
let recoveryGeneration = 0, activeRecovery = null;

function withTab(tabId, operation, sender) {
  const next = (operations.get(tabId) || Promise.resolve()).catch(() => {}).then(async()=>operation(sender?await activeMessageSender(sender):undefined));
  operations.set(tabId, next);
  return next.finally(() => { if (operations.get(tabId) === next) operations.delete(tabId); });
}

function checkpointKey(scope, accountHint) { return `checkpoint:${scope}${accountHint ? ':' + encodeURIComponent(accountHint) : ''}`; }

function startCourse(scope, key, tabId, request) {
  const previous = courseStarts.get(scope) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const all = await chrome.storage.session.get(null);
    const owners = Object.entries(all).filter(([name, value]) => name.startsWith('course:') && name !== key && value.scope === scope);
    if (owners.length) {
      // Tab removal events can be missed; keep checkpoints and reclaim only confirmed closed owners.
      const liveIds = new Set((await chrome.tabs.query({})).map(tab => tab.id));
      if (owners.some(([name]) => !/^course:\d+$/.test(name) || liveIds.has(Number(name.slice(7))))) throw new Error('Этот курс уже запущен в другой вкладке. Остановите тот сеанс.');
      for (const [name] of owners) {
        await chrome.storage.session.remove(name);
        await cancelTab(Number(name.slice(7)));
      }
    }
    const settings = request.data?.settings || {};
    if (!/^[a-f0-9-]{36}$/.test(request.data?.runId || '')) throw new Error('Некорректный идентификатор сеанса.');
    if (![1, 1.25, 1.5, 1.75, 2].includes(Number(settings.speed))) throw new Error('Недопустимая скорость.');
    await cancelTab(tabId);
    const accountHint = String(request.data.accountHint || '').slice(0, 200);
    const backupKey = checkpointKey(scope, accountHint);
    const backup = (await chrome.storage.local.get(backupKey))[backupKey];
    const restore = backup?.scope === scope && (accountHint ? backup.accountHint === accountHint : settings.resumeQueue === true);
    const prior = restore ? backup.progress : null;
    const record = { id: request.data.runId, scope, accountHint, settings: { speed: Number(settings.speed), skipVideo: settings.skipVideo === true, autoHonorCode: settings.autoHonorCode === true, target100:settings.target100===true }, progress: prior ? { ...prior, item: null, phase: 'lesson', nextUrl: null, pages: [], actionAt: 0, queue: prior.queue || [] } : { item: null, phase: 'lesson', visited: [], submitted: [], pages: [], queue: [], actionAt: 0 }, updated: Date.now() };
    record.progress.fastVideosAttempted=false;record.progress.summaryChecked=false;
    await chrome.storage.session.remove(`courseStopped:${tabId}`);
    await chrome.storage.session.set({ [key]: record });
    return record;
  });
  courseStarts.set(scope, pending);
  return pending.finally(() => { if (courseStarts.get(scope) === pending) courseStarts.delete(scope); });
}

async function bridgeRequest(path, method, body, bridgeToken) {
  if (!/^[a-f0-9]{64}$/.test(bridgeToken || '')) throw new Error('Некорректный код подключения.');
  let response;
  try {
    response = await fetch(base + path, {
      method, headers: { Authorization: `Bearer ${bridgeToken}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000)
    });
  } catch { const error = new Error('Локальный сервис недоступен. Повторите подключение.'); error.network = true; throw error; }
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'Ошибка локального сервиса.'); error.status = response.status;if(response.status>=500||[409,429].includes(response.status))error.code='SOLVER_TEMPORARY';throw error; }
  return data;
}

async function connectNative() {
  if (!nativeConnection) nativeConnection = (async () => {
    let result;
    try { result = await chrome.runtime.sendNativeMessage(nativeHost, { action:'connect', version:1 }); }
    catch (error) {
      const manifest = chrome.runtime.getManifest?.() || {};
      const detail = String(error?.message || 'Неизвестный отказ Chrome').replace(/[a-f0-9]{64}/gi,'[скрыто]').slice(0,300);
      const diagnostics = { extensionId:chrome.runtime.id, loadedVersion:manifest.version || 'unknown', nativePermission:!!manifest.permissions?.includes('nativeMessaging'), apiAvailable:typeof chrome.runtime.sendNativeMessage === 'function', host:nativeHost, error:detail };
      await chrome.storage.local.set({ connectionDiagnostics:diagnostics });
      const failure = new Error(`Chrome не подключил локальный помощник: ${detail}`);
      failure.code = 'BRIDGE_UNAVAILABLE';
      throw failure;
    }
    if (!result?.ok || result.version !== 1 || !/^[a-f0-9]{64}$/.test(result.token || '')) throw new Error(result?.error || 'Локальный помощник не подтвердил подключение.');
    const health = await bridgeRequest('/health', 'GET', undefined, result.token);
    if (health.ready !== true || health.provider !== 'codex-chatgpt') throw new Error('Локальный сервис не готов.');
    await chrome.storage.local.set({ bridgeToken:result.token });
    await chrome.storage.local.remove?.(['connectionDiagnostics','recoveryError']);
    return result.token;
  })().finally(() => { nativeConnection = null; });
  return nativeConnection;
}

async function bridge(path, method = 'GET', body, candidateToken) {
  if (candidateToken !== undefined) return bridgeRequest(path, method, body, candidateToken);
  const { bridgeToken } = await chrome.storage.local.get('bridgeToken');
  if (/^[a-f0-9]{64}$/.test(bridgeToken || '')) {
    try { return await bridgeRequest(path, method, body, bridgeToken); }
    catch (error) {
      // 401 is rejected before side effects; an ambiguous POST timeout must never resend a job.
      if (error.status !== 401 && !(method === 'GET' && error.network)) throw error;
    }
  }
  return bridgeRequest(path, method, body, await connectNative());
}

async function cancelTab(tabId, nonce) {
  const key = `solver:${tabId}`;
  const job = (await chrome.storage.session.get(key))[key];
  if (!job || (nonce && job.nonce !== nonce)) return;
  await chrome.storage.session.remove(key);
  try { await bridge(`/jobs/${job.id}`, 'DELETE'); } catch { /* Local timeout still bounds a disconnected job. */ }
}

async function handle(request, sender) {
  if (sender.url === chrome.runtime.getURL('popup.html') && request.action === 'recoveryStatus') return {running:!!activeRecovery,tabId:activeRecovery?.tabId};
  if (sender.url === chrome.runtime.getURL('popup.html') && request.action === 'cancelRecovery') { recoveryGeneration++; activeRecovery=null; await chrome.storage.local.remove?.('pendingCourseRecovery'); return {cancelled:true}; }
  if (sender.url === chrome.runtime.getURL('popup.html') && request.action === 'connect') { await connectNative(); return { ready:true, provider:'codex-chatgpt' }; }
  if (sender.url === chrome.runtime.getURL('popup.html') && request.action === 'health') return bridge('/health', 'GET', undefined, request.data?.bridgeToken);
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || !/^https:\/\/(www\.)?coursera\.org\/learn\//.test(sender.url || '')) throw new Error('Команда доступна только на странице курса.');
  const nonce = request.data?.nonce;
  if (typeof nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(nonce)) throw new Error('Страница изменилась. Запустите решение заново.');
  return withTab(tabId, active => handleTab(request, active, tabId, nonce), sender);
}

async function handleTab(request, sender, tabId, nonce) {
  if (request.action === 'cancel') { await cancelTab(tabId, nonce); return { status: 'cancelled' }; }
  const key = `solver:${tabId}`;
  if (request.action === 'start') {
    await cancelTab(tabId);
    if (CourseraStudy.itemKey(request.data.url) !== CourseraStudy.itemKey(sender.url)) throw new Error('Страница теста изменилась.');
    if(request.data.task||!/^https:\/\/(?:www\.)?coursera\.org\/learn\/[^/]+\/(?:quiz|exam|assignment-submission)\//.test(sender.url))throw new Error('Автоматическое решение доступно только в тестах.');
    const body = { url: sender.url, questions: request.data.questions, ...(request.data.feedback===undefined?{}:{feedback:request.data.feedback}) };
    try { await bridge('/health'); }
    catch (error) { error.code = 'BRIDGE_UNAVAILABLE'; throw error; }
    const requestingDocument = async () => {
      try {
        const current = await chrome.tabs.sendMessage(tabId, { source:'coursera-study-tools', action:'solverCheck', data:{nonce,documentNonce:request.data.documentNonce} });
        return current?.ok && current.data === true;
      } catch { return false; }
    };
    if (!await requestingDocument()) throw new Error('Страница теста изменилась. Решение отменено.');
    const created = await bridge('/jobs', 'POST', body);
    if (!await requestingDocument()) {
      await bridge(`/jobs/${created.id}`, 'DELETE');
      throw new Error('Страница теста изменилась. Решение отменено.');
    }
    await chrome.storage.session.set({ [key]: { id: created.id, nonce, url: sender.url, documentId:sender.documentId } });
    return { status: 'running' };
  }
  if (request.action === 'poll') {
    const job = (await chrome.storage.session.get(key))[key];
    if (!job || job.nonce !== nonce || CourseraStudy.itemKey(job.url) !== CourseraStudy.itemKey(sender.url)) throw new Error('Задача отменена или страница изменилась.');
    const result = await bridge(`/jobs/${job.id}`);
    if (result.status !== 'running') await chrome.storage.session.remove(key);
    return result;
  }
  throw new Error('Неизвестная команда решателя.');
}

async function handleCourse(request, sender) {
  const tabId = sender.tab?.id;
  const scope = sender.url?.match(/^https:\/\/(?:www\.)?coursera\.org\/learn\/[^/]+\//)?.[0];
  if (!Number.isInteger(tabId) || !scope) throw new Error('Откройте материал курса на Coursera.');
  if(request.action==='preferences'){
    const {settings={}}=await chrome.storage.local.get('settings');
    return {speed:[1,1.25,1.5,1.75,2].includes(Number(settings.speed))?Number(settings.speed):2,skipVideo:typeof settings.skipVideo==='boolean'?settings.skipVideo:true,autoNext:settings.autoNext!==false,autoHonorCode:settings.autoHonorCode===true,target100:settings.target100!==false};
  }
  return withTab(tabId, async active => {
    sender=active;
    const scope=sender.url?.match(/^https:\/\/(?:www\.)?coursera\.org\/learn\/[^/]+\//)?.[0];
    if(!scope)throw new Error('Откройте материал курса на Coursera.');
    const key = `course:${tabId}`;
    let record = (await chrome.storage.session.get(key))[key];
    if (record?.accountHint && request.data?.accountHint && record.accountHint !== String(request.data.accountHint).slice(0, 200)) {
      await chrome.storage.session.remove(key);  await cancelTab(tabId);
      throw new Error('Аккаунт Coursera изменился. Запустите отдельный сеанс.');
    }
    if (record && record.scope !== scope) {
      await chrome.storage.session.remove(key);
      
      await cancelTab(tabId);
      record = null;
    }
    if (request.action === 'resume') return record || (await chrome.storage.session.get(`courseStopped:${tabId}`))[`courseStopped:${tabId}`] || null;
    if (request.action === 'start') {
      return startCourse(scope, key, tabId, request);
    }
    if (!record && request.action === 'stop') return null;
    if (!record || record.id !== request.data?.runId) throw new Error('Сеанс курса уже остановлен или заменён.');
    if(request.action==='navigation'){
      const tab=await chrome.tabs.get(tabId);
      return tab.pendingUrl ? tab.pendingUrl.startsWith(record.scope) : tab.status==='loading' && !!tab.url?.startsWith(record.scope);
    }
    if (request.action === 'stop') {
      await chrome.storage.session.set({[`courseStopped:${tabId}`]:{inactive:true,reason:String(request.data?.reason||'Прохождение курса остановлено.').slice(0,500)}});
      await chrome.storage.session.remove(key);
      
      await cancelTab(tabId);
      return null;
    }
    if (request.action === 'save') {
      const progress = request.data?.progress;
      if (!progress || !Array.isArray(progress.visited) || !Array.isArray(progress.submitted) || !Array.isArray(progress.pages)) throw new Error('Некорректное состояние курса.');
      if (JSON.stringify(progress).length > 256000) throw new Error('Очередь и разборы ошибок курса превысили предел сохранения.');
      record.progress = progress;
      record.updated = Date.now();
      await chrome.storage.session.set({ [key]: record });
      await chrome.storage.local.set({ [checkpointKey(scope, record.accountHint)]: { scope, accountHint: record.accountHint, progress, updated: record.updated } });
      return record;
    }
    throw new Error('Неизвестная команда курса.');
  }, sender);
}

async function activeMessageSender(sender){
  if(!Number.isInteger(sender.tab?.id)||!sender.documentId)return sender;
  const frames=await chrome.scripting.executeScript({target:{tabId:sender.tab.id,frameIds:[0]},injectImmediately:true,func:()=>location.href});
  const frame=frames.find(entry=>entry.frameId===0&&entry.documentId===sender.documentId);
  if(!frame||typeof frame.result!=='string')throw new Error('Запрос прежней страницы отклонён: уже открыт другой документ курса.');
  return {...sender,url:frame.result};
}

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !['coursera-study-solver', 'coursera-study-course', 'coursera-study-editors'].includes(request?.source)) return;
  const result = request.source === 'coursera-study-course' ? handleCourse(request, sender) : request.source === 'coursera-study-editors' ? Promise.reject(new Error('Лабораторные и редакторы отключены.')) : handle(request, sender);
  result.then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message, ...(['BRIDGE_UNAVAILABLE','SOLVER_TEMPORARY'].includes(error.code) ? {code:error.code} : {}) }));
  return true;
});

let recovering = false;
async function resumeRecoveredCourse() {
  if (recovering || typeof CourseraRecovery === 'undefined' || !chrome.runtime.getManifest?.().permissions?.includes('nativeMessaging')) return;
  recovering = true;
  const generation = recoveryGeneration;
  try {
    const intent = (await chrome.storage.local.get(CourseraRecovery.pendingKey))[CourseraRecovery.pendingKey];
    if (!intent) return;
    await chrome.storage.local.remove(CourseraRecovery.pendingKey);
    if (!CourseraRecovery.validIntent(intent)) return;
    if (generation !== recoveryGeneration) return;
    activeRecovery = {tabId:intent.tabId};
    const target = {tabId:intent.tabId,documentIds:[intent.documentId]};
    const originalDocument = async () => {
      const [document] = await chrome.scripting.executeScript({ target, func:CourseraRecovery.snapshot });
      if (generation !== recoveryGeneration) throw new Error('Восстановленный запуск остановлен.');
      if (!CourseraRecovery.validIntent(intent) || document?.documentId !== intent.documentId || document.result?.url !== intent.url || document.result?.profile !== intent.profile) throw new Error('Страница или аккаунт изменились во время обновления. Запуск отменён.');
    };
    await originalDocument();
    if (intent.action === 'connect') {
      await connectNative();
      await originalDocument();
      return;
    }
    try { await chrome.tabs.sendMessage(intent.tabId,{source:'coursera-study-tools',action:'status'},{documentId:intent.documentId}); }
    catch { await chrome.scripting.executeScript({target,files:['core.js','queue.js','fast-videos.js','activity.js','course.js','content.js']}); }
    await originalDocument();
    const result = await chrome.tabs.sendMessage(intent.tabId,{source:'coursera-study-tools',action:'courseStart',data:{...intent.settings,recoveryGuard:{url:intent.url,profile:intent.profile,expiresAt:intent.createdAt+60000}}},{documentId:intent.documentId});
    if (!result?.ok) throw new Error(result?.error || 'Не удалось продолжить запуск после обновления.');
  } catch (error) { await chrome.storage.local.set({ recoveryError:String(error.message).slice(0,500) }); }
  finally { if (generation === recoveryGeneration) activeRecovery=null; recovering = false; }
}
chrome.runtime.onInstalled?.addListener(() => void resumeRecoveredCourse());
void resumeRecoveredCourse();
chrome.tabs.onRemoved.addListener(tabId => void withTab(tabId, async () => {
  await chrome.storage.session.remove(`course:${tabId}`);
  await chrome.storage.session.remove(`courseStopped:${tabId}`);
  
  await cancelTab(tabId);
}).catch(() => {}));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' || change.status === 'complete' || change.url) void withTab(tabId, async () => {
    const key = `course:${tabId}`;
    const record = (await chrome.storage.session.get(key))[key];
    if (record && change.url && !change.url.startsWith(record.scope)) { await chrome.storage.session.set({[`courseStopped:${tabId}`]:{inactive:true,reason:'Вкладка покинула текущий курс, сеанс отменён.'}});await chrome.storage.session.remove(key);  }
    const job=(await chrome.storage.session.get(`solver:${tabId}`))[`solver:${tabId}`];
    if(!job)return;
    if(change.url&&CourseraStudy.itemKey(change.url)!==CourseraStudy.itemKey(job.url))return cancelTab(tabId);
    try{
      if(!job.documentId)throw new Error('Unknown document');
      const active=await activeMessageSender({tab:{id:tabId},documentId:job.documentId});
      if(CourseraStudy.itemKey(active.url)!==CourseraStudy.itemKey(job.url))throw new Error('Different activity');
    }catch{await cancelTab(tabId);}
  }).catch(() => {});
});
