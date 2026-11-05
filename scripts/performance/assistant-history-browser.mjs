/** Actual saved-history navigation for the disposable CI server. No prompt or mutation is submitted. */
import assert from 'node:assert/strict';

export function assertSavedHistoryBrowserFixture(history){
 assert.equal(history.version,1);assert.equal(history.rowsVerified,true);assert.equal(history.defaultCompanyScopeOnly,true);
 assert.equal(history.rootTitles.length,20);assert.equal(history.leafIds.length,20);assert.equal(history.selectedQuestions.length,2);
}

/** Root driver owns visit(), timeouts, phase labels, persistence and acceptance budgets.
 * Persist only onMeasurement rows; history is a PRIVATE fixture object containing fictional transcript expectations. */
export async function verifyAssistantHistoryBrowser({page,history,visitAsk,timeout,onMeasurement}){
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.AUTH_PROVIDER,'internal');
 assert.equal(process.env.AUTH_PUBLIC_ORIGIN,'https://localhost:3443');
 assertSavedHistoryBrowserFixture(history);
 assert.equal((await page.context().cookies()).some(cookie=>cookie.name==='company_scope'),false,'Saved-history fixture requires the default company selection.');
 const start=performance.now();await visitAsk();assert.equal(new URL(page.url()).origin,'https://localhost:3443');
 const waitStart=performance.now(),navigation=page.locator('nav[data-ai-saved-chats-ready="true"]:visible');
 await navigation.waitFor({state:'visible',timeout});
 const readinessWaitMs=performance.now()-waitStart;
 const assertTitles=async()=>{
  assert.equal(await navigation.count(),1,'Expected one visible saved-history owner.');
  const links=navigation.locator('a[href^="/assistant?e="]');
  assert.equal(await links.count(),20,'Saved-history exercise must not pass on an empty Ask.');
  assert.deepEqual(await links.allTextContents(),history.rootTitles);
  return links;
 };
 await assertTitles();await page.locator('[data-ask-conversation] textarea:enabled').waitFor({state:'visible',timeout});
 await onMeasurement({step:'saved-history-list',userIndex:history.userIndex,navigationToUsableMs:performance.now()-start,readinessWaitMs,verifiedRootTitles:20,retainedExchanges:160,fixture:'canonical-sealed-owned-transcripts',promptsSubmitted:0});
 const documents=[];const onRequest=request=>{if(request.resourceType()==='document')documents.push(true);};page.on('request',onRequest);
 try{
  const path='/assistant?e='+history.leafIds[0],link=navigation.locator('a[href="'+path+'"]'),clickStart=performance.now();
  await Promise.all([page.waitForURL(url=>url.pathname==='/assistant'&&url.search==='?e='+history.leafIds[0],{timeout}),link.click({timeout})]);
  await navigation.locator('a[aria-current="page"][href="'+path+'"]').waitFor({state:'visible',timeout});
  const log=page.locator('[data-ask-conversation] [role="log"]');
  for(const question of history.selectedQuestions)await log.getByText(question,{exact:true}).waitFor({state:'visible',timeout});
  assert.deepEqual(await log.locator(':scope > div > p:first-child').allTextContents(),history.selectedQuestions,'Expected exactly the selected two-turn conversation.');
  await page.locator('[data-ask-conversation] textarea:enabled').waitFor({state:'visible',timeout});
  assert.equal(documents.length,0,'Saved-history selection unexpectedly reloaded the document.');
  await onMeasurement({step:'saved-history-open',userIndex:history.userIndex,clickToUsableMs:performance.now()-clickStart,verifiedTurns:2,documentRequests:0,promptsSubmitted:0});
  const returnWait=performance.now(),ask=page.locator('[data-ai-centre-tabs] a[href="/assistant"][data-ai-centre-link-ready="true"]');
  await ask.waitFor({state:'visible',timeout});const returnReadinessWaitMs=performance.now()-returnWait,returnStart=performance.now();
  await Promise.all([page.waitForURL(url=>url.pathname==='/assistant'&&url.search==='',{timeout}),ask.click({timeout})]);
  await navigation.waitFor({state:'visible',timeout});await assertTitles();await page.locator('[data-ask-conversation] textarea:enabled').waitFor({state:'visible',timeout});
  assert.equal(documents.length,0,'Returning from saved history unexpectedly reloaded the document.');
  await onMeasurement({step:'saved-history-return',userIndex:history.userIndex,clickToUsableMs:performance.now()-returnStart,readinessWaitMs:returnReadinessWaitMs,verifiedRootTitles:20,documentRequests:0,promptsSubmitted:0});
 }finally{page.off('request',onRequest);}
}
