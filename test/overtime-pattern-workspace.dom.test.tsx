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

const mocks=vi.hoisted(()=>({preview:vi.fn(),activate:vi.fn(),edit:vi.fn(),cancel:vi.fn(),save:vi.fn(),assign:vi.fn(),close:vi.fn(),choices:vi.fn(),previewEmployee:vi.fn(),previewSample:vi.fn(),readTransfer:vi.fn(),calculate:vi.fn(),transfer:vi.fn(),push:vi.fn(),replace:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({usePathname:()=>'/admin/attendance/settings/overtime-patterns',useRouter:()=>({push:mocks.push,replace:mocks.replace,refresh:mocks.refresh})}));
vi.mock('../app/admin/attendance/settings/overtime-patterns/actions',()=>({previewOvertimeEligibilityAction:mocks.preview,activateOvertimePatternAction:mocks.activate,editOvertimePatternAction:mocks.edit,cancelOvertimeAssignmentAction:mocks.cancel,saveOvertimeDraftAction:mocks.save,saveOvertimeAssignmentAction:mocks.assign,closeOvertimeAssignmentAction:mocks.close,overtimeChoicesAction:mocks.choices,previewOvertimeEmployeeAction:mocks.previewEmployee,previewOvertimeSampleAction:mocks.previewSample,readOvertimeTransferAction:mocks.readTransfer,calculateOvertimeDayAction:mocks.calculate,transferOvertimePayrollAction:mocks.transfer}));
import {OVERTIME_WORKSPACE_SECTIONS,OvertimeWorkspace} from '../components/overtime-patterns/workspace';
import {ConditionControl,ExpressionControl} from '../components/overtime-patterns/rule-controls';
import {overtimeMoneyText,OvertimeCalculationResult} from '../components/overtime-patterns/calculation-result';
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

const single={id:companyId,currency:'MYR'};
const posted=()=>JSON.parse((document.querySelector('input[name="overtimeDraft"]') as HTMLInputElement).value);
beforeEach(()=>{cleanup();__resetUnsavedGuards();vi.clearAllMocks();mocks.preview.mockResolvedValue(readyPreview());mocks.save.mockResolvedValue({ok:true,value:{patternId,versionId,revision:8}});mocks.assign.mockResolvedValue({ok:true,value:{assignmentId:'assignment'}});mocks.choices.mockResolvedValue({ok:true,value:setup});});

const gradeA='00000000-0000-4000-8000-0000000000c1',gradeB='00000000-0000-4000-8000-0000000000c2',earning='00000000-0000-4000-8000-0000000000e1';
const richSetup:OvertimePatternSetup={...setup,earningItems:[{id:earning,label:'Overtime Pay'}],choices:{...setup.choices,dayType:[{id:'workday',label:'Workday'}],gradeId:[{id:gradeA,label:'Executive'},{id:gradeB,label:'Non-Executive'}]}};
const futureDate='2099-12-01';
function readyPreview(overrides:Record<string,unknown>={}) {return {ok:true,value:{asOf:todayInKualaLumpur(),matched:{count:2,capped:false},unmatched:{count:5,capped:false},scheduleGroup:{employees:{count:0,capped:false},groups:[]},conflicts:[],mayOverlap:[],rows:[{employmentId:employeeId,employeeCode:'SYNTH-01',name:'Fictional Employee',companyId,companyName:'Fictional Company',gradeName:'Executive',employmentType:'permanent'}],nextCursor:null,issues:[],ready:true,...overrides}};}
function draftDetail(planned:unknown=null) {const item=detail();item.versions[0]={...item.versions[0],definition:{...pattern,rates:[]},plannedEligibility:planned};return item;}

describe('Overtime Pattern editor (board 4197534a)',()=>{
 it('moves freely between General Settings, Eligibility and Preview without a Code or Name and keeps what was typed',()=>{
  wrap(<OvertimeWorkspace detail={null} setup={richSetup} newPatternCompany={single}/>);
  expect(screen.getAllByRole('tab')).toHaveLength(3);
  fireEvent.change(screen.getByLabelText(words.guided.patternName),{target:{value:'Kept name'}});
  fireEvent.click(screen.getByRole('tab',{name:new RegExp(words.guided.preview)}));
  expect(screen.getByRole('tabpanel',{name:new RegExp(words.guided.preview)})).toBeVisible();
  fireEvent.click(screen.getByRole('tab',{name:new RegExp(words.guided.eligibility)}));
  expect(screen.getByRole('tabpanel',{name:new RegExp(words.guided.eligibility)})).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:words.guided.back}));
  expect(screen.getByLabelText(words.guided.patternName)).toHaveValue('Kept name');
  expect(screen.queryByText(words.guided.completeGeneral)).toBeNull();
 });
 it('labels the code field Overtime Pattern Code and saves a draft with only the Code and Name',async()=>{
  wrap(<OvertimeWorkspace detail={null} setup={richSetup} newPatternCompany={null}/>);
  expect(screen.getByLabelText(words.guided.patternLabel)).toBeInTheDocument();expect(words.guided.patternLabel).toMatch(/Overtime Pattern Code/);
  // The browser asks for the required Code and Name before submitting; nothing is posted without them.
  expect(screen.getByLabelText(words.guided.patternLabel)).toBeRequired();expect(screen.getByLabelText(words.guided.patternName)).toBeRequired();
  fireEvent.click(screen.getByRole('button',{name:words.saveDraft}));
  await new Promise(resolve=>setTimeout(resolve,0));expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(words.guided.patternLabel),{target:{value:'OT001'}});
  fireEvent.change(screen.getByLabelText(words.guided.patternName),{target:{value:'Standard Overtime'}});
  fireEvent.click(screen.getByRole('button',{name:words.saveDraft}));
  await waitFor(()=>expect(mocks.save).toHaveBeenCalledOnce());
  const input=mocks.save.mock.calls[0][0];
  expect(input.draft).toMatchObject({code:'OT001',name:'Standard Overtime',companyIds:[],plannedEligibility:{v:1,criteria:{},employmentIds:[],priority:100,from:null}});
  expect(input.draft.settings.rows).toHaveLength(1);
 });
 it('shows a starting template as an editable Overtime Settings row with its rate',()=>{
  wrap(<OvertimeWorkspace detail={null} setup={richSetup} starterKey="ot20" newPatternCompany={single}/>);
  expect(screen.getByRole('heading',{name:words.settingsTable.title})).toBeVisible();
  expect(screen.getByLabelText(words.settingsTable.aria.rate.replace('{row}','1'))).toHaveValue('2');
  expect(screen.getByLabelText(words.guided.patternName)).toHaveValue('OT 2.0');
  fireEvent.click(screen.getByRole('button',{name:words.settingsTable.addRow}));
  expect(screen.getByLabelText(words.settingsTable.aria.rate.replace('{row}','2'))).toHaveValue('');
 });
 it('shows a saved definition the table cannot express read-only instead of rewriting it',()=>{
  const item=detail();wrap(<OvertimeWorkspace detail={item} version={item.versions[0]} setup={richSetup}/>);
  expect(screen.getByText(words.settingsTable.custom)).toBeVisible();
  expect(screen.queryByLabelText(words.settingsTable.aria.rate.replace('{row}','1'))).toBeNull();
 });
 it('summarises Eligibility in plain words and posts the chosen companies and criteria',async()=>{
  const item=draftDetail({v:1,criteria:{gradeId:[gradeA,gradeB]},employmentIds:[],priority:100,from:futureDate});
  wrap(<OvertimeWorkspace detail={item} version={item.versions[0]} setup={richSetup}/>);
  const panel=tab('eligibility');
  expect(within(panel).getByText(/SYNTH-OT applies to employees of Fictional Company whose Job grade is Executive or Non-Executive/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:words.saveDraft}));
  await waitFor(()=>expect(mocks.save).toHaveBeenCalledOnce());
  expect(mocks.save.mock.calls[0][0]).toMatchObject({patternId,versionId,expectedRevision:7,draft:{companyIds:[companyId],plannedEligibility:{criteria:{gradeId:[gradeA,gradeB]},from:futureDate}}});
 });
 it('previews who matches and activates from the Applies from date only when every check passes',async()=>{
  mocks.preview.mockResolvedValue(readyPreview());mocks.activate.mockResolvedValue({ok:true,value:{versionId,effectiveFrom:futureDate,assignmentIds:[],navigate:'/next'}});
  const item=draftDetail({v:1,criteria:{},employmentIds:[],priority:100,from:futureDate});
  wrap(<OvertimeWorkspace detail={item} version={item.versions[0]} setup={richSetup}/>);
  const panel=tab('preview');
  await waitFor(()=>expect(mocks.preview).toHaveBeenCalledOnce());
  expect(mocks.preview.mock.calls[0][0]).toMatchObject({patternId,versionId,expectedRevision:7,companyIds:[companyId]});
  expect(await within(panel).findByText('Fictional Employee',{exact:false})).toBeInTheDocument();
  const activate=within(panel).getByRole('button',{name:words.editor.activateFrom.replace('{date}',futureDate)});
  await waitFor(()=>expect(activate).toBeEnabled());
  fireEvent.click(activate);
  await waitFor(()=>expect(mocks.activate).toHaveBeenCalledExactlyOnceWith({patternId,versionId,expectedRevision:7}));
  expect(mocks.push).toHaveBeenCalledWith('/next');
 });
 it('keeps Activate unavailable while a conflict is shown',async()=>{
  mocks.preview.mockResolvedValue(readyPreview({ready:false,conflicts:[{code:'OT002',name:'Special Overtime',employees:2}]}));
  const item=draftDetail({v:1,criteria:{},employmentIds:[],priority:100,from:futureDate});
  wrap(<OvertimeWorkspace detail={item} version={item.versions[0]} setup={richSetup}/>);
  const panel=tab('preview');
  expect(await within(panel).findByText(/OT002 - Special Overtime/)).toBeVisible();
  expect(within(panel).getByRole('button',{name:words.editor.activateFrom.replace('{date}',futureDate)})).toBeDisabled();
  expect(mocks.activate).not.toHaveBeenCalled();
 });
 it('opens an activated version read-only and edits it through a new draft',async()=>{
  mocks.edit.mockResolvedValue({ok:true,value:{patternId,versionId:'00000000-0000-4000-8000-0000000000f1',revision:1,navigate:'/draft'}});
  const item=detail(true);wrap(<OvertimeWorkspace detail={item} version={item.versions[0]} setup={richSetup}/>);
  expect(screen.queryByRole('button',{name:words.saveDraft})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:words.editor.editActive}));
  await waitFor(()=>expect(mocks.edit).toHaveBeenCalledExactlyOnceWith({versionId,expectedPatternRevision:3}));
  expect(mocks.push).toHaveBeenCalledWith('/draft');
 });
 it('shows View read-only without Edit or Save',()=>{
  const item=draftDetail();wrap(<OvertimeWorkspace detail={item} version={item.versions[0]} setup={richSetup} readOnly/>);
  expect(screen.queryByRole('button',{name:words.saveDraft})).toBeNull();expect(screen.getByText(words.editor.viewOnly)).toBeVisible();
 });
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders all three steps with no missing message in %s',locale=>{
  const errors:unknown[]=[];
  render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={error=>errors.push(error)}><OvertimeWorkspace detail={null} setup={richSetup} starterKey="ot15" newPatternCompany={single}/></NextIntlClientProvider>);
  for(const key of ['general','eligibility','preview'] as const)expect(screen.getByRole('tab',{name:new RegExp(catalogues[locale].overtimePatterns.guided[key])})).toBeTruthy();
  expect(errors).toEqual([]);
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

// 2f803985 — a legacy (Schedule Group) pattern shows its relocated band editor instead of a pointer back.
describe('legacy Schedule Group pattern',()=>{
 const legacy=():OvertimePatternDetail=>{const item=detail(true);return {...item,writable:false,pattern:{...item.pattern,kind:'legacy',code:null,creationCompanyId:null,legacyRuleRef:companyId,legacyRuleId:companyId}};};
 it('renders the server band editor as its General Settings, and only the pointer without one',()=>{
  const item=legacy();
  wrap(<OvertimeWorkspace detail={item} version={item.versions[0]} setup={setup} legacyEditor={<section aria-label="relocated bands"><p>Band editor</p></section>}/>);
  expect(screen.getByRole('region',{name:'relocated bands'})).toBeVisible();
  expect(screen.queryByText(words.legacyLink)).toBeNull();expect(screen.queryByRole('tablist')).toBeNull();
  cleanup();
  wrap(<OvertimeWorkspace detail={item} version={item.versions[0]} setup={setup}/>);
  expect(screen.getByText(words.legacyLink)).toBeVisible();
 });
});
