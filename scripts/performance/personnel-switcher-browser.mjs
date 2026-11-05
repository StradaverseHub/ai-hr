import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const budgetMs=90_000;
const code=person=>'PERF'+String(person.index).padStart(4,'0');
const profile=person=>'/admin/personnel/'+person.employmentId;
const messages=JSON.parse(readFileSync(new URL('../../messages/en.json',import.meta.url),'utf8'));
const listSearch=page=>page.locator('main form[action="/admin/personnel/search"]');
const box=page=>page.locator('main [data-tour="personnel-employee-switcher"]:visible');

/** Authenticated Personnel journey using the private list search and the profile switcher. */
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
 async function results(){
  const id=await box(page).getAttribute('aria-controls',{timeout:remaining()});
  assert(id,'Personnel switcher must identify its results list');
  return page.locator('[id='+JSON.stringify(id)+']');
 }
 const capture=(step,began,extra={})=>{
  (report.personnelSwitcherBrowser??=[]).push({phase,role:user.role,step,elapsedMs:performance.now()-began,usable:true,loadAtReady:loadState?.(),...extra});
  save();
 };
 async function goto(path,heading){
  const began=performance.now();
  const response=await page.goto(new URL(path,page.url()).href,{waitUntil:'domcontentloaded',timeout:remaining()});
  assert(response?.ok(),'Personnel navigation refused');
  await page.getByRole('heading',{level:1,name:heading,exact:true}).waitFor({timeout:remaining()});
  const isProfile=path.includes('?tab=');
  await (isProfile?box(page):listSearch(page)).waitFor({timeout:remaining()});
  capture(isProfile?'profile-open':'list-open',began);
 }
 async function searchList(person,step,visible){
  const began=performance.now(),term=code(person),form=listSearch(page);
  const oldToken=new URL(page.url()).searchParams.get('search');
  await form.locator('input[name="term"]').fill(term,{timeout:remaining()});
  let submitted=false,postStatus=null,cacheControl=null;
  const isSearchPost=request=>request.method()==='POST'&&new URL(request.url()).pathname==='/admin/personnel/search';
  const onRequest=request=>{if(isSearchPost(request))submitted=true;};
  const onResponse=response=>{
   if(!isSearchPost(response.request()))return;
   postStatus=response.status();
   cacheControl=response.headers()['cache-control']??null;
  };
  page.on('request',onRequest);
  page.on('response',onResponse);
  try{
   await Promise.all([
    page.waitForURL(url=>{
     const token=url.searchParams.get('search');
     return url.pathname==='/admin/personnel'&&token!==null&&token!==oldToken&&/^[A-Za-z0-9_-]{43}$/.test(token);
    },{timeout:remaining()}),
    form.evaluate(form=>form.requestSubmit()),
   ]);
   assert(submitted,'Personnel search did not submit the native form');
   assert.equal(postStatus,303,'Personnel private search did not redirect');
   assert.equal(cacheControl,'private, no-store');
   assert(!page.url().includes(term),'Private search exposed the term in its result URL');
  }catch(error){
   (report.personnelSearchFailures??=[]).push({phase,role:user.role,step,submitted,postStatus,
    path:new URL(page.url()).pathname,hasOpaqueResult:new URL(page.url()).searchParams.has('search')});
   save();
   throw error;
  }finally{
   page.off('request',onRequest);
   page.off('response',onResponse);
  }
  const active=page.locator('main p').filter({hasText:messages.personnelOrganisationFilters.privateActive});
  const unavailable=page.locator('main p').filter({hasText:messages.personnelOrganisationFilters.privateUnavailable});
  await active.or(unavailable).first().waitFor({timeout:remaining()});
  assert.equal(await active.count(),1,'Personnel redirected but the private result is unavailable');
  const table=page.locator('main tbody');
  if(visible)await table.getByText(person.name,{exact:true}).waitFor({timeout:remaining()});
  else{
   await table.getByText(messages.people.list.emptyFiltered,{exact:true}).waitFor({timeout:remaining()});
   assert.equal(await table.getByText(person.name,{exact:true}).count(),0);
  }
  capture(step,began,{matched:visible,opaqueResult:true});
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
 else await listSearch(page).waitFor({timeout:remaining()});
 await searchList(outside,'outside-tenant-search-refused',false);
 await searchList(first,'list-code-search',true);
 await goto(profile(first)+'?tab=job',first.name);
 const began=performance.now();
 await box(page).fill(code(second),{timeout:remaining()});
 const profileResults=await results();
 const secondOption=profileResults.getByRole('option').filter({hasText:second.name});
 await secondOption.waitFor({timeout:remaining()});
 const resultCount=await profileResults.getByRole('option').count();
 assert(resultCount>0&&resultCount<=8,'invalid profile switcher result bound');
 capture('profile-code-search',began,{resultCount,source:'existing-local'});
 await jump(secondOption,second,'job');
}
