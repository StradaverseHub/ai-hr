import React,{useState} from 'react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import zh from '../messages/zh.json';
import type {OvertimePattern,OvertimeCondition,OvertimeExpression} from '../lib/overtime-pattern-model';
import type {OvertimePatternDetail,OvertimePatternSetup} from '../packs/attendance/service';

const mocks=vi.hoisted(()=>({save:vi.fn(),fork:vi.fn(),validate:vi.fn(),activate:vi.fn(),stop:vi.fn(),archive:vi.fn(),assign:vi.fn(),close:vi.fn(),choices:vi.fn(),previewEmployee:vi.fn(),previewSample:vi.fn(),readTransfer:vi.fn(),calculate:vi.fn(),transfer:vi.fn(),push:vi.fn(),replace:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({usePathname:()=>'/admin/attendance/settings/overtime-patterns',useRouter:()=>({push:mocks.push,replace:mocks.replace,refresh:mocks.refresh})}));
vi.mock('../app/(app)/admin/attendance/settings/overtime-patterns/actions',()=>({saveOvertimeDraftAction:mocks.save,forkOvertimeDraftAction:mocks.fork,validateOvertimeAction:mocks.validate,activateOvertimeAction:mocks.activate,stopOvertimeAction:mocks.stop,archiveOvertimeAction:mocks.archive,saveOvertimeAssignmentAction:mocks.assign,closeOvertimeAssignmentAction:mocks.close,overtimeChoicesAction:mocks.choices,previewOvertimeEmployeeAction:mocks.previewEmployee,previewOvertimeSampleAction:mocks.previewSample,readOvertimeTransferAction:mocks.readTransfer,calculateOvertimeDayAction:mocks.calculate,transferOvertimePayrollAction:mocks.transfer}));
import {OVERTIME_WORKSPACE_SECTIONS,OvertimeWorkspace} from '../components/overtime-patterns/workspace';
import {ConditionControl,ExpressionControl} from '../components/overtime-patterns/rule-controls';
import {overtimeMoneyText,OvertimeCalculationResult} from '../components/overtime-patterns/calculation-result';
import {overtimeStarterSeed} from '../lib/overtime-pattern-starters';
import {todayInKualaLumpur} from '../lib/hr-date';
import {__resetUnsavedGuards} from '../lib/unsaved-changes';

const companyId='00000000-0000-4000-8000-000000000001';
const patternId='00000000-0000-4000-8000-000000000002';
const versionId='00000000-0000-4000-8000-000000000003';
const employeeId='00000000-0000-4000-8000-000000000004';
const pattern:OvertimePattern={v:1,currency:{code:'MYR',minorScale:2},eligibilityBasis:'day',durationAllocation:'earliest',definitions:[],eligibility:{id:'eligibility',type:'constant',value:true},eligibleMinutes:null,durationCap:null,durationRounding:null,deductions:[],rates:[{id:'fixture_rate',name:'Configured rate',description:'',priority:0,when:{id:'fixture_when',type:'constant',value:true},timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[{id:'fixture_tier',from:'0',to:null,payment:{method:'hourly',rate:{id:'fixture_hourly',type:'literal',unit:'moneyPerHour',value:'12',currency:'MYR'},multiplier:{id:'fixture_mult',type:'literal',unit:'scalar',value:'1.5'}},mapping:{earningItemId:'00000000-0000-4000-8000-000000000099',currency:'MYR'}}]}],paymentCap:null,moneyRounding:{stage:'line',mode:'halfUp'}};
const setup:OvertimePatternSetup={companies:[{id:companyId,name:'Fictional Company',currency:'MYR',minorScale:2}],employees:[{id:employeeId,companyId,name:'Fictional Employee',employeeCode:'SYNTH-01'}],employeeNextCursor:null,earningItems:[],choices:{companyId:[{id:companyId,label:'Fictional Company'}]},readerLimitations:[]};
function detail(activated=false):OvertimePatternDetail {
 const createdAt=new Date();
 return {pattern:{id:patternId,tenantId:companyId,kind:'formula',code:'SYNTH-OT',creationCompanyId:companyId,legacyRuleRef:null,legacyRuleId:null,revision:3,archivedAt:null,createdAt},versions:[{id:versionId,tenantId:companyId,patternId,kind:'formula',creationCompanyId:companyId,ordinal:1,revision:7,name:'Fictional Overtime',description:'',definition:{...pattern},digest:'fixture-digest',activatedAt:activated?createdAt:null,activatedBy:null,createdAt,companyIds:[companyId],status:activated?'active':'draft',effectiveFrom:null,states:[]}],assignments:[],writable:true};
}
const catalogues={en,ms,ta,th,vi:viMessages,zh};
function wrap(node:React.ReactNode,locale:keyof typeof catalogues='en') {return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}>{node}</NextIntlClientProvider>);}
function editor(activated=false) {const item=detail(activated);return wrap(<OvertimeWorkspace detail={item} version={item.versions[0]} setup={setup}/>);}
const words=en.overtimePatterns;
function tab(key:typeof OVERTIME_WORKSPACE_SECTIONS[number]) {const label=words.guided[key==='basic'?'general':key];fireEvent.click(screen.getByRole('tab',{name:new RegExp(label)}));return screen.getByRole('tabpanel',{name:new RegExp(label)});}

