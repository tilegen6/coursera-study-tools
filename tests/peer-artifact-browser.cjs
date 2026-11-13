const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');

(async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.route('https://www.coursera.org/**',route=>route.fulfill({contentType:'text/html',body:'<main></main>'}));
    await page.goto('https://www.coursera.org/learn/demo/peer/p/title/review/r');
    for(const file of ['core.js','assignment-core.js','assignments.js'])await page.addScriptTag({path:path.join(__dirname,'../extension',file)});
    await page.evaluate(()=>{
      window.chrome={runtime:{sendMessage:async()=>({ok:true,data:[]})}};
      const visible=element=>!!element&&element.getClientRects().length>0;
      window.assignmentPage=CourseraAssignmentPage.create({scope:()=>document.querySelector('main'),visible,label:element=>CourseraStudy.normalize(element.innerText),buttons:()=>[...document.querySelectorAll('button')].filter(visible),active:id=>id==='run'});
    });
    for(const marker of ['data-testid="peer-artifact"','data-test="peer-artifact"','class="rc-PeerSubmission"']){
      await page.setContent(`<main><h1>Review this assignment</h1><section ${marker}><h2>You passed!</h2><p>The peer submission contains this heading as its own content.</p></section></main>`);
      assert.equal(await page.evaluate(()=>assignmentPage.status()),null,`${marker}: peer content must not become a site grade`);
      await page.setContent(`<main><h1>Review this assignment</h1><h2>You passed!</h2><section ${marker}><label>Peer answer<textarea>Original peer answer</textarea></label></section></main>`);
      assert.equal((await page.evaluate(()=>assignmentPage.status())).status,'completed',`${marker}: peer controls must not hide the real site grade`);
      await page.setContent(`<main><h1>Review this assignment</h1><form data-test="peer-review-form"><section ${marker}><h2>Peer work</h2><p>This is the complete written work submitted by another learner.</p><label>Peer answer<textarea id="peer-answer">Original peer answer</textarea></label><label>Peer choice<select><option>Original choice</option></select></label><label>Peer selection<input type="checkbox" checked></label></section><div data-test="rubric">Explain whether the submitted work meets the stated requirements.</div><label>Review feedback<textarea id="review-feedback"></textarea></label><button>Submit review</button></form></main>`);
      const fields=await page.evaluate(async()=>(await assignmentPage.inspect('run')).task.fields.map(field=>field.label));
      assert.deepEqual(fields,['Review feedback'],`${marker}: peer controls must not become review answer fields`);
      assert.equal(await page.locator('#peer-answer').inputValue(),'Original peer answer');
    }
    console.log('PEER_ARTIFACT_BROWSER_PASSED');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
