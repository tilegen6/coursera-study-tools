(function(root){
'use strict';
const statuses=['pending_grade','needs_input','blocked_dependency','failed','completed','skipped'];
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


const api={updateQueue,due};if(typeof module==='object'&&module.exports)module.exports=api;else root.CourseraQueue=api;
})(globalThis);