beforeEach(()=>{cleanup();__resetUnsavedGuards();vi.clearAllMocks();mocks.save.mockResolvedValue({ok:true,value:{patternId,versionId,revision:8}});mocks.fork.mockResolvedValue({ok:true,value:{patternId,versionId,revision:1}});mocks.validate.mockResolvedValue({ok:true,value:{validationDigest:'fresh-digest',issues:[],requiredFields:[]}});mocks.activate.mockResolvedValue({ok:true,value:{versionId}});mocks.assign.mockResolvedValue({ok:true,value:{assignmentId:'assignment'}});mocks.choices.mockResolvedValue({ok:true,value:setup});});

describe('guided Overtime Pattern editing',()=>{
 it.each(['ot15','ot20','ot30','ot00'] as const)('opens %s inside General Settings without a preliminary workflow',key=>{
  wrap(<OvertimeWorkspace detail={null} setup={setup} starterKey={key}/>);
  expect(screen.getAllByRole('tab')).toHaveLength(4);
  expect(screen.getByLabelText(words.guided.patternName)).toHaveValue({ot15:'OT 1.5',ot20:'OT 2.0',ot30:'OT 3.0',ot00:'OT 0.0'}[key]);
  expect(screen.getByLabelText(words.eligibilityBasis)).toHaveValue('');
  expect(screen.getByLabelText(words.durationAllocation)).toHaveValue('');
  fireEvent.click(screen.getByRole('button',{name:words.guided.next}));
  expect(screen.getByText(words.guided.completeGeneral)).toBeVisible();
  const posted=JSON.parse((document.querySelector('input[name="overtimeDraft"]') as HTMLInputElement).value);
  expect(posted.definition.rates[0].tiers[0].payment.multiplier.value).toBe({ot15:'1.5',ot20:'2',ot30:'3',ot00:'0'}[key]);
  expect(mocks.save).not.toHaveBeenCalled();expect(mocks.activate).not.toHaveBeenCalled();
 });
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('translates all four steps and summary in %s',locale=>{
  const errors:unknown[]=[];
  render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={error=>errors.push(error)}><OvertimeWorkspace detail={null} setup={setup}/></NextIntlClientProvider>);
  expect(screen.getAllByRole('tab')).toHaveLength(4);
  for(const key of ['general','rates','eligibility','preview'] as const)expect(screen.getByRole('tab',{name:new RegExp(catalogues[locale].overtimePatterns.guided[key])})).toBeTruthy();
  expect(errors).toEqual([]);
 });
 it('validates each forward step and retains input through Back and Next',()=>{
  editor();fireEvent.change(screen.getByLabelText(words.guided.patternName),{target:{value:'Retained fictional name'}});
  fireEvent.click(screen.getByRole('button',{name:words.guided.next}));
  expect(screen.getByRole('tabpanel',{name:/Overtime Rates/})).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:words.guided.back}));
  expect(screen.getByLabelText(words.guided.patternName)).toHaveValue('Retained fictional name');
  fireEvent.click(screen.getByRole('button',{name:words.guided.next}));
  fireEvent.change(screen.getByLabelText(words.guided.toFor.replace('{row}','1')),{target:{value:'0:00'}});
  fireEvent.click(screen.getByRole('button',{name:words.guided.next}));
  expect(screen.getByRole('tabpanel',{name:/Overtime Rates/})).toBeVisible();
  expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
 });
 it('shows a read-only summary of the draft before saving a validated pattern',async()=>{
  editor();tab('preview');
  const preview=screen.getByRole('tabpanel',{name:/Preview/});
  expect(within(preview).queryByRole('textbox')).toBeNull();expect(within(preview).queryByRole('combobox')).toBeNull();
  expect(within(preview).getByText('Fictional Overtime')).toBeVisible();
  fireEvent.click(within(preview).getByRole('button',{name:words.guided.savePattern}));
  await waitFor(()=>expect(mocks.save).toHaveBeenCalledOnce());
  expect(mocks.save.mock.calls[0][0]).toMatchObject({patternId,versionId,expectedRevision:7});
  expect(mocks.activate).not.toHaveBeenCalled();expect(mocks.assign).not.toHaveBeenCalled();
 });
 it('warns before saving contradictory eligibility while preserving intentional rules',async()=>{
  const item=detail();
  const compare=(operator:'lt'|'gt',value:string):OvertimeCondition=>({id:'bound_'+operator,type:'compare',operator,left:{id:'field_'+operator,type:'field',field:'basicSalary',unit:'money'},right:{id:'amount_'+operator,type:'literal',unit:'money',currency:'MYR',value}});
  const eligibility:OvertimeCondition={id:'contradiction',type:'group',logic:'and',children:[compare('lt','4000'),compare('gt','5000')]};
  item.versions[0].definition={...pattern,eligibility};
  wrap(<OvertimeWorkspace detail={item} version={item.versions[0]} setup={setup}/>);tab('eligibility');
  expect(within(screen.getByRole('tabpanel',{name:/Eligibility/})).getByText(words.guided.contradiction)).toBeVisible();
  tab('preview');const preview=screen.getByRole('tabpanel',{name:/Preview/});
  expect(within(preview).getByText(words.guided.contradiction)).toBeVisible();
  fireEvent.click(within(preview).getByRole('button',{name:words.guided.savePattern}));
  await waitFor(()=>expect(mocks.save).toHaveBeenCalledOnce());
  expect(mocks.save.mock.calls[0][0].draft.definition.eligibility).toEqual(eligibility);
 });
 it('summarizes complete policy scope, recursive amounts, clocks, mappings and saved assignments',()=>{
  const item=detail();const advanced=structuredClone(pattern);
  advanced.definitions=[{id:'salary_base',expression:{id:'base_sum',type:'add',unit:'money',left:{id:'base_literal',type:'literal',unit:'money',currency:'MYR',value:'3700'},right:{id:'extra_literal',type:'literal',unit:'money',currency:'MYR',value:'175'}}}];
  advanced.eligibleMinutes={id:'count',type:'field',unit:'minutes',field:'approvedMinutes'};
  advanced.durationCap={id:'cap',type:'literal',unit:'minutes',value:'240'};
  advanced.paymentCap={id:'money_cap',type:'literal',unit:'money',currency:'MYR',value:'888'};
  advanced.eligibility={id:'clock',type:'clock',boundary:'end',operator:'between',value:{dayOffset:1,minute:60},upper:{dayOffset:2,minute:90}};
  advanced.rates[0].tiers[0].payment={method:'hourly',multiplier:{id:'multiplier',type:'literal',unit:'scalar',value:'1.5'},rate:{id:'rate',type:'hourlyRate',unit:'moneyPerHour',base:{id:'base_ref',type:'ref',unit:'money',definitionId:'salary_base'},divisorMinutes:{id:'divisor',type:'literal',unit:'minutes',value:'10400'}}};
  item.versions[0].definition=advanced;
  item.assignments=[{id:'saved_assignment',versionId,validFrom:'2026-11-01',validTo:'2026-12-01',priority:2,target:{type:'individual',employmentIds:[employeeId]},revision:1,createdAt:new Date('2026-10-29T00:00:00Z'),tenantId:companyId,closeReason:null,createdBy:null,supersededAt:null}];
  wrap(<OvertimeWorkspace detail={item} version={item.versions[0]} setup={{...setup,earningItems:[{id:advanced.rates[0].tiers[0].mapping.earningItemId,label:'Fictional OT earning'}]}}/>);tab('preview');
  const preview=screen.getByRole('tabpanel',{name:/Preview/});
  expect(within(preview).getAllByText('Fictional Company')).toHaveLength(2);
  expect(within(preview).getByText(/3700.*175.*10400/)).toBeVisible();
  expect(within(preview).getAllByText(/Next day 01:00.*Two days later 01:30/)[0]).toBeVisible();
  expect(within(preview).getByText(/Fictional OT earning/)).toBeVisible();
  expect(within(preview).getByText(/Fictional Employee/)).toBeVisible();
  expect(within(preview).getByText(/2026-11-01.*2026-12-01/)).toBeVisible();
  expect(within(preview).getByText('MYR 888')).toBeVisible();
  expect(within(preview).queryByRole('textbox')).toBeNull();
  expect(screen.getByText(words.guided.manageLifecycle).closest('details')).not.toHaveAttribute('open');
 });
 it('shows simple salary field/operator/currency amount controls and preserves advanced formula access',()=>{
  editor();tab('eligibility');fireEvent.click(screen.getByRole('button',{name:words.guided.addSalaryCondition}));
  const panel=screen.getByRole('tabpanel',{name:/Eligibility/});
  expect(within(panel).getByLabelText(`${words.guided.comparisonAmount} · MYR`)).toBeVisible();
  fireEvent.change(within(panel).getByLabelText(`${words.guided.comparisonAmount} · MYR`),{target:{value:'4000'}});
  expect(within(panel).getByRole('heading',{name:words.guided.employeeEligibility})).toBeVisible();
  expect(within(panel).getByRole('heading',{name:words.guided.eligibilityConditions})).toBeVisible();
  const posted=JSON.parse((document.querySelector('input[name="overtimeDraft"]') as HTMLInputElement).value);
  expect(posted.definition.eligibility.children[1].right).toMatchObject({type:'literal',unit:'money',currency:'MYR',value:'4000'});
  expect(within(panel).getByText(words.guided.advancedCondition)).toBeVisible();
 });
 it('exposes named focusable table regions and a current-step label on narrow layouts',()=>{
  editor();tab('rates');
  expect(screen.getByRole('region',{name:'Overtime Rates · Configured rate'})).toHaveAttribute('tabindex','0');
  expect(within(screen.getByRole('tabpanel',{name:/Overtime Rates/})).getByText(words.guided.horizontalScroll)).toBeInTheDocument();
  expect(screen.getByText('Step 2 of 4 · Overtime Rates')).toBeInTheDocument();
  expect(screen.getByRole('tab',{name:/General Settings/}).querySelector('svg path')).not.toBeNull();
 });
 it('keeps pending drafts distinct from Save Pattern and never fabricates a missing value',async()=>{
  editor();tab('rates');
  fireEvent.change(screen.getByLabelText(words.guided.rateFor.replace('{row}','1')),{target:{value:''}});
  fireEvent.click(screen.getByRole('button',{name:words.saveDraft}));
  await waitFor(()=>expect(mocks.save).toHaveBeenCalledOnce());
  expect(mocks.save.mock.calls[0][0].draft.definition.rates[0].tiers[0].payment.multiplier.value).toBe('');
  fireEvent.click(screen.getByRole('button',{name:words.guided.next}));
  expect(screen.getByRole('tabpanel',{name:/Overtime Rates/})).toBeVisible();
 });
 it('supports independent row rounding and hour:minute boundaries without changing zero rates',()=>{
  editor();tab('rates');
  fireEvent.change(screen.getByLabelText(words.guided.rateFor.replace('{row}','1')),{target:{value:'0'}});
  fireEvent.change(screen.getByLabelText(words.guided.roundingFor.replace('{row}','1')),{target:{value:'down'}});
  fireEvent.change(screen.getByLabelText(words.guided.intervalFor.replace('{row}','1')),{target:{value:'0:15'}});
  const posted=JSON.parse((document.querySelector('input[name="overtimeDraft"]') as HTMLInputElement).value);
  expect(posted.definition.rates[0].tiers[0]).toMatchObject({payment:{multiplier:{value:'0'}},rounding:{mode:'down',step:'15'}});
 });
 it('sends one persistence request while pending and retains entered values on a safe error',async()=>{
  let finish!:(result:unknown)=>void;mocks.save.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));editor();
  fireEvent.change(screen.getByLabelText(words.guided.patternName),{target:{value:'Retained draft'}});
  const form=document.getElementById('overtime-definition')!;fireEvent.submit(form);fireEvent.submit(form);
  await waitFor(()=>expect(mocks.save).toHaveBeenCalledOnce());finish({ok:false,code:'system',reference:'OT-1234ABCD'});
  await waitFor(()=>expect(screen.getByText(words.errors.system)).toBeVisible());
  expect(screen.getByLabelText(words.guided.patternName)).toHaveValue('Retained draft');expect(mocks.replace).not.toHaveBeenCalled();
 });
 it('preserves saved activation receipts and invalidates them after an edit',async()=>{
  editor();fireEvent.click(screen.getByRole('button',{name:words.validate}));await waitFor(()=>expect(screen.getByText(words.validated)).toBeVisible());
  const from=todayInKualaLumpur(new Date(Date.now()+86400000));
  fireEvent.change(within(screen.getByRole('group',{name:words.lifecycle})).getByLabelText(words.effectiveFrom),{target:{value:from}});
  fireEvent.click(screen.getByRole('button',{name:words.activate}));
  await waitFor(()=>expect(mocks.activate).toHaveBeenCalledExactlyOnceWith({versionId,expectedRevision:7,validationDigest:'fresh-digest',effectiveFrom:from}));
  fireEvent.change(screen.getByLabelText(words.guided.patternName),{target:{value:'Changed draft'}});
  expect(screen.getByRole('button',{name:words.activate})).toBeDisabled();
 });
 it('makes activated definitions read-only and retains the canonical fork revision',async()=>{
  editor(true);expect(screen.getByLabelText(words.guided.patternName)).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:words.fork}));await waitFor(()=>expect(mocks.fork).toHaveBeenCalledExactlyOnceWith({versionId,expectedPatternRevision:3}));
 });
 it('stores selected employee eligibility in the pattern while retaining its existing conditions',()=>{
  editor();tab('eligibility');fireEvent.click(screen.getByLabelText(words.guided.selectedEmployees));
  const controls=screen.getAllByLabelText(words.values),select=controls[0] as HTMLSelectElement;
  fireEvent.change(select,{target:{value:employeeId}});Array.from(select.options).forEach(option=>option.selected=option.value===employeeId);fireEvent.change(select);
  const draft=JSON.parse((document.querySelector('input[name="overtimeDraft"]') as HTMLInputElement).value);
  expect(draft.definition.eligibility.children).toEqual(expect.arrayContaining([expect.objectContaining({field:'employmentId',values:[employeeId]})]));
  expect(mocks.save).not.toHaveBeenCalled();expect(mocks.assign).not.toHaveBeenCalled();
 });
 it('keeps employee assignment and search in Eligibility using existing actions',async()=>{
  editor();tab('eligibility');
  const assignment=screen.getByRole('region',{name:words.guided.employeeEligibility});
  fireEvent.change(within(assignment).getByLabelText(words.employeeSearch),{target:{value:'Other'}});
  fireEvent.click(within(assignment).getByRole('button',{name:words.search}));
  await waitFor(()=>expect(mocks.choices).toHaveBeenCalledExactlyOnceWith({employeeSearch:'Other',employeeCursor:undefined}));
 });
 it('moves focus with the four-step keyboard navigation without losing entered state',()=>{
  editor();fireEvent.change(screen.getByLabelText(words.guided.patternName),{target:{value:'Unsaved name'}});
  const tabs=screen.getByRole('tablist');fireEvent.keyDown(tabs,{key:'ArrowRight'});
  expect(screen.getByRole('tab',{name:/Overtime Rates/})).toHaveFocus();
  fireEvent.keyDown(tabs,{key:'Home'});expect(screen.getByLabelText(words.guided.patternName)).toHaveValue('Unsaved name');
 });
 it('retains current keyboard focus when required input blocks the next step',()=>{
  editor();fireEvent.change(screen.getByLabelText(words.guided.patternName),{target:{value:''}});
  const current=screen.getByRole('tab',{name:/General Settings/});current.focus();
  fireEvent.keyDown(screen.getByRole('tablist'),{key:'ArrowRight'});
  expect(current).toHaveFocus();expect(current).toHaveAttribute('aria-selected','true');
  expect(screen.getByRole('alert')).toBeVisible();
 });
 it('refuses malformed saved drafts instead of replacing them with a new policy',()=>{
  const item=detail();item.versions[0].definition={rates:null};wrap(<OvertimeWorkspace detail={item} version={item.versions[0]} setup={setup}/>);
  expect(screen.getByText(words.malformedDraft)).toBeVisible();expect(mocks.save).not.toHaveBeenCalled();
 });
});

