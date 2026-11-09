/** Content checks on the already-owned native preflight Page. Fixture facts confer no authority. */
import assert from 'node:assert/strict';
import type {Locator,Page} from 'playwright';
import {todayInKualaLumpur} from '../../lib/hr-date';

type FixtureFacts=Readonly<{
 actorIndex:number;
 actorName:string;
 seedToday:string;
 historicalPayrollMonth:string;
 peerName:string;
 foreignName:string;
 companyIds:readonly string[];
}>;
type Remaining=()=>number;
const uuid='[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
const companyIdPattern=new RegExp('^'+uuid+'$');
const ownPayslipPathPattern=new RegExp('^/me/payslip/'+uuid+'/pdf$');

export function requireNativePreflightFixtureDay(witness:string|null,seedToday:string,now?:Date){
 if(witness==='own-annual-leave-controls'||witness==='own-individual-attendance-picker'){
  assert(todayInKualaLumpur(now)===seedToday,'Native preflight fixture day differs from the current Kuala Lumpur day');
 }
}

export function isNativeOwnPayslipPdfPath(href:string|null){
 return href!==null&&ownPayslipPathPattern.test(href);
}

async function visible(locator:Locator,remaining:Remaining){
 await locator.waitFor({state:'visible',timeout:remaining()});
}

async function enabled(locator:Locator,remaining:Remaining){
 await visible(locator,remaining);
 assert(await locator.isEnabled({timeout:remaining()}),'Native preflight control is unavailable');
}

async function excludeOtherPeople(scope:Locator,facts:FixtureFacts,remaining:Remaining){
 const text=await scope.innerText({timeout:remaining()});
 assert(!text.includes(facts.peerName)&&!text.includes(facts.foreignName),'Native preflight displayed another person');
}

function requireEmployeeFacts(facts:FixtureFacts){
 assert(facts.actorIndex===4&&facts.actorName==='PERF Person 0004'&&facts.peerName==='PERF Person 0005'
  &&facts.foreignName==='PERF Person 0254','Native preflight employee fixture differs');
}

async function verifyRewardsSharedDraftGrids(page:Page,main:Locator,remaining:Remaining){
 const draft=main.locator('form:has(input[name="groupId"][value=""])');
 await enabled(draft.locator('input[name="name"]'),remaining);
 assert.equal(await draft.locator('[data-reward-policy-grid]').count(),2,'Native Rewards draft grid count differs');
 // The custom validity ref is set by the mounted client. Reading validity does
 // not dispatch the invalid event that would turn guidance into an alert.
 await page.waitForFunction(()=>['ranges','bonusMatrix'].every(kind=>{
  const cell=document.querySelector<HTMLInputElement>(`main [data-reward-policy-grid="${kind}"] input[type="number"][aria-invalid="true"]`);
  return cell?.validity.customError===true;
 }),undefined,{timeout:remaining()});
 for(const [kind,controls,missing]of [['ranges',36,36],['bonusMatrix',65,5]]as const){
  const grid=draft.locator(`[data-reward-policy-grid="${kind}"]`);
  await visible(grid,remaining);
  await visible(grid.locator(`ul#${kind}-errors[role="status"]`),remaining);
  const actual=await grid.evaluate((section,kind)=>{
   const guidance=section.querySelector(`ul#${kind}-errors[role="status"]`);
   const cells=Array.from(section.querySelectorAll<HTMLInputElement>('input[type="number"]'));
   const invalid=cells.filter(cell=>cell.getAttribute('aria-invalid')==='true');
   return {controls:cells.length,missing:invalid.length,issues:guidance?.children.length??0,
    valid:cells.every(cell=>cell.required&&!cell.matches(':disabled')&&cell.getAttribute('aria-invalid')===String(!cell.validity.valid)),
    described:invalid.every(cell=>{
     const id=cell.getAttribute('aria-describedby');
     const text=id?document.getElementById(id):null;
     return cell.value===''&&cell.validity.valueMissing&&cell.validity.customError&&!!text?.textContent?.trim()&&guidance?.contains(text)===true;
    })};
  },kind,{timeout:remaining()});
  assert.deepEqual(actual,{controls,missing,issues:missing,valid:true,described:true},'Native Rewards draft validation differs');
 }
}

