/** @vitest-environment jsdom */
/** Authored UNRUN. Presentation/POST boundaries only, not native authority or promotion proof. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
const copyState=vi.hoisted(()=>({locale:null as string|null}));
const copies:Record<string,typeof en>={en,ms,zh,ta,th,vi:viCopy};
vi.mock('next-intl/server',()=>({getTranslations:vi.fn(async(namespace:string)=>(key:string,values?:Record<string,unknown>)=>{if(copyState.locale===null)return namespace+'.'+key+(values?' '+JSON.stringify(values):'');let value:unknown=copies[copyState.locale];for(const part of [...namespace.split('.'),...key.split('.')])value=(value as Record<string,unknown>)[part];if(typeof value!=='string')throw Error('Missing actual specialist translation');return value.replace(/\{(\w+)\}/g,(_all,name:string)=>String(values?.[name]??'{'+name+'}'));})}));
vi.mock('../app/(app)/assistant/specialist-review-actions',()=>({createSpecialistCandidateAction:vi.fn(),evaluateSpecialistCandidateAction:vi.fn(),promoteSpecialistCandidateAction:vi.fn(),rollbackSpecialistCandidateAction:vi.fn(),runSpecialistJobAction:vi.fn()}));
import {ModuleSpecialistFindings} from '../components/assistant/module-specialist-findings';
import {executeCanonicalSpecialist} from '../lib/ai/module-specialists';
import {ModuleSpecialistReview,SpecialistJobComposer} from '../components/assistant/module-specialist-review';
beforeEach(()=>{copyState.locale=null;});afterEach(cleanup);
function view(){return{modules:[{module:'leave' as const,nextVersion:3}],candidates:[
 {id:'own',module:'leave' as const,version:1,playbook:'canonical_domain_v1' as const,own:true,evaluations:2,passingEvaluators:2,incompleteEvaluators:0,personalSignals:false as boolean|null},
 {id:'missing-domain',module:'leave' as const,version:2,playbook:'canonical_followup_v1' as const,own:false,evaluations:2,passingEvaluators:0,incompleteEvaluators:2,personalSignals:false as boolean|null},
 {id:'independently-passed',module:'leave' as const,version:3,playbook:'canonical_followup_v1' as const,own:false,evaluations:2,passingEvaluators:2,incompleteEvaluators:0,personalSignals:false as boolean|null}],
 companies:[{id:'company-a',name:'Fictional Alpha Sdn Bhd'},{id:'company-b',name:'Fictional Beta Sdn Bhd'}],
 promotions:[],ownNativeSignalChoices:[{associationId:'own-completed-link',module:'leave' as const,action:'leave.apply' as const,semantics:'submitted_not_approved',createdAt:'2026-01-01'}],nativeSignalChoicesTruncated:false,ownSignalChoices:[{id:'own-verified-signal',module:'leave' as const,outcome:'needs_correction' as const,createdAt:'2026-01-01'}],signalChoicesTruncated:true};}
describe('specialist human governance presentation',()=>{
 it('labels the picker with the NEXT candidate version and each saved row with its OWN candidate version',async()=>{
  const{container}=render(await ModuleSpecialistReview({view:view()}));const module='assistant.workspace.jobs.module_leave';
  const picker=container.querySelector<HTMLSelectElement>('select[name="moduleVersion"]')!;
  expect(Array.from(picker.options).map(option=>option.textContent)).toEqual(['assistant.workspace.specialists.nextRecord '+JSON.stringify({module,version:3})]);
  expect(picker.value).toBe('leave:3');
  for(const version of [1,2,3])expect(screen.getAllByText((_text,node)=>node?.tagName==='P'&&node.textContent?.startsWith('assistant.workspace.specialists.record '+JSON.stringify({module,version}))===true)).toHaveLength(1);
 });
 it('keeps own candidates out of independent evaluation and incomplete candidates out of promotion',async()=>{
  const{container}=render(await ModuleSpecialistReview({view:view()}));
  const selects=container.querySelectorAll<HTMLSelectElement>('select[name="candidateId"]');expect(selects).toHaveLength(2);
  expect(Array.from(selects[0].options).map(option=>option.value)).toEqual(['missing-domain','independently-passed']);
  expect(Array.from(selects[1].options).map(option=>option.value)).toEqual(['independently-passed']);
  const evaluation=selects[0].closest('form')!;expect(within(evaluation).getByRole('checkbox')).toBeRequired();expect(within(evaluation).getByRole('checkbox')).not.toBeChecked();
  expect(container.querySelector('input[name="maxJobs"]')).toHaveAttribute('max','100');expect(container.querySelector('input[name="hours"]')).toHaveAttribute('max','24');
 });
 it('offers optional own feedback selection without rendering ratings as correctness evidence',async()=>{
  const{container}=render(await ModuleSpecialistReview({view:view()}));
  const signal=container.querySelector<HTMLInputElement>('input[name="signalId"]')!;expect(signal.value).toBe('own-verified-signal');expect(signal.checked).toBe(false);expect(signal.required).toBe(false);
  expect(screen.getByText('assistant.workspace.specialists.signalsConsent')).toBeInTheDocument();
  expect(screen.getByText('assistant.workspace.specialists.signalsTruncated')).toBeInTheDocument();
  expect(container.querySelector('[name="qualityScore"]')).toBeNull();expect(container.querySelector('[name="securityFailures"]')).toBeNull();
 });
 it('uses a separate explicit human POST and nonce rather than consuming a permit through a GET link',async()=>{
  const{container}=render(await SpecialistJobComposer({modules:['leave','claims']}));
  const select=screen.getByRole('combobox');expect(Array.from((select as HTMLSelectElement).options).map(option=>option.value)).toEqual(['','leave','claims']);
  expect(container.querySelector<HTMLInputElement>('input[name="commandNonce"]')?.value).toMatch(/^[a-f0-9-]{36}$/i);
  expect(container.querySelector('a')).toBeNull();expect(container.querySelector('input[name="employmentId"]')).toBeNull();expect(container.querySelector('input[name="execute"]')).toBeNull();
 });
 it('does not offer specialist execution when no module is available',async()=>{
  render(await SpecialistJobComposer({modules:[]}));expect(screen.getByRole('button')).toBeDisabled();
 });
 it('shows unavailable evaluation evidence as unknown rather than zero or a promotion pass',async()=>{
  const v={...view(),candidates:view().candidates.map(row=>({...row,evaluations:null,passingEvaluators:null,incompleteEvaluators:null}))};
  const{container}=render(await ModuleSpecialistReview({view:v}));expect(screen.getAllByText('assistant.workspace.specialists.evaluationsUnknown')).toHaveLength(3);
  expect(container.querySelectorAll('select[name="candidateId"]')).toHaveLength(1);expect(screen.queryByText(/specialists\.passing/)).toBeNull();
 });
 it('requires an explicit closed behavior choice instead of a version-only candidate',async()=>{
  const{container}=render(await ModuleSpecialistReview({view:view()}));const select=container.querySelector<HTMLSelectElement>('select[name="playbook"]')!;
  expect(select.required).toBe(true);expect(select.value).toBe('canonical_domain_v1');expect(Array.from(select.options).map(row=>row.value)).toEqual(['canonical_domain_v1','canonical_followup_v1']);expect(container.querySelector('[name="prompt"]')).toBeNull();
 });
 it('renders the actual diagnostic decision in the current consumer while retaining domain warnings',async()=>{
  const assessment=executeCanonicalSpecialist({kind:'canonical_specialist_v1',module:'claims',playbook:'canonical_followup_v1'},{module:'claims',scope:'current-caller',capability:'own_claim_statuses',data:{hasEmployment:true,claims:[{status:'paid',paidAt:'2026-01-02'}],truncated:false}});
  render(await ModuleSpecialistFindings({assessment}));expect(screen.getByText('assistant.workspace.specialists.diagnosticState_recorded')).toBeInTheDocument();expect(within(screen.getByRole('region',{name:'assistant.workspace.specialists.diagnosticTitle'})).getByText('assistant.workspace.specialistFindings.claim_payment_recorded')).toBeInTheDocument();expect(screen.queryByRole('link')).toBeNull();expect(screen.queryByRole('button')).toBeNull();
 });

 it('keeps two completed baseline evaluations visible while offering no promotion for missing behavior benefit',async()=>{
  const v={...view(),candidates:view().candidates.map(row=>({...row,playbook:'canonical_domain_v1' as const,evaluations:2,passingEvaluators:0,incompleteEvaluators:0}))};const{container}=render(await ModuleSpecialistReview({view:v}));
  expect(container.querySelectorAll('select[name="candidateId"]')).toHaveLength(1);expect(container.querySelector('input[name="maxJobs"]')).toBeNull();expect(screen.queryByRole('button',{name:'assistant.workspace.specialists.promote'})).toBeNull();
 });

});

// Authored UNRUN: native choices nominate historical evidence, never pre-consent a quality rating.
it('defaults native candidate evidence to none and never posts an event, receipt or rating',async()=>{
 const {container}=render(await ModuleSpecialistReview({view:view()}));const select=container.querySelector<HTMLSelectElement>('select[name="nativeSignalId"]')!;
 expect(select.value).toBe('');expect(select.required).toBe(false);expect(Array.from(select.options).map(row=>row.value)).toEqual(['','own-completed-link']);
 for(const name of ['eventId','receipt','quality','causalCredit'])expect(container.querySelector(`[name="${name}"]`)).toBeNull();
});

// WP11 (R5): the approver chooses the promotion scope; companyId is posted only for company scope.
describe('promotion scope chosen by the approver',()=>{
 const promoteForm=(container:HTMLElement)=>container.querySelector<HTMLInputElement>('input[name="maxJobs"]')!.closest('form')!;
 it('renders three scope radios with the owner default, a company select only for company scope, and posts scope/companyId',async()=>{
  const{container}=render(await ModuleSpecialistReview({view:view()}));const form=promoteForm(container);
  const radios=Array.from(form.querySelectorAll<HTMLInputElement>('input[type="radio"][name="scope"]'));
  expect(radios.map(row=>row.value)).toEqual(['user','company','tenant']);expect(radios.map(row=>row.checked)).toEqual([true,false,false]);expect(radios.every(row=>!row.disabled)).toBe(true);
  expect(within(form).getByText('assistant.workspace.specialists.scopeLegend')).toBeInTheDocument();
  for(const key of ['scopeUser','scopeCompany','scopeTenant','scopeHint'])expect(within(form).getByText('assistant.workspace.specialists.'+key)).toBeInTheDocument();
  expect(form.querySelector('select[name="companyId"]')).toBeNull();
  let posted=new FormData(form);expect(posted.get('scope')).toBe('user');expect(posted.has('companyId')).toBe(false);
  fireEvent.click(radios[1]);
  const company=form.querySelector<HTMLSelectElement>('select[name="companyId"]')!;expect(company).not.toBeNull();
  expect(Array.from(company.options).map(row=>[row.value,row.textContent])).toEqual([['company-a','Fictional Alpha Sdn Bhd'],['company-b','Fictional Beta Sdn Bhd']]);
  fireEvent.change(company,{target:{value:'company-b'}});
  posted=new FormData(form);expect(posted.get('scope')).toBe('company');expect(posted.get('companyId')).toBe('company-b');expect(posted.get('candidateId')).toBe('independently-passed');
  fireEvent.click(radios[2]);
  expect(form.querySelector('select[name="companyId"]')).toBeNull();posted=new FormData(form);expect(posted.get('scope')).toBe('tenant');expect(posted.has('companyId')).toBe(false);
  expect(within(form).queryByText('assistant.workspace.specialists.scopeSignalsOnly')).toBeNull();
 });
 it('keeps a candidate with personal signals owner-only and says why',async()=>{
  const v={...view(),candidates:view().candidates.map(row=>row.id==='independently-passed'?{...row,personalSignals:true}:row)};
  const{container}=render(await ModuleSpecialistReview({view:v}));const form=promoteForm(container);
  const radios=Array.from(form.querySelectorAll<HTMLInputElement>('input[type="radio"][name="scope"]'));
  expect(radios.map(row=>row.disabled)).toEqual([false,true,true]);expect(radios[0].checked).toBe(true);
  expect(within(form).getByText('assistant.workspace.specialists.scopeSignalsOnly')).toBeInTheDocument();
  expect(new FormData(form).get('scope')).toBe('user');
 });
});

it.each(['en','ms','zh','ta','th','vi'])('%s shows entity-specific native evidence and real promotion scope controls',async locale=>{
 copyState.locale=locale;const data:Parameters<typeof ModuleSpecialistReview>[0]['view']={...view(),modules:[{module:'employees',nextVersion:3}],candidates:view().candidates.map(row=>({...row,module:'employees' as const})),ownNativeSignalChoices:[{associationId:'20000000-0000-4000-8000-000000000004',module:'employees',action:'employees.draft.discard',semantics:'saved_draft_deleted_not_employee',createdAt:'2026-01-01'}]};
 const {container}=render(await ModuleSpecialistReview({view:data}));const copy=copies[locale].assistant.workspace,picker=container.querySelector<HTMLSelectElement>('select[name="nativeSignalId"]')!;
 expect(picker).toBeTruthy();expect([...picker.options].map(option=>option.value)).toEqual(['','20000000-0000-4000-8000-000000000004']);expect(picker.value).toBe('');expect(picker.textContent).toContain(copy.nativeOutcomes.action_employees_draft_discard);
 for(const key of ['scopeLegend','scopeUser','scopeCompany','scopeTenant','scopeHint'] as const)expect(container.textContent).toContain(copy.specialists[key]);
 const company=container.querySelector<HTMLInputElement>('input[name="scope"][value="company"]')!;expect(company).not.toBeDisabled();fireEvent.click(company);expect(container.textContent).toContain(copy.specialists.scopeCompanyChoice);expect(container.querySelector('select[name="companyId"]')).toBeRequired();
 cleanup();data.candidates=data.candidates.map(row=>({...row,personalSignals:true}));const second=render(await ModuleSpecialistReview({view:data}));expect(second.container.textContent).toContain(copy.specialists.scopeSignalsOnly);expect(second.container.querySelector('input[name="scope"][value="company"]')).toBeDisabled();expect(second.container.querySelector('input[name="scope"][value="tenant"]')).toBeDisabled();
 expect(second.container.querySelector('[name="personId"],[name="employeeId"],[name="salary"]')).toBeNull();expect(second.container.textContent).not.toMatch(/action_employees_draft_discard|assistant\.workspace/);
});
