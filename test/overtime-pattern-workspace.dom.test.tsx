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
vi.mock('../app/admin/attendance/settings/overtime-patterns/actions',()=>({saveOvertimeDraftAction:mocks.save,forkOvertimeDraftAction:mocks.fork,validateOvertimeAction:mocks.validate,activateOvertimeAction:mocks.activate,stopOvertimeAction:mocks.stop,archiveOvertimeAction:mocks.archive,saveOvertimeAssignmentAction:mocks.assign,closeOvertimeAssignmentAction:mocks.close,overtimeChoicesAction:mocks.choices,previewOvertimeEmployeeAction:mocks.previewEmployee,previewOvertimeSampleAction:mocks.previewSample,readOvertimeTransferAction:mocks.readTransfer,calculateOvertimeDayAction:mocks.calculate,transferOvertimePayrollAction:mocks.transfer}));
import {OvertimeWorkspace} from '../components/overtime-patterns/workspace';
import {ConditionControl,ExpressionControl} from '../components/overtime-patterns/rule-controls';
import {overtimeMoneyText,OvertimeCalculationResult} from '../components/overtime-patterns/calculation-result';
import {todayInKualaLumpur} from '../lib/hr-date';
import {__resetUnsavedGuards} from '../lib/unsaved-changes';

const companyId='00000000-0000-4000-8000-000000000001';
const patternId='00000000-0000-4000-8000-000000000002';
const versionId='00000000-0000-4000-8000-000000000003';
const employeeId='00000000-0000-4000-8000-000000000004';
const pattern:OvertimePattern={v:1,currency:{code:'MYR',minorScale:2},eligibilityBasis:'day',durationAllocation:'earliest',definitions:[],eligibility:{id:'eligibility',type:'constant',value:true},eligibleMinutes:null,durationCap:null,durationRounding:null,deductions:[],rates:[],paymentCap:null,moneyRounding:{stage:'line',mode:'halfUp'}};
const setup:OvertimePatternSetup={companies:[{id:companyId,name:'Fictional Company',currency:'MYR',minorScale:2}],employees:[{id:employeeId,companyId,name:'Fictional Employee',employeeCode:'SYNTH-01'}],employeeNextCursor:null,earningItems:[],choices:{companyId:[{id:companyId,label:'Fictional Company'}]},readerLimitations:[]};
function detail(activated=false):OvertimePatternDetail {
 const createdAt=new Date();
 return {pattern:{id:patternId,tenantId:companyId,kind:'formula',code:'SYNTH-OT',creationCompanyId:companyId,legacyRuleRef:null,legacyRuleId:null,revision:3,archivedAt:null,createdAt},versions:[{id:versionId,tenantId:companyId,patternId,kind:'formula',creationCompanyId:companyId,ordinal:1,revision:7,name:'Fictional Overtime',description:'',definition:{...pattern},digest:'fixture-digest',activatedAt:activated?createdAt:null,activatedBy:null,createdAt,companyIds:[companyId],status:activated?'active':'draft',effectiveFrom:null,states:[]}],assignments:[],writable:true};
}
const catalogues={en,ms,ta,th,vi:viMessages,zh};
function wrap(node:React.ReactNode,locale:keyof typeof catalogues='en') {return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}>{node}</NextIntlClientProvider>);}
function editor(activated=false) {const item=detail(activated);return wrap(<OvertimeWorkspace detail={item} version={item.versions[0]} setup={setup}/>);}
const words=en.overtimePatterns;
function tab(key:keyof typeof words.sections) {fireEvent.click(screen.getByRole('tab',{name:words.sections[key]}));return screen.getByRole('tabpanel',{name:words.sections[key]});}