export async function verifyNativePreflightContent(page:Page,witness:string,facts:FixtureFacts,remaining:Remaining){
 const main=page.locator('main:visible');
 try{
  switch(witness){
   case 'own-released-payslip': {
    requireEmployeeFacts(facts);
    assert(/^\d{4}-(?:0[1-9]|1[0-2])$/.test(facts.historicalPayrollMonth),'Native historical month missing');
    const month=new Intl.DateTimeFormat('en',{month:'long',year:'numeric',timeZone:'UTC'})
     .format(new Date(facts.historicalPayrollMonth+'-01T00:00:00Z'));
    const link=main.getByRole('link',{name:'Download PDF',exact:true});
    await enabled(link,remaining);
    assert(isNativeOwnPayslipPdfPath(await link.getAttribute('href',{timeout:remaining()})),'Native own payslip link differs');
    await visible(main.getByText('PERF0004 · '+facts.actorName,{exact:true}),remaining);
    await visible(main.locator('p:visible').and(main.getByText(month,{exact:true})),remaining);
    const basic=main.getByText('Basic salary',{exact:true}).locator('..');
    await visible(basic.getByText('MYR 5,000.00',{exact:true}),remaining);
    await excludeOtherPeople(main,facts,remaining);
    break;
   }
   case 'own-annual-leave-controls': {
    requireEmployeeFacts(facts);
    const card=main.locator('article:is([data-testid="leave-ring-card"],[data-testid="leave-type-card"])[aria-label="Annual Leave"]');
    await visible(card,remaining);
    const year=main.locator('select#leave-year');
    await enabled(year,remaining);
    assert(await year.inputValue({timeout:remaining()})===facts.seedToday.slice(0,4),'Native own leave year differs');
    await enabled(main.locator('button[data-tour="leave-request"]'),remaining);
    assert(await main.evaluate(root=>!root.querySelector('select[name="employmentId"]'),undefined,{timeout:remaining()}),
     'Native own leave exposes a subject selector');
    await excludeOtherPeople(card,facts,remaining);
    break;
   }
   case 'own-individual-attendance-picker': {
    requireEmployeeFacts(facts);
    await enabled(main.locator('input[type="search"]:visible'),remaining);
    const subject=main.locator('button[aria-busy]:visible').filter({has:page.getByText(facts.actorName,{exact:true})});
    await enabled(subject,remaining);
    await visible(subject.getByText('PERF0004',{exact:true}),remaining);
    const from=main.locator('input[type="date"][name="from"]'),to=main.locator('input[type="date"][name="to"]');
    await enabled(from,remaining);await enabled(to,remaining);
    assert(await from.inputValue({timeout:remaining()})===facts.seedToday.slice(0,7)+'-01'
     &&await to.inputValue({timeout:remaining()})===facts.seedToday,'Native own attendance dates differ');
    await visible(main.getByText('Select an employee to view their attendance history.',{exact:true}),remaining);
    await excludeOtherPeople(main,facts,remaining);
    break;
   }
   case 'ai-runs-group-history-controls': {
    assert(facts.actorIndex===0,'Native group runs fixture differs');
    const history=main.locator('#ai-runs'),form=history.locator('form');
    for(const selector of ['input[name="from"]','input[name="to"]','select[name="runs"]','select[name="feature"]','button[type="submit"]']){
     await enabled(form.locator(selector),remaining);
    }
    await visible(history.getByText('No model calls recorded yet.',{exact:true}),remaining);
    break;
   }
   case 'ai-runs-company-scope': {
    assert(facts.actorIndex===1,'Native company runs fixture differs');
    const history=main.locator('#ai-runs');
    await visible(history.getByText('Company totals appear above. Detailed run history is available to group administrators.',{exact:true}),remaining);
    assert(await history.evaluate(root=>!root.querySelector('form,table'),undefined,{timeout:remaining()}),
     'Native company runs exposes private history');
    break;
   }
   case 'rewards-shared-company-scope': {
    assert(facts.actorIndex===0&&Array.isArray(facts.companyIds)&&facts.companyIds.length===5
     &&new Set(facts.companyIds).size===5&&facts.companyIds.every(id=>companyIdPattern.test(id)),'Native Rewards company fixture differs');
    await verifyRewardsSharedDraftGrids(page,main,remaining);
    const review=main.getByRole('button',{name:'Review company designation',exact:true})
     .and(main.locator('button[data-reward-classification-ready="true"]'));
    await enabled(review,remaining);
    await review.click({timeout:remaining()});
    const form=main.locator('form:has(select[name="disposition"]):has(textarea[name="reason"])');
    const company=form.locator('select[name="companyId"]');
    await enabled(company,remaining);
    const options=await company.evaluate(select=>Array.from(select.querySelectorAll('option'),option=>option.value),undefined,{timeout:remaining()});
    assert(options.length===5&&new Set(options).size===5&&options.every(id=>facts.companyIds.includes(id)),'Native Rewards company scope differs');
    await form.getByRole('button',{name:'Cancel',exact:true}).click({timeout:remaining()});
    await form.waitFor({state:'hidden',timeout:remaining()});
    break;
   }
   case 'rewards-shared-draft-grids': {
    assert(facts.actorIndex===1,'Native company Rewards fixture differs');
    await verifyRewardsSharedDraftGrids(page,main,remaining);
    break;
   }
   case 'own-profile-identity': {
    requireEmployeeFacts(facts);
    const name=main.getByRole('heading',{level:2,name:facts.actorName,exact:true});
    await visible(name,remaining);
    const card=name.locator('..');
    await visible(card.getByText('PERF0004',{exact:true}),remaining);
    await visible(card.getByText('Acme Sdn Bhd',{exact:true}),remaining);
    await visible(card.getByText(/^Finance · /),remaining);
    await excludeOtherPeople(card,facts,remaining);
    break;
   }
   default: throw new Error('Unknown native preflight content witness');
  }
  remaining();
  return witness;
 }catch(error){
  // A Playwright locator diagnostic may contain a fixture identity. Keep the closed witness and failure kind.
  const refusal=new Error('Native preflight content witness refused');
  if(error instanceof Error&&error.name==='TimeoutError')refusal.name='TimeoutError';
  throw refusal;
 }
}
