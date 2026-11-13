(() => {
  'use strict';
  const VERSION = '1.8.10';
  const pendingKey = 'pendingCourseRecovery';
  const courseURL = value => /^https:\/\/(?:www\.)?coursera\.org\/learn\/[^/]+\//.test(value || '');
  function snapshot() {
    const profile = document.querySelector('header [data-user-id]')?.getAttribute('data-user-id') || document.querySelector('header a[href*="/user/"]')?.getAttribute('href') || '';
    return { url:location.href, profile };
  }
  function validIntent(intent, now = Date.now()) {
    return intent?.version === 1 && ['courseStart','connect'].includes(intent.action) && Number.isInteger(intent.tabId) && courseURL(intent.url) && typeof intent.documentId === 'string' && intent.documentId.length > 0 && intent.documentId.length <= 100 && typeof intent.profile === 'string' && intent.profile.length <= 300 && Number.isFinite(intent.createdAt) && now >= intent.createdAt && now - intent.createdAt < 60000 && [1,1.25,1.5,1.75,2].includes(intent.settings?.speed) && ['skipVideo','autoNext','resumeQueue'].every(key => typeof intent.settings[key] === 'boolean') && ['autoHonorCode','target100'].every(key=>intent.settings[key]===undefined||typeof intent.settings[key]==='boolean');
  }
  async function assertIdle() {
    const sessions = await chrome.storage.session.get(null);
    if (Object.keys(sessions).some(key => /^(course|solver):/.test(key) && sessions[key])) throw new Error('Перед применением обновления остановите активные сеансы расширения.');
    const tabs = await chrome.tabs.query({url:['https://www.coursera.org/learn/*','https://coursera.org/learn/*']});
    const states = await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id,{source:'coursera-study-tools',action:'status'})));
    if (states.some(result => result.status === 'fulfilled' && (result.value?.data?.courseRunning || result.value?.data?.running || result.value?.data?.solving))) throw new Error('Перед применением обновления остановите активные сеансы расширения.');
  }
  async function prepare(tabId, settings, action = 'courseStart') {
    const loaded = chrome.runtime.getManifest();
    if (loaded.version === VERSION && loaded.permissions?.includes('nativeMessaging') && typeof chrome.runtime.sendNativeMessage === 'function') return false;
    if (!loaded.permissions?.includes('nativeMessaging')) {
      const message = `Chrome пока загрузил версию ${loaded.version} без nativeMessaging. Применяется установленное обновление.`;
      await chrome.storage.local.set({connectionDiagnostics:{extensionId:chrome.runtime.id,loadedVersion:loaded.version,nativePermission:false,apiAvailable:typeof chrome.runtime.sendNativeMessage==='function',host:'com.coursera.studytools',error:message}});
    }
    const installed = await fetch(chrome.runtime.getURL('manifest.json'), { cache:'no-store' }).then(response => response.json());
    if (installed.name !== loaded.name || installed.version !== VERSION || !installed.permissions?.includes('nativeMessaging')) throw new Error(`В этой папке нет полного обновления расширения ${VERSION}.`);
    if (loaded.version === installed.version && loaded.permissions?.includes('nativeMessaging')) return false;
    await assertIdle();
    const [document] = await chrome.scripting.executeScript({ target:{tabId}, func:snapshot });
    const intent = {version:1,action,tabId,url:document?.result?.url,profile:document?.result?.profile,documentId:document?.documentId,createdAt:Date.now(),settings};
    if (!validIntent(intent)) throw new Error('Не удалось безопасно сохранить запуск этой вкладки.');
    await chrome.storage.local.set({ [pendingKey]:intent });
    chrome.runtime.reload();
    return true;
  }
  const api = { VERSION, pendingKey, snapshot, validIntent, prepare, assertIdle };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.CourseraRecovery = api;
})();
