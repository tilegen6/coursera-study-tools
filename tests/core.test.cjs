const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/core.js');

test('quiz snapshots ignore only authorization rotation on the trusted Coursera image proxy',()=>{
  const image='https://d3c33hcgiwev3.cloudfront.net/imageAssetProxy.v1/diagram.png';
  const questions=[{id:1,question:'Which diagram?',type:'radio',options:['A','B'],images:[{url:image+'?expiry=1&hmac=old&width=200',alt:'Diagram'}]}];
  const original=JSON.stringify(questions),snapshot=core.quizSnapshot(questions);
  const rotated=structuredClone(questions);rotated[0].images[0].url=image+'?expiry=2&hmac=new&width=200';
  assert.equal(core.quizSnapshot(rotated),snapshot);assert.equal(JSON.stringify(questions),original);
  for(const change of [q=>q[0].question+=' changed',q=>q[0].options.reverse(),q=>q[0].images[0].url=image.replace('diagram','different')+'?width=200',q=>q[0].images[0].url=image+'?width=300',q=>q[0].images[0].alt+=' changed',q=>q[0].images.push(q[0].images[0])]){
    const changed=structuredClone(rotated);change(changed);assert.notEqual(core.quizSnapshot(changed),snapshot);
  }
  for(const url of ['https://example.test/imageAssetProxy.v1/diagram.png','https://d3c33hcgiwev3.cloudfront.net/other/diagram.png','http://d3c33hcgiwev3.cloudfront.net/imageAssetProxy.v1/diagram.png','https://d3c33hcgiwev3.cloudfront.net:8443/imageAssetProxy.v1/diagram.png']){
    const first=[{images:[{url:url+'?expiry=1&hmac=a'}]}],second=[{images:[{url:url+'?expiry=2&hmac=b'}]}];assert.notEqual(core.quizSnapshot(first),core.quizSnapshot(second));
  }
});

test('grade parser accepts only a standalone actual percentage, never a passing threshold sentence',()=>{
  assert.equal(core.gradePercent('91,66\u00a0%'),91.66);assert.equal(core.gradePercent('100%'),100);assert.equal(core.gradePercent('0 %'),0);
  for(const value of ['Pass with 75%','75% then 91.66%','101%','-1%','100 / 100','',null])assert.equal(core.gradePercent(value),null);
});

test('Coach dialogue routes have a supported kind and stable item identity',()=>{
  const base='https://www.coursera.org/learn/demo/coach/one';
  assert.equal(core.activityKind(new URL(base+'/title').pathname),'coach');
  assert.equal(core.itemKey(base+'/title'),core.itemKey(base+'/title/attempt'));
});

test('accepts course lessons only on HTTPS Coursera', () => {
  assert.equal(core.courseRoot('https://www.coursera.org/learn/demo/lecture/a/intro'), '/learn/demo/');
  for (const url of ['https://coursera.org.evil.test/learn/demo/', 'https://evil.test/learn/demo/', 'http://www.coursera.org/learn/demo/', 'javascript:alert(1)', 'https://www.coursera.org/']) {
    assert.equal(core.courseRoot(url), null);
  }
});

test('quiz answers bind to question text and validate all choices before applying', () => {
  const questions = [{ id: 1, question: 'One?', type: 'radio', options: ['A', 'B'] }, { id: 2, question: 'Two?', type: 'checkbox', options: ['C', 'D'] }];
  const answers = { answers: [{ id: 1, question: 'One?', options: ['A', 'B'], choices: [2] }, { id: 2, question: 'Two?', options: ['C', 'D'], choices: [1, 2] }] };
  assert.deepEqual(core.validateAnswers(answers, questions), answers.answers);
  for (const change of [
    () => answers.answers[0].choices.push(1),
    () => answers.answers[0].choices.splice(0, 1, 0),
    () => answers.answers[0].choices.splice(0, 1, 3),
    () => answers.answers[0].question = 'Another question',
    () => answers.answers[0].options.reverse(),
    () => answers.answers[0].id = 2,
    () => answers.answers[1].choices = [1, 1],
    () => answers.answers.pop()
  ]) {
    const copy = structuredClone(answers);
    change();
    assert.throws(() => core.validateAnswers(answers, questions));
    answers.answers = copy.answers;
  }
  assert.throws(() => core.validateAnswers({}, questions));
});

test('text answers and fenced ChatGPT JSON are supported without evaluating code', () => {
  const questions = [{ id: 1, question: 'Value?', type: 'text', options: [] }];
  const raw = '```json\n{"answers":[{"id":1,"question":"Value?","text":"42"}]}\n```';
  assert.equal(core.validateAnswers(core.parseAnswers(raw), questions)[0].text, '42');
  assert.throws(() => core.parseAnswers('alert(1)'));
  assert.throws(() => core.validateAnswers({ answers: [{ id: 1, question: 'Value?', text: '' }] }, questions));
});

test('unsupported graded routes are never candidates for automatic advancement', () => {
  for (const kind of ['quiz', 'exam', 'peer', 'programming', 'discussion', 'ungradedLti']) {
    assert.equal(core.lessonKind(`/learn/demo/${kind}/abc/title`), 'manual');
  }
  assert.equal(core.lessonKind('/learn/demo/lecture/abc/title'), 'video');
  assert.equal(core.lessonKind('/learn/demo/supplement/abc/title'), 'reading');
  assert.equal(core.lessonKind('/learn/demo/ungradedWidget/abc/title'), 'practice');
});

test('course runner classifies quiz and overview separately and binds canonical items', () => {
  assert.equal(core.activityKind('/learn/demo/exam/a/title'), 'quiz');
  assert.equal(core.activityKind('/learn/demo/quiz/a/title'), 'quiz');
  assert.equal(core.activityKind('/learn/demo/assignment-submission/a/title/attempt'), 'assessment');
  assert.equal(core.lessonKind('/learn/demo/assignment-submission/a/title'), 'manual');
  assert.equal(core.itemKey('https://www.coursera.org/learn/demo/assignment-submission/a/title/attempt'), core.itemKey('https://www.coursera.org/learn/demo/assignment-submission/a/title'));
  assert.equal(core.activityKind('/learn/demo/home/week/1'), 'outline');
  assert.equal(core.activityKind('/learn/demo/peer/a/title'), 'peer');
  assert.equal(core.itemKey('https://www.coursera.org/learn/demo/exam/a/title?attempt=2#grade'), 'https://www.coursera.org/learn/demo/exam/a');
});

test('quiz result requires an explicit pass or failure, not a grading instruction', () => {
  assert.equal(core.quizResult('You passed!'), 'passed');
  assert.equal(core.quizResult('Вы успешно прошли тест!'), 'passed');
  assert.equal(core.quizResult('You did not pass'), 'failed');
  assert.equal(core.quizResult('Тест не пройден'), 'failed');
  for (const text of ['To pass you need 80%', 'Your answers have been submitted', 'Passing grade: 70%', 'Completed', 'Try again']) {
    assert.equal(core.quizResult(text), null);
  }
});
