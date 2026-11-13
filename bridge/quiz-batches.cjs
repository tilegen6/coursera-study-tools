'use strict';
async function solveQuizBatches(quiz,solve,signal){
  signal?.throwIfAborted();
  const initial=await solve(quiz);signal?.throwIfAborted();
  if(initial.status!=='uncertain'||quiz.questions.length<=5)return initial;
  const answers=[];
  for(let start=0;start<quiz.questions.length;start+=5){
    signal?.throwIfAborted();
    const questions=quiz.questions.slice(start,start+5),result=await solve({...quiz,questions});
    signal?.throwIfAborted();
    if(result.status!=='solved')return {...result,reason:`Вопросы ${questions.map(q=>q.id).join(', ')}: ${result.reason||'недостаточно контекста'}`};
    answers.push(...result.answers);
  }
  return {status:'solved',reason:'',answers};
}
module.exports={solveQuizBatches};
