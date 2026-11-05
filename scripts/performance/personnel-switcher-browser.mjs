import assert from 'node:assert/strict';

const budgetMs=90_000;
const code=person=>'PERF'+String(person.index).padStart(4,'0');
const profile=person=>'/admin/personnel/'+person.employmentId;
const box=page=>page.locator('main [data-tour="personnel-employee-switcher"]:visible');

/** Read-only journey for the already-authenticated group HR context; no extra browser or lease. */
export async function exercisePersonnelSwitcher({page,user,fixture,report,save,phase,loadState}){
 assert.equal(user.role,'groupHR');
 const deadline=performance.now()+budgetMs;
 const remaining=()=>{
  const left=Math.ceil(deadline-performance.now());
  assert(left>0,'Personnel switcher journey exceeded its browser budget');
  return left;
 };
 const [first,second]=fixture.users.filter(person=>person.tenant===user.tenant&&person.company===user.company&&person.role==='employee');
 const outside=fixture.users.find(person=>person.tenant!==user.tenant);
 assert(first&&second&&outside,'missing fictional switcher witnesses');
 const capture=(step,began,extra={})=>{
  (report.personnelSwitcherBrowser??=[]).push({phase,role:user.role,step,elapsedMs:performance.now()-began,usable:true,loadAtReady:loadState?.(),...extra});
  save();
 };
 async function goto(path,heading){
  const began=performance.now();
  const response=await page.goto(new URL(path,page.url()).href,{waitUntil:'domcontentloaded',timeout:remaining()});
  assert(response?.ok(),'Personnel navigation refused');
  await page.getByRole('heading',{level:1,name:heading,exact:true}).waitFor({timeout:remaining()});
  await box(page).waitFor({timeout:remaining()});
  capture(path.includes('?tab=')?'profile-open':'list-open',began);
 }
 async function search(person,step,visible){
  const began=performance.now(),q=code(person);
  const [actual]=await Promise.all([page.waitForResponse(response=>{
   const url=new URL(response.url());
   return url.pathname==='/api/personnel/search'&&url.searchParams.get('q')===q;
  },{timeout:remaining()}),box(page).fill(q,{timeout:remaining()})]);
  assert(actual.ok(),'Personnel search failed');
  assert.equal(actual.headers()['cache-control'],'private, no-store');
  const payload=await actual.json();
  assert(Array.isArray(payload.rows)&&payload.rows.length<=8,'invalid switcher result bound');
  if(!visible){
   assert.equal(payload.rows.length,0);
   await page.getByText('No employee matches that.',{exact:true}).waitFor({timeout:remaining()});
   assert.equal(await page.getByRole('option').count(),0);
   capture(step,began,{resultCount:0});
   return null;
  }
  assert.equal(payload.rows[0]?.employmentId,person.employmentId,'exact employee code must rank first');
  const option=page.getByRole('option').filter({hasText:person.name});
  await option.waitFor({timeout:remaining()});
  capture(step,began,{resultCount:payload.rows.length});
  return option;
 }
 async function jump(option,person,tab){
  assert(option);
  const began=performance.now();
  await option.click({timeout:remaining()});
  await page.waitForURL(url=>url.pathname===profile(person)&&url.searchParams.get('tab')===tab,{timeout:remaining()});
  await page.getByRole('heading',{level:1,name:person.name,exact:true}).waitFor({timeout:remaining()});
  await box(page).waitFor({timeout:remaining()});
  capture('profile-jump',began,{keptTab:tab!==null});
 }
 // Only use this helper from an existing authenticated application page with the English locale.
 const en=await page.locator('html').getAttribute('lang',{timeout:remaining()});
 assert.equal(en,'en');
 if(new URL(page.url()).pathname!=='/admin/personnel')await goto('/admin/personnel','Personnel Management');
 else await box(page).waitFor({timeout:remaining()});
 await search(outside,'outside-tenant-search-refused',false);
 await search(first,'list-code-search',true);
 await goto(profile(first)+'?tab=job',first.name);
 const began=performance.now();
 await box(page).fill(code(second),{timeout:remaining()});
 const secondOption=page.getByRole('option').filter({hasText:second.name});
 await secondOption.waitFor({timeout:remaining()});
 const resultCount=await page.getByRole('option').count();
 assert(resultCount>0&&resultCount<=8,'invalid profile switcher result bound');
 capture('profile-code-search',began,{resultCount,source:'existing-local'});
 await jump(secondOption,second,'job');
}
