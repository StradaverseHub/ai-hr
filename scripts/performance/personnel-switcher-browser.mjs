import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openNativePersonnelFilter} from './navigation-browser-capture.ts';
import {PERSONNEL_PRIVATE_SEARCH_SELECTOR} from './navigation-protocol.ts';

const budgetMs=90_000;
const code=person=>'PERF'+String(person.index).padStart(4,'0');
const profile=person=>'/admin/personnel/'+person.employmentId;
const messages=JSON.parse(readFileSync(new URL('../../messages/en.json',import.meta.url),'utf8'));
const listSearch=page=>page.locator('main button[data-tour="people-search"]');
const listPath='/admin/personnel';
const searchPath=listPath+'/search';
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
  const began=performance.now(),term=code(person),current=new URL(page.url());
  const dialog=await openNativePersonnelFilter(page,remaining),field=dialog.locator(PERSONNEL_PRIVATE_SEARCH_SELECTOR);
  await field.waitFor({state:'visible',timeout:remaining()});
  assert(await field.isEditable({timeout:remaining()}),'Personnel private search is read-only');
  let submitted=0,postStatus=null;
  const isSearchPost=request=>{
   const url=new URL(request.url());
   return request.method()==='POST'&&url.origin===current.origin&&url.pathname===searchPath&&url.search==='';
  };
  const onRequest=request=>{if(isSearchPost(request))submitted++;};
  page.on('request',onRequest);
  try{
   const [response]=await Promise.all([
    page.waitForResponse(response=>isSearchPost(response.request()),{timeout:remaining()}),
    field.fill(term,{timeout:remaining()}),
   ]);
   const request=response.request(),headers=request.headers();
   postStatus=response.status();
   assert.equal(request.resourceType(),'fetch','Personnel private search did not use the automatic filter');
   assert.equal(headers.accept,'application/json','Personnel private filter did not request JSON');
   assert(headers['content-type']?.startsWith('application/x-www-form-urlencoded'),'Personnel private filter did not post form data');
   const body=new URLSearchParams(request.postData()??'');
   assert(body.getAll('term').length===1&&body.get('term')===term,'Personnel private filter did not post the exact employee code');
   assert.equal(postStatus,200,'Personnel private filter did not return an opaque destination');
   assert.equal(response.headers()['cache-control'],'private, no-store');
   assert.equal(response.headers()['referrer-policy'],'no-referrer');
   const payload=await response.json();
   assert(payload&&Object.keys(payload).length===1&&typeof payload.href==='string'&&payload.href.startsWith(listPath+'?'),
    'Personnel private filter response differs');
   const target=new URL(payload.href,current),tokens=target.searchParams.getAll('search');
   assert(target.origin===current.origin&&target.pathname===listPath&&target.hash===''&&tokens.length===1
    &&/^[A-Za-z0-9_-]{43}$/.test(tokens[0])&&tokens[0]!==current.searchParams.get('search')
    &&[...target.searchParams].every(([key,value])=>!key.includes(term)&&!value.includes(term)),
    'Personnel private filter destination exposed the term or did not provide a new opaque token');
   await page.waitForURL(url=>url.href===target.href,{timeout:remaining()});
   if(await dialog.isVisible())await dialog.getByRole('button',{name:messages.common.close,exact:true}).click({timeout:remaining()});
   await dialog.waitFor({state:'hidden',timeout:remaining()});
   const copy=messages.people.list.controls;
   const result=page.locator('main p[role="status"]').filter({hasText:copy.privateActive});
   const expired=page.locator('main p[role="status"]').filter({hasText:copy.privateExpired});
   await result.or(expired).first().waitFor({state:'visible',timeout:remaining()});
   assert(await result.isVisible()&&await expired.count()===0,'Personnel opaque result is unavailable');
   const table=page.locator('main [data-tour="people-table"] tbody');
   const row=table.locator('tr[data-employment-id='+JSON.stringify(person.employmentId)+']');
   if(visible){
    await row.getByText(person.name,{exact:true}).waitFor({state:'visible',timeout:remaining()});
    assert.equal(await table.locator('tr[data-employment-id]').count(),1,'Personnel code did not produce one authorized employee');
   }else{
    await table.getByText(messages.people.list.emptyFiltered,{exact:true}).waitFor({state:'visible',timeout:remaining()});
    assert.equal(await table.locator('tr[data-employment-id]').count(),0,'Personnel search exposed a foreign employee');
   }
   assert.equal(submitted,1,'One Personnel edit must submit exactly one private filter request');
  }catch(error){
   (report.personnelSearchFailures??=[]).push({phase,role:user.role,step,submitted:submitted>0,postStatus,
    path:new URL(page.url()).pathname,hasOpaqueResult:new URL(page.url()).searchParams.has('search')});
   save();
   throw error;
  }finally{page.off('request',onRequest);}
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
 if(new URL(page.url()).pathname!==listPath)await goto(listPath,messages.people.list.adminTitle);
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
