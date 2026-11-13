(function (root) {
  'use strict';
  const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();

  function courseRoot(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !['www.coursera.org', 'coursera.org'].includes(url.hostname)) return null;
      return url.pathname.match(/^\/learn\/[^/]+\//)?.[0] || null;
    } catch { return null; }
  }

  function lessonKind(pathname) {
    const type = pathname.match(/^\/learn\/[^/]+\/([^/]+)\//)?.[1];
    return ({ lecture: 'video', supplement: 'reading', ungradedWidget: 'practice' })[type] || 'manual';
  }

  function activityKind(pathname) {
    const type = pathname.match(/^\/learn\/[^/]+\/([^/]+)(?:\/|$)/)?.[1];
    if (['quiz', 'exam'].includes(type)) return 'quiz';
    if (type === 'assignment-submission') return 'assessment';
    if (type === 'coach') return 'coach';
    if (type === 'peer') return 'peer';
    if (['programming', 'gradedProgramming'].includes(type)) return 'programming';
    if (['ungradedLti', 'gradedLti', 'lab', 'labs'].includes(type)) return 'lab';
    if (['home', 'week'].includes(type) || /^\/learn\/[^/]+\/$/.test(pathname)) return 'outline';
    return lessonKind(pathname);
  }

  function itemKey(value) {
    if (!courseRoot(value)) return null;
    const url = new URL(value);
    const base = url.pathname.match(/^\/learn\/[^/]+\/(?:lecture|supplement|ungradedWidget|quiz|exam|assignment-submission|peer|programming|gradedProgramming|ungradedLti|gradedLti|lab|labs|coach)\/[^/]+/)?.[0];
    const review = base?.includes('/peer/') && url.pathname.slice(base.length).match(/\/review\/([^/]+)/)?.[1];
    return url.origin + (base ? base + (review ? `/review/${review}` : '') : url.pathname.replace(/\/$/, ''));
  }

  function quizResult(value) {
    const lines = String(value || '').split(/\r?\n/).map(normalize);
    if (lines.some(line => /^(you (did not|have not|haven't) pass|not passed|failed|тест не пройден|вы не прошли)(?:[\s.!:]|$)/i.test(line))) return 'failed';
    if (lines.some(line => /^(you (?:have )?passed|passed|вы (?:успешно )?прошли (?:тест|задание)|тест (?:успешно )?пройден)(?:[\s.!:]|$)/i.test(line))) return 'passed';
    return null;
  }

  function gradePercent(value) {
    const match=normalize(value).match(/^(\d{1,3}(?:[.,]\d{1,4})?)\s*%$/);
    const grade=match?Number(match[1].replace(',','.')):NaN;
    return Number.isFinite(grade)&&grade>=0&&grade<=100?grade:null;
  }

  function parseAnswers(raw) {
    if (typeof raw !== 'string' || raw.length > 200000) throw new Error('Ответ должен быть JSON размером до 200 КБ.');
    return JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  }

  function quizSnapshot(questions) {
    return JSON.stringify(questions.map(question=>question.images?{...question,images:question.images.map(image=>{
      try{
        const url=new URL(image.url);
        if(url.origin!=='https://d3c33hcgiwev3.cloudfront.net'||url.username||url.password||!url.pathname.startsWith('/imageAssetProxy.v1/'))return image;
        // Coursera refreshes authorization without changing the diagram itself.
        url.searchParams.delete('expiry');url.searchParams.delete('hmac');
        return {...image,url:url.href};
      }catch{return image;}
    })}:question));
  }

  function validateAnswers(payload, questions) {
    if (!Array.isArray(payload?.answers) || payload.answers.length !== questions.length || !questions.length) {
      throw new Error('Нужен объект answers с ответом на каждый видимый вопрос.');
    }
    const seen = new Set();
    return payload.answers.map(answer => {
      const question = questions.find(item => item.id === answer?.id);
      if (!question || seen.has(answer.id) || normalize(answer.question) !== question.question) {
        throw new Error('Вопросы изменились или ID повторяются. Экспортируйте вопросы заново.');
      }
      seen.add(answer.id);
      if (question.type === 'text') {
        if (typeof answer.text !== 'string' || !answer.text.trim() || answer.text.length > 10000) throw new Error('Некорректный текст ответа.');
      } else {
        if (!Array.isArray(answer.options) || JSON.stringify(answer.options) !== JSON.stringify(question.options)) {
          throw new Error('Варианты ответов изменились. Сохраните options из экспорта без изменений.');
        }
        if (!Array.isArray(answer.choices) || !answer.choices.length ||
          (question.type === 'radio' && answer.choices.length !== 1) ||
          new Set(answer.choices).size !== answer.choices.length ||
          answer.choices.some(index => !Number.isInteger(index) || index < 1 || index > question.options.length)) {
          throw new Error('choices: номера вариантов начинаются с 1; radio допускает один ответ.');
        }
      }
      return answer;
    });
  }

  const api = { normalize, courseRoot, lessonKind, activityKind, itemKey, quizResult, gradePercent, parseAnswers, validateAnswers, quizSnapshot };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CourseraStudy = api;
})(globalThis);
