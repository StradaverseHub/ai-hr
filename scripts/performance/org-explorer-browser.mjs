/** Read-only built-app Org journey. The existing driver supplies its signed-in fictional actor.
 * No DB owner access, cookies/auth bypass, provider call, fixture mutation or extra browser context.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {wholeSystemOrgRoster} from './fixture-workload.mjs';

const orgOrigin='https://localhost:3443';

export async function exerciseOrgExplorer({page,user,fixture,report,save,phase}){
 assert.equal(user.role,'groupHR','Org explorer journey needs the fixture group HR actor');
 assert(['baseline','loaded','preflight'].includes(phase));
 const cohort=wholeSystemOrgRoster(fixture,user.tenant);
 const known=new Map(cohort.map(actor=>[actor.employmentId,actor]));
 const rewardMember=cohort.find(actor=>actor.role==='reward-fixture');
 const companyIds=fixture.tenants[user.tenant].companies.map(company=>company.companyId).sort();
 const catalog=locale=>JSON.parse(readFileSync(new URL(`../../messages/${locale}.json`,import.meta.url),'utf8'));
 const results=[];let stage='navigation',locale='en';
 const explorer=()=>page.locator('[data-org-explorer]');
 const picker=page.locator('[data-company-switcher]');
 const companyInputs='input[type="checkbox"][name="companyId"]';
 let scopePosts=0;
 const isScopePost=request=>{
  const url=new URL(request.url());
  return request.method()==='POST'&&url.origin===orgOrigin&&url.pathname==='/org';
 };
 const observeScopePost=request=>{if(isScopePost(request))scopePosts++;};
 const button=key=>explorer().getByRole('button',{name:catalog(locale).org.explorer[key],exact:true});
 const rows=()=>explorer().locator('[data-org-item]');
 const record=(action,started,extra={})=>{results.push({action,elapsedMs:performance.now()-started,...extra});save();};
 (report.orgExplorerJourneys??=[]).push({phase,role:user.role,user:user.index,steps:results,status:'running'});
 const entry=report.orgExplorerJourneys.at(-1);
 async function ready(expectedPeople){
  await page.locator(`[data-org-explorer][data-org-total-people="${expectedPeople}"]`).waitFor({state:'visible',timeout:90000});
  await explorer().locator('[aria-busy="false"]').waitFor({timeout:90000});
  assert.equal(await explorer().getByRole('alert').count(),0,'Org explorer displayed an error');
  assert(await rows().count()<=50,'Org explorer mounted more than one page');
 }
 function assertPeople(data,allowed){
  assert.equal(data.version,1);assert.equal(data.pageSize,50);assert(data.items.length<=50);
  const permitted=new Set(allowed.map(actor=>actor.employmentId));
  assert.equal(data.totalPeople,allowed.length);
  for(const item of data.items){
   if(item.node){assert(permitted.has(item.node.employmentId),'Out-of-scope person in Org response');assert(item.node.name===known.get(item.node.employmentId)?.name,'Org response person name differs from the fixture');}
   else{assert.equal(item.inSelectedScope,false);assert.equal(data.view,'connections');}
  }
 }
 async function request(action,view,allowed=cohort,expectedQuery){
  const started=performance.now();
  const responsePromise=page.waitForResponse(response=>{
   const url=new URL(response.url());
   return url.origin===orgOrigin&&url.pathname==='/api/org/window'&&url.searchParams.get('view')===view&&
    (expectedQuery===undefined||url.searchParams.get('q')===expectedQuery);
  },{timeout:90000});
  await action();const response=await responsePromise;
  assert.equal(response.status(),200,'Org window request failed');assert.equal(response.headers()['cache-control'],'private, no-store');
  const data=await response.json();assertPeople(data,allowed);
  await ready(allowed.length);
  await page.waitForFunction(({view,names,count})=>{
   const root=document.querySelector('[data-org-explorer]');
   if(root?.getAttribute('data-org-view')!==view||root.querySelector('[aria-busy="true"]'))return false;
   const items=[...root.querySelectorAll('[data-org-item]')];
   return items.length===count&&JSON.stringify(items.flatMap(item=>[...item.querySelectorAll('h3')].map(name=>name.textContent)))===JSON.stringify(names);
  },{view,names:data.items.flatMap(item=>item.node?[item.node.name]:[]),count:data.items.length},{timeout:90000});
  record(stage,started,{view,renderedRows:await rows().count(),totalPeople:data.totalPeople,totalItems:data.totalItems,responseJsonBytes:Buffer.byteLength(JSON.stringify(data)),hasMore:!!data.nextCursor});
  return data;
 }
 async function allPeople(allowed=cohort){return request(()=>button('allPeople').click(),'search',allowed,'');}
 async function switchLocale(next){
  const names={zh:'简体中文',en:'English'};
  await page.getByRole('button',{name:'Change language',exact:true}).click();
  const started=performance.now();await page.getByRole('button',{name:names[next],exact:true}).click();
  await page.waitForFunction(({next,title})=>{
   const picker=document.querySelector('button[aria-label="Change language"]');
   return document.documentElement.lang===next&&picker?.title===title&&!picker.disabled&&picker.getAttribute('aria-busy')==='false';
  },{next,title:names[next]},{timeout:90000});
  locale=next;await page.getByRole('heading',{level:1,name:catalog(next).org.title,exact:true}).waitFor({timeout:90000});
  await ready(cohort.length);await button('allPeople').waitFor({state:'visible'});
  assert.equal(await explorer().getAttribute('data-org-view'),'roots','Language change retained the old explorer state');
  record('language-switch',started,{locale:next,translatedHeading:true,usable:true});
 }
 async function openCompanyScope(){
  assert.equal(await picker.getAttribute('aria-expanded'),'false','Company selector unexpectedly open');
  await picker.click();
  const form=picker.locator('..').locator('form').filter({has:page.locator(companyInputs)});
  await form.waitFor({state:'visible',timeout:90000});
  assert.equal(await picker.getAttribute('aria-expanded'),'true','Company selector did not open');
  return form;
 }
 async function commitCompanyScope(action,expectedIds,expectedPeople){
  const before=scopePosts;
  const [response]=await Promise.all([
   page.waitForResponse(response=>isScopePost(response.request()),{timeout:90000}),
   action(),
  ]);
  assert(response.ok(),'Company selection request failed');
  const request=response.request(),headers=request.headers(),type=headers['content-type'],body=request.postDataBuffer();
  assert(headers['next-action']&&type?.startsWith('multipart/form-data')&&body,'Company selection did not post the native form');
  const form=await new Request(request.url(),{method:'POST',headers:{'content-type':type},body}).formData();
  // React's Flight encoding prefixes each field in the FormData argument with its part number.
  const submittedIds=[...form].filter(([name])=>/^_\d+_companyId$/.test(name)).map(([,value])=>value).sort();
  assert.deepEqual(submittedIds,expectedIds,'Company selection posted a different scope');
  await ready(expectedPeople);
  assert.equal(scopePosts,before+1,'Company selection did not post exactly once');
  assert.equal(await explorer().getAttribute('data-org-view'),'roots','Company change retained the previous Org Explorer state');
  if(await picker.getAttribute('aria-expanded')==='true')await picker.click();
 }
 try{
  const started=performance.now();await page.goto(orgOrigin+'/org',{waitUntil:'domcontentloaded',timeout:90000});
  assert.equal(new URL(page.url()).pathname,'/org');await page.getByRole('heading',{level:1,name:catalog('en').org.title,exact:true}).waitFor({timeout:90000});
  const skip=page.getByRole('dialog').getByRole('button',{name:'Skip',exact:true});if(await skip.isVisible())await skip.click();
  await page.locator('[data-org-tree] [data-org-node]').first().waitFor({state:'visible',timeout:90000});
  record('dated-chart-to-usable',started,{mode:'dated-chart'});
  stage='open-explorer';
  const explorerStarted=performance.now();
  await page.getByRole('link',{name:catalog('en').org.explorer.explore,exact:true}).click();
  await page.waitForURL(url=>url.pathname==='/org'&&url.searchParams.get('view')==='explorer',{timeout:90000});
  await ready(cohort.length);assert.equal(await explorer().getAttribute('data-org-view'),'roots');record('navigation-to-usable',explorerStarted,{mode:'explorer',renderedRows:await rows().count(),totalPeople:cohort.length});
  stage='all-people-first-page';const first=await allPeople();assert.equal(first.totalItems,cohort.length);assert.equal(first.items.length,50);assert(first.nextCursor);
  stage='all-people-next-page';const next=await request(()=>button('next').click(),'search',cohort,'');
  assert(first.items.every(item=>!next.items.some(other=>other.key===item.key)),'Org paging repeated an item');
  stage='focus-and-reports';let person=next.items.find(item=>item.node&&known.get(item.node.employmentId)?.role==='manager')?.node;assert(person);
  const children=await request(()=>rows().filter({has:page.getByRole('heading',{name:person.name,exact:true})}).getByRole('button',{name:catalog(locale).org.explorer.explore,exact:true}).click(),'children');
  assert.equal(children.focus?.employmentId,person.employmentId);assert(await explorer().getByRole('link',{name:catalog(locale).org.explorer.profile,exact:true}).getAttribute('href')===`/personnel/${person.employmentId}?from=org`);
  assert.equal(children.totalItems,10,'Fixture manager direct reports missing');
  const managerId=person.employmentId;person=children.items[0].node;assert(person);
  stage='report-focus';await request(()=>rows().filter({has:page.getByRole('heading',{name:person.name,exact:true})}).getByRole('button',{name:catalog(locale).org.explorer.explore,exact:true}).click(),'children');
  stage='manager-navigation';const parents=await request(()=>button('managers').click(),'parents');assert.equal(parents.focus?.employmentId,person.employmentId);assert.equal(parents.totalItems,1);assert.equal(parents.items[0].node?.employmentId,managerId);
  stage='typed-connections';const connections=await request(()=>button('connections').click(),'connections');assert.equal(connections.focus?.employmentId,person.employmentId);
  assert.equal(connections.totalItems,1);assert.equal(connections.items[0].otherEmploymentId,managerId);assert.equal(connections.items[0].direction,'incoming');
  entry.connectorTypesObserved=[...new Set(connections.items.map(item=>item.type))];
  for(const item of connections.items){assert(['administrative','functional','project','dotted'].includes(item.type));assert(['incoming','outgoing'].includes(item.direction));}
  stage='literal-person-search';const searchBox=explorer().getByRole('textbox');await searchBox.fill(person.name);
  const match=await request(()=>button('search').click(),'search',cohort,person.name);assert.equal(match.totalItems,1);assert.equal(match.items[0].node?.employmentId,person.employmentId);
  if(phase==='baseline'&&rewardMember){
   stage='rewards-member-search';await searchBox.fill(rewardMember.name);
   const reward=await request(()=>button('search').click(),'search',cohort,rewardMember.name);
   assert(reward.totalItems===1&&reward.items.length===1&&reward.items[0].node?.employmentId===rewardMember.employmentId,
    'Org Explorer did not return the exact Rewards member');
   await rows().getByRole('heading',{name:rewardMember.name,exact:true}).waitFor({state:'visible',timeout:90000});
  }
  stage='selected-company';const selected=cohort.filter(actor=>actor.companyId===user.companyId);
  const scopeCopy=catalog(locale).topbar,scopeForm=await openCompanyScope();
  const checkedIds=form=>form.locator(companyInputs+':checked').evaluateAll(inputs=>inputs.map(input=>input.value).sort());
  assert.deepEqual(await checkedIds(scopeForm),companyIds,'Company selector initial scope differs from the fixture');
  page.on('request',observeScopePost);
  await scopeForm.getByRole('button',{name:scopeCopy.chooseCompanies,exact:true}).click();
  await scopeForm.getByRole('status').filter({hasText:scopeCopy.pendingCompanySelection}).waitFor({state:'visible',timeout:90000});
  assert.deepEqual(await checkedIds(scopeForm),[],'Company selector did not clear the draft');
  assert(await picker.getByText(scopeCopy.allCompanies,{exact:true}).isVisible(),'Clearing draft changed the committed company label');
  await ready(cohort.length);
  assert.equal(await explorer().getAttribute('data-org-view'),'search','Clearing draft changed the committed Org Explorer view');
  assert.equal(scopePosts,0,'Clearing company draft sent a scope request');
  const scopedStarted=performance.now();
  await commitCompanyScope(()=>scopeForm.locator(`${companyInputs}[value="${user.companyId}"]`).check(),[user.companyId],selected.length);
  record(stage,scopedStarted,{mode:'explorer',totalPeople:selected.length,stateReset:true});
  stage='selected-company-people';const scoped=await allPeople(selected);assert.equal(scoped.totalItems,selected.length);assert.equal(scoped.nextCursor,null);assert.equal(scoped.items.length,selected.length);
  stage='other-company-search';const other=cohort.find(actor=>actor.companyId!==user.companyId);assert(other);await searchBox.fill(other.name);
  const hidden=await request(()=>button('search').click(),'search',selected,other.name);assert.equal(hidden.totalItems,0);assert.equal(hidden.items.length,0);
  if(phase==='baseline'&&rewardMember&&rewardMember.companyId!==user.companyId){
   stage='rewards-member-outside-company';await searchBox.fill(rewardMember.name);
   const hiddenReward=await request(()=>button('search').click(),'search',selected,rewardMember.name);
   assert(hiddenReward.totalItems===0&&hiddenReward.items.length===0,
    'Org Explorer returned a Rewards member outside the selected company');
  }
  stage='restore-all-companies';const restoreForm=await openCompanyScope();
  assert.deepEqual(await checkedIds(restoreForm),[user.companyId],'Company selector did not retain the committed scope');
  await commitCompanyScope(()=>restoreForm.getByRole('button',{name:scopeCopy.selectAll,exact:true}).click(),companyIds,cohort.length);
  assert(await picker.getByText(scopeCopy.allCompanies,{exact:true}).isVisible(),'Company selector did not restore the committed company label');
  assert.equal(scopePosts,2,'Company scope journey must submit only the select and restore actions');
  page.off('request',observeScopePost);
  stage='language-switch';await switchLocale('zh');await switchLocale('en');
  stage='translated-search-usable';await allPeople();
  await page.screenshot({path:join(process.env.PERF_EVIDENCE_DIR,`org-explorer-${phase}-${user.index}.png`),fullPage:false});
  entry.status='passed';entry.coverage={readOnly:true,freshNativeAuthorization:true,boundedDom:true,search:true,paging:true,focus:true,connections:true,scope:true,locale:true};save();
 }catch(error){entry.status='failed';entry.failure={stage,error:String(error.message).slice(0,200)};save();throw error;}
 finally{page.off('request',observeScopePost);}
}
