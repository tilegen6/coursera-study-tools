const path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();await page.route('https://www.coursera.org/**',route=>route.fulfill({contentType:'text/html',body:'<main></main>'}));await page.goto('https://www.coursera.org/learn/demo/assignment-submission/work/title');
    for(const file of ['core.js','assignment-core.js','assignments.js'])await page.addScriptTag({path:path.join(__dirname,'../extension',file)});
    await page.evaluate(()=>{window.chrome={runtime:{sendMessage:async()=>({ok:true,data:[]})}};window.assignmentPage=CourseraAssignmentPage.create({scope:()=>document.body,visible:e=>!!e&&e.getClientRects().length>0,label:e=>CourseraStudy.normalize(e.innerText),buttons:()=>[...document.querySelectorAll('button')],active:id=>id==='run'});});
    for(const explicit of [true,false]){
      await page.setContent(`<aside data-testid="left-nav">${'course navigation '.repeat(10000)}</aside><main><h1>Written assessment</h1><${explicit?'article data-testid="assignment-instructions"':'section'}><p>Explain how stable locators make browser tests maintainable.</p><script type="application/json">${'translation data '.repeat(10000)}</script></${explicit?'article':'section'}><form><label>Answer<textarea></textarea></label><button>Submit assignment</button></form></main>`);
      const result=await page.evaluate(async()=>(await assignmentPage.inspect('run')).task);
      assert(result.instructions.length<400);assert.match(result.instructions,/stable locators/);assert(!result.instructions.includes('translation data'));assert(!result.instructions.includes('course navigation'));assert.equal(result.fields.length,1);
    }
    console.log('ASSESSMENT_BROWSER_PASSED');
  }finally{await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