describe('selectable nested formula and condition controls',()=>{
 it('adds grouped AND/OR conditions through typed controls',()=>{
  function Harness(){const [value,setValue]=useState<OvertimeCondition>({id:'root',type:'group',logic:'and',children:[]});return <ConditionControl value={value} onChange={setValue} currency="MYR" choices={setup.choices}/>;}
  wrap(<Harness/>);fireEvent.click(screen.getByRole('button',{name:words.addGroup}));
  expect(screen.getAllByLabelText(words.match)).toHaveLength(2);
  fireEvent.change(screen.getAllByLabelText(words.match)[1],{target:{value:'or'}});expect(screen.getAllByLabelText(words.match)[1]).toHaveValue('or');
  expect(screen.queryByRole('textbox')).toBeNull();
 });
 it('offers IF/ELSE and exact decimal inputs without a code editor',()=>{
  function Harness(){const [value,setValue]=useState<OvertimeExpression>({id:'root',type:'literal',unit:'money',value:'',currency:'MYR'});return <ExpressionControl label={words.amount} value={value} onChange={setValue} currency="MYR"/>;}
  wrap(<Harness/>);fireEvent.change(screen.getByLabelText(words.operation),{target:{value:'if'}});
  expect(screen.getByRole('group',{name:words.then})).toBeTruthy();expect(screen.getByRole('group',{name:words.else})).toBeTruthy();
  fireEvent.change(screen.getAllByLabelText(words.decimalValue)[0],{target:{value:'0.100001'}});expect(screen.getAllByLabelText(words.decimalValue)[0]).toHaveValue('0.100001');
  expect(document.querySelector('textarea')).toBeNull();
 });
 it('formats recorded money without a floating point conversion',()=>{
  expect(overtimeMoneyText('12345678901234567',2,'MYR')).toBe('MYR 123456789012345.67');
  expect(overtimeMoneyText('0',2,'MYR')).toBe('MYR 0.00');expect(overtimeMoneyText('bad',2,'MYR')).toBe('—');
 });
 it('shows refused preview issues and trace without inventing a zero result',()=>{
  wrap(<OvertimeCalculationResult pattern={pattern} result={{status:'refused',source:{tenantId:companyId,employmentId:employeeId,attendanceId:patternId,date:todayInKualaLumpur(),inputDigest:'input',approvalDigest:'approval'},patternVersionId:versionId,assignmentId:'assignment',transferable:false,issues:[{code:'unknown',path:'rawMinutes',severity:'error',detail:'Synthetic missing fact'}],trace:[{kind:'field',id:'input',data:{rawMinutes:{state:'unknown',reason:'missing'}}}]}}/>);
  expect(screen.getByText(words.errors.unknown)).toBeVisible();expect(screen.queryByText('MYR 0.00')).toBeNull();
  expect(screen.getByText(words.traceKinds.field+' · 1')).toBeTruthy();
 });
});