beforeEach(()=>{cleanup();__resetUnsavedGuards();vi.clearAllMocks();mocks.save.mockResolvedValue({ok:true,value:{patternId,versionId,revision:8}});mocks.fork.mockResolvedValue({ok:true,value:{patternId,versionId,revision:1}});mocks.validate.mockResolvedValue({ok:true,value:{validationDigest:'fresh-digest',issues:[],requiredFields:[]}});mocks.activate.mockResolvedValue({ok:true,value:{versionId}});mocks.assign.mockResolvedValue({ok:true,value:{assignmentId:'assignment'}});mocks.choices.mockResolvedValue({ok:true,value:setup});});

describe('typed Overtime Pattern editing',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('shows all seven translated sections in %s',locale=>{
  const errors:unknown[]=[];
  render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={error=>errors.push(error)}><OvertimeWorkspace detail={null} setup={setup}/></NextIntlClientProvider>);
  const words=catalogues[locale].overtimePatterns;
  fireEvent.change(screen.getByLabelText(words.eligibilityBasis),{target:{value:'day'}});fireEvent.change(screen.getByLabelText(words.durationAllocation),{target:{value:'earliest'}});fireEvent.click(screen.getByRole('button',{name:words.prepareDraft}));
  expect(screen.getAllByRole('tab')).toHaveLength(7);
  for(const label of Object.values(catalogues[locale].overtimePatterns.sections))expect(screen.getByRole('tab',{name:label})).toBeTruthy();
  expect(errors).toEqual([]);
 });
 it('constructs a policy only after explicit scope and direction choices and uses canonical read-only currency precision',async()=>{
  wrap(<OvertimeWorkspace detail={null} setup={setup}/>);
  expect(screen.getByLabelText(words.eligibilityBasis)).toHaveValue('');expect(screen.getByLabelText(words.durationAllocation)).toHaveValue('');
  expect(screen.getByRole('button',{name:words.prepareDraft})).toBeDisabled();expect(document.getElementById('overtime-definition')).toBeNull();
  fireEvent.change(screen.getByLabelText(words.eligibilityBasis),{target:{value:'day'}});expect(screen.getByRole('button',{name:words.prepareDraft})).toBeDisabled();expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(words.eligibilityBasis),{target:{value:'day'}});fireEvent.change(screen.getByLabelText(words.durationAllocation),{target:{value:'latest'}});fireEvent.click(screen.getByRole('button',{name:words.prepareDraft}));
  const basic=screen.getByRole('tabpanel',{name:words.sections.basic});
  expect(within(basic).getByLabelText(words.durationAllocation)).toHaveValue('latest');
  fireEvent.change(within(basic).getByLabelText(words.creationCompany),{target:{value:companyId}});
  fireEvent.change(within(basic).getByLabelText(words.currency),{target:{value:'MYR'}});
  expect(within(basic).getByLabelText(words.minorScale)).toHaveValue('2');
  expect(within(basic).getByLabelText(words.minorScale)).toHaveAttribute('readonly');
  expect(mocks.save).not.toHaveBeenCalled();
 });
 it('refuses a malformed saved draft without substituting a new policy',()=>{
  const item=detail();item.versions[0].definition={rates:null};
  wrap(<OvertimeWorkspace detail={item} version={item.versions[0]} setup={setup}/>);
  expect(screen.getByText(words.malformedDraft)).toBeVisible();expect(screen.queryByRole('button',{name:words.saveDraft})).toBeNull();expect(mocks.save).not.toHaveBeenCalled();
 });
 it('retains incomplete blank rate values in drafts without fabricating a policy amount',async()=>{
  editor();
  fireEvent.click(within(tab('rates')).getByRole('button',{name:words.addRate}));
  expect(screen.getByLabelText(words.rateName)).toHaveValue('');
  fireEvent.click(screen.getByRole('button',{name:words.addTier}));
  const decimals=screen.getAllByLabelText(words.decimalValue);
  expect(decimals.every(input=>(input as HTMLInputElement).value==='')).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:words.saveDraft}));
  await waitFor(()=>expect(mocks.save).toHaveBeenCalledOnce());
  const sent=mocks.save.mock.calls[0][0];
  expect(sent.expectedRevision).toBe(7);expect(sent.draft.definition.rates[0].tiers[0].payment.rate.value).toBe('');
  expect(sent.draft.definition.rates[0].tiers[0].mapping.earningItemId).toBe('');
 });
 it('sends the saved revision and prevents a second submission while persistence is pending',async()=>{
  let finish!:(result:unknown)=>void;mocks.save.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));editor();
  const form=document.getElementById('overtime-definition')!;
  fireEvent.submit(form);fireEvent.submit(form);
  await waitFor(()=>expect(mocks.save).toHaveBeenCalledOnce());
  finish({ok:false,code:'stale'});
  await waitFor(()=>expect(screen.getByText(words.errors.stale)).toBeVisible());
  expect(mocks.replace).not.toHaveBeenCalled();
 });
 it('keeps entered values after failure and never renders a raw server exception',async()=>{
  mocks.save.mockResolvedValue({ok:false,code:'system',reference:'OT-1234ABCD'});editor();
  fireEvent.change(screen.getByLabelText(words.name),{target:{value:'Retained fictional draft'}});
  fireEvent.click(screen.getByRole('button',{name:words.saveDraft}));
  await waitFor(()=>expect(screen.getByText(words.errors.system)).toBeVisible());
  expect(screen.getByLabelText(words.name)).toHaveValue('Retained fictional draft');expect(mocks.replace).not.toHaveBeenCalled();
 });
 it('invalidates an activation validation receipt as soon as definition edits change',async()=>{
  editor();fireEvent.click(screen.getByRole('button',{name:words.validate}));
  await waitFor(()=>expect(screen.getByText(words.validated)).toBeVisible());
  fireEvent.change(screen.getByLabelText(words.name),{target:{value:'Changed draft'}});
  expect(screen.getByRole('button',{name:words.activate})).toBeDisabled();
 });
 it('makes activated definitions read-only and forks using the actual pattern revision',async()=>{
  editor(true);expect(screen.getByLabelText(words.name)).toBeDisabled();expect(screen.queryByRole('button',{name:words.saveDraft})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:words.fork}));await waitFor(()=>expect(mocks.fork).toHaveBeenCalledExactlyOnceWith({versionId,expectedPatternRevision:3}));
 });
 it('uses the selected saved activation digest and explicit effective date',async()=>{
  editor();fireEvent.click(screen.getByRole('button',{name:words.validate}));await waitFor(()=>expect(screen.getByText(words.validated)).toBeVisible());
  const from=todayInKualaLumpur(new Date(Date.now()+86400000));
  fireEvent.change(within(screen.getByRole('group',{name:words.lifecycle})).getByLabelText(words.effectiveFrom),{target:{value:from}});fireEvent.click(screen.getByRole('button',{name:words.activate}));
  await waitFor(()=>expect(mocks.activate).toHaveBeenCalledExactlyOnceWith({versionId,expectedRevision:7,validationDigest:'fresh-digest',effectiveFrom:from}));
 });
 it('supports tab keyboard movement without losing entered state',()=>{
  editor();fireEvent.change(screen.getByLabelText(words.name),{target:{value:'Unsaved name'}});
  const tabs=screen.getByRole('tablist');fireEvent.keyDown(tabs,{key:'ArrowRight'});
  expect(screen.getByRole('tab',{name:words.sections.assignment})).toHaveFocus();
  fireEvent.keyDown(tabs,{key:'Home'});expect(screen.getByLabelText(words.name)).toHaveValue('Unsaved name');
 });
 it('searches additional employees without constraining search to already selected IDs',async()=>{
  editor();const assignment=tab('assignment');
  fireEvent.change(within(assignment).getByLabelText(words.employeeSearch),{target:{value:'Other'}});
  fireEvent.click(within(assignment).getByRole('button',{name:words.search}));
  await waitFor(()=>expect(mocks.choices).toHaveBeenCalledExactlyOnceWith({employeeSearch:'Other',employeeCursor:undefined}));
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
