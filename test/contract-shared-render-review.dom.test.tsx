/** Real shipped React components and native DTO shapes with authorized fictional projections.
 * Hosted Chromium raster evidence only: NOT an authenticated installed journey or a release approval. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import type {ComponentProps,ReactNode} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {SharedContractTracker} from '../app/lifecycle/contracts/shared-tracker';
import {SharedContractDetail} from '../app/lifecycle/contracts/[caseId]/shared-detail';
import {SharedApprovalPage} from '../app/lifecycle/contracts/approvals/[approvalId]/review';
import {SharedLetterPage} from '../app/lifecycle/contracts/letters/[letterId]/review';
import {ContractFallbackHistory} from '../app/lifecycle/contracts/fallback-history';
import {SharedContractSettings} from '../app/lifecycle/contracts/settings/shared-settings';
import type {ContractSharedApproval,ContractSharedLetter,ContractDecisionPreview} from '../packs/contracts/service';
import {automationDocument} from '../lib/automation-document';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
const commands=vi.hoisted(()=>({preview:vi.fn(),readPreview:vi.fn(),reconciliations:vi.fn(),fallbacks:vi.fn(),path:'/lifecycle/contracts'}));
vi.mock('next/navigation',()=>({usePathname:()=>commands.path,useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/lifecycle/contracts/shared-actions',()=>({previewSharedDecision:commands.preview,readSharedDecisionPreview:commands.readPreview,submitSharedDecision:vi.fn(),adoptSharedCase:vi.fn(),actSharedApproval:vi.fn(),actSharedLetter:vi.fn(),editSharedLetter:vi.fn(),bindSharedEmployee:vi.fn(),readSharedSetup:vi.fn(),startSharedSetup:vi.fn(),recordSharedDecline:vi.fn(),confirmSharedPay:vi.fn(),readSharedPeriods:vi.fn(),saveSharedSettings:vi.fn(),saveSharedRole:vi.fn(),saveSharedMember:vi.fn(),searchSharedPeople:vi.fn(),readSharedManualWorkflows:vi.fn().mockResolvedValue({ok:true,value:[{id:'fictional-manual',revision:2,name:'Fictional corrected manual follow-up',description:'Restart the reviewed follow-up with its current live definition.'}]}),startSharedManualWorkflow:vi.fn(),readSharedLetterState:vi.fn(),saveSharedForm:vi.fn(),readSharedFallbacks:commands.fallbacks,readSharedEmailReconciliations:commands.reconciliations}));
const id='11111111-1111-4111-8111-111111111111',company='22222222-2222-4222-8222-222222222222',person='33333333-3333-4333-8333-333333333333',hash='a'.repeat(64),at='2026-11-17T02:00:00Z';
type Workspace=ComponentProps<typeof SharedContractDetail>['workspace'];
type ReconciliationItem=NonNullable<Workspace['emailReconciliations']>['items'][number];
function reconciliationItem(index:number,stage:'not_started'|'needs_reconciliation'='not_started'):ReconciliationItem{return {
 eventId:'60000000-0000-4000-8000-'+String(index+1).padStart(12,'0'),caseId:'11111111-1111-4111-8111-111111111110',caseNumber:'CT-FICTIONAL-40',reason:stage==='not_started'?'authority_changed':'legacy_cursor_unknown',recordedAt:at,
 workflows:[{id:'frozen-workflow-'+index,revision:index+2,name:'Fictional frozen workflow '+index,stage}],retainedRunIds:[],
};}

const decision={kind:'renew' as const,startOn:'2027-01-01',endOn:'2027-12-31',months:12,payChanges:true,salaryCents:'520000',reason:'Continue the specialist assignment.',endReason:null,submittedBy:person,submittedAt:at,revision:1};
function workspace(stage:'open'|'document'='open'):Workspace{return {
 view:{id,caseNumber:'CT-FICTIONAL-41',companyId:company,employmentId:person,permissions:['view','seePay','decide','manual'],source:{employmentId:person,companyId:company,personId:person,name:'Fictional Alex Tan',employeeId:'EXAMPLE-041',designation:'Operations Specialist',grade:'G12',department:'Operations',businessGroup:'Fictional Services',company:'Fictional Example Company',manager:'Fictional Direct Superior',signatoryName:'Fictional People BP',signatoryTitle:'People Business Partner',startOn:'2026-01-01',endOn:'2026-12-31',salaryCents:'480000',allowanceCents:'0',allowanceComponentId:null,sourceRevision:hash,ended:false,sourceIssue:null,contractNumber:4,periodRevision:hash,departmentId:null,jobTitle:'Operations Specialist',businessUnitId:null},sourceCurrent:true,flow:{version:2,revision:5,stage,period:{id:'period-41',startOn:'2026-01-01',endOn:'2026-12-31',number:'4',sourceRevision:hash},decision:stage==='open'?null:decision,decisionHistory:[],flags:[],lastActivityAt:at,posting:null,payConfirmation:null,offboardingId:null,declined:null},legacyState:'open',sourceConflict:null,cutoverAvailable:false},
 approvals:stage==='open'?[]:[{id:'approval-41',decisionRevision:1,createdAt:at,status:'approved',workflowName:'Contract renewal approval',stepId:'approval'}],letters:stage==='open'?[]:[{id:'letter-41',decisionRevision:1,name:'Renewal letter',state:'routing',generatedOn:at,releasedAt:null,templateVersion:2,valuesFixed:false,returned:false}],runs:stage==='open'?[]:[{id:'run-41',name:'Renew contract — decision submitted',revision:3,trigger:'decisionSubmitted',status:'waiting',cursor:1,waitingFor:'Letter review by Fictional People BP',startedAt:at,updatedAt:at,steps:[{id:'approval',type:'requestApproval',name:'Approve agreed terms'},{id:'letter',type:'generateDocument',name:'Review and sign renewal letter'},{id:'posting',type:'createPosting',name:'Personnel posting'}],log:[{at,kind:'stepDone',stepId:'approval',type:'requestApproval'},{at,kind:'waiting',stepId:'letter',type:'generateDocument'}]}],ending:null,postingSummary:null,attention:null,reasons:[{code:'contract_expiry',label:'Contract expiry',category:'involuntary'}],activity:[{revision:5,at,actorName:'Fictional Direct Superior',actorType:'user',stage,decisionRevision:stage==='open'?null:1}],waiting:stage==='open'?null:{caseId:id,waitingOn:'Fictional People BP',waitingFor:'Review renewal letter'},periods:{total:1,rows:[{id,caseNumber:'CT-FICTIONAL-41',startOn:'2026-01-01',endOn:'2026-12-31',contractNumber:4,stage,legacyState:'open',shared:true,current:true}]},legacyReadable:false,canOpenPersonnel:true,
};}
const approval:ContractSharedApproval={id,caseId:id,decisionRevision:1,employeeName:'Fictional Alex Tan',employeeCode:'EXAMPLE-041',company:'Fictional Example Company',decision,period:{id:'period-41',startOn:'2026-01-01',endOn:'2026-12-31',number:'4',sourceRevision:hash},contentRevision:1,contentHash:hash,pendingLayerId:'ceo',canAct:true,status:'pending',layers:[{id:'ceo',label:'CEO',stage:1,assigneeName:'Fictional CEO',fulfilled:false}],history:[]};
function letter(kind:'review'|'company'|'employee'):ContractSharedLetter{return {id,caseId:id,decisionRevision:1,templateId:'renewal-template',templateVersion:2,name:'Contract renewal letter',generatedOn:at,state:'routing',valuesFixed:false,releasedAt:null,contentRevision:1,contentHash:hash,returned:false,canEdit:kind==='review',canResend:false,pendingAction:{stepId:kind,kind:kind==='review'?'review':'sign'},layers:[{id:kind,label:kind==='employee'?'Employee':'People BP',stage:kind==='employee'?2:1,kind:kind==='review'?'review':'sign',owner:kind!=='employee',assigneeName:kind==='employee'?'Fictional Alex Tan':'Fictional People BP',unavailable:false,fulfilled:false}],history:[],body:{definition:{name:'Contract renewal letter',blocks:[{id:'intro',type:'text',text:'Dear Fictional Alex Tan,\n\nWe are pleased to renew your contract from 1 January 2027 to 31 December 2027. Your agreed basic salary will be RM 5,200.00 per month.\n\nPlease review and sign this letter.',section:''}],fields:[]},blocks:{intro:'Dear Fictional Alex Tan,\n\nWe are pleased to renew your contract from 1 January 2027 to 31 December 2027. Your agreed basic salary will be RM 5,200.00 per month.\n\nPlease review and sign this letter.'},values:{},receipts:[],fingerprintSource:'native'}};}
const document=automationDocument({id,name:'Contract renewal letter',templateId:'renewal-template',templateVersion:2,blocks:letter('review').body!.definition.blocks,fields:[],merge:{},createdAt:at});
const preview:ContractDecisionPreview={id:'preview-41',caseId:id,caseRevision:5,decision,jobId:'job-41',plan:{blockers:[],warnings:[],workflowVersions:[{workflowId:'renew',revision:3}],workflows:[{id:'renew',revision:3,name:'Renew contract — decision submitted',steps:[{id:'approval',type:'requestApproval',label:'Approve agreed terms',to:[],cc:[],layers:[{id:'ceo',name:'CEO approval',who:'Fictional CEO',pick:'any'}],letter:null},{id:'letter',type:'generateDocument',label:'Generate renewal letter',to:[],cc:[],layers:[],letter:{name:'Contract renewal letter',version:2,steps:[{label:'People BP review',action:'review',who:'Fictional People BP',owner:true},{label:'Company signature',action:'sign',who:'Fictional People BP',owner:false},{label:'Employee signature',action:'sign',who:'Fictional Alex Tan',owner:false}]}},{id:'posting',type:'createPosting',label:'Create Personnel posting',to:[],cc:[],layers:[],letter:null}]}]}};
function mount(node:ReactNode){return render(<NextIntlClientProvider locale="en" messages={en}><div className="v9-workspace v9-workspace-global">{node}</div></NextIntlClientProvider>);}
type Section=Parameters<typeof captureAiReviewScreenshots>[2];
async function capture(container:HTMLElement,section:Section){if(container.textContent?.includes('Loading eligible live workflows…'))await screen.findByLabelText('Live manual workflow');expect(container.textContent).toContain('Fictional');await captureAiReviewScreenshots(aiReviewDomHtml(container),'en',section,'Actual shipped Contract React components; typed authorized fictional native DTOs; NOT authenticated installed journey; no real employment/pay actions','atelier');}
afterEach(cleanup);
beforeEach(()=>{vi.clearAllMocks();commands.reconciliations.mockReset();commands.fallbacks.mockReset();commands.path='/lifecycle/contracts';commands.preview.mockResolvedValue({ok:true,value:{previewId:preview.id}});commands.readPreview.mockResolvedValue({ok:true,value:{...preview,jobState:'completed'}});});

it('captures the actual tracker and native current-period / approved-next-period distinction',async()=>{
 const page:ComponentProps<typeof SharedContractTracker>['page']={rows:[{id:person,employmentId:person,caseId:id,caseNumber:'CT-FICTIONAL-41',companyId:company,employeeName:'Fictional Alex Tan',employeeCode:'EXAMPLE-041',company:'Fictional Example Company',businessGroup:'Fictional Services',department:'Operations',position:'Operations Specialist',manager:'Fictional Direct Superior',startOn:'2026-01-01',endOn:'2026-12-31',contractNumber:4,sourceRevision:hash,stage:'renewed',legacyState:'renewed',sharedRevision:5,flags:[],lastActivityAt:at,payChanges:false,payConfirmed:false,previousPayPending:false,payPendingCaseId:null,canOpen:false,sourceIssue:null,attention:false,firstReminderOn:'2026-11-01',decisionNeeded:false,endPassed:false,stalledDays:null,scheduledPeriod:{postingId:'posting-41',label:'PP-FICTIONAL-42',eventType:'contractRenewal',startOn:'2027-01-01',endOn:'2027-12-31',contractNumber:5,status:'scheduled'}}],total:1,summary:{total:1,upcoming:0,decision:0,inProgress:0,closed:1,attention:0},companies:[{id:company,name:'Fictional Example Company'}],businessGroups:[],hasMore:false,limit:50,offset:0};
 const view=mount(<SharedContractTracker page={page} query={{}} waiting={[]}/>);expect(screen.getByRole('heading',{name:'Contract Management'})).toBeVisible();expect(screen.getByRole('row',{name:/Fictional Alex Tan/})).toHaveTextContent('Contract #4');await capture(view.container,'contract-tracker');
},120000);
for(const [kind,label] of [['renew','Renew'],['convert','Convert to permanent'],['end','End']] as const)it(`captures the actual ${kind} decision form`,async()=>{
 commands.path='/lifecycle/contracts/'+id;const view=mount(<SharedContractDetail workspace={workspace()} today="2026-11-17"/>);fireEvent.click(screen.getByRole('button',{name:label}));expect(screen.getByRole('button',{name:label})).toHaveAttribute('aria-pressed','true');expect(screen.getByRole('heading',{name:'Contract decision'})).toBeVisible();await capture(view.container,`contract-${kind}`);
},120000);
it('captures the actual preview after the native preview service responds',async()=>{
 commands.path='/lifecycle/contracts/'+id;const view=mount(<SharedContractDetail workspace={workspace()} today="2026-11-17"/>);fireEvent.change(screen.getByLabelText('Reason for decision'),{target:{value:'Continue the specialist assignment.'}});fireEvent.click(screen.getByRole('checkbox',{name:'Pay changes'}));const salary=screen.getByRole('textbox',{name:'Proposed basic salary (RM)'});expect(salary).toHaveAccessibleName('Proposed basic salary (RM)');expect(salary).toHaveAccessibleDescription('Payroll is updated separately and manually after the Personnel posting is approved.');expect(screen.getByLabelText('Proposed basic salary (RM)')).toBe(salary);fireEvent.change(salary,{target:{value:'5200.00'}});fireEvent.click(screen.getByRole('button',{name:'Preview decision'}));await waitFor(()=>expect(screen.getByRole('button',{name:'Submit decision'})).toBeEnabled());expect(commands.preview).toHaveBeenCalledWith({caseId:id,revision:5,draft:expect.objectContaining({payChanges:true,basicSalary:'5200.00',reason:decision.reason})});expect(commands.readPreview).toHaveBeenCalledWith(preview.id);expect(screen.getByText('CEO approval · Fictional CEO · Any eligible member')).toBeVisible();await capture(view.container,'contract-preview');
},120000);
it('captures the actual in-progress owner, workflow and retained letter',async()=>{commands.path='/lifecycle/contracts/'+id;const view=mount(<SharedContractDetail workspace={workspace('document')} today="2026-11-17"/>);expect(screen.getByRole('heading',{name:'Case progress'})).toBeVisible();expect(screen.getByText('Letter · Current')).toBeVisible();await capture(view.container,'contract-progress');},120000);
it('captures the actual assigned approval with frozen agreed terms',async()=>{commands.path='/lifecycle/contracts/approvals/'+id;const view=mount(<SharedApprovalPage approval={approval}/>);expect(screen.getByRole('button',{name:'Reject and return decision'})).toBeDisabled();expect(screen.getByRole('button',{name:'Approve'})).toBeEnabled();await capture(view.container,'contract-approval');},120000);
for(const kind of ['review','company','employee'] as const)it(`captures the actual letter ${kind} portal`,async()=>{
 commands.path='/lifecycle/contracts/letters/'+id;const view=mount(<SharedLetterPage letter={letter(kind)} document={document} capabilities={{canBindEmployee:false,pendingRole:kind==='employee'?'employee':'company',purpose:'outcome',contractDeclineGuidance:kind==='employee'}}/>);
 if(kind==='review'){fireEvent.click(screen.getByRole('button',{name:'Edit wording for this case'}));expect(screen.getByLabelText('Letter text')).toHaveValue(letter(kind).body!.blocks.intro);}else{expect(screen.getByRole('checkbox')).not.toBeChecked();expect(screen.getByRole('button',{name:'Sign and release letter'})).toBeDisabled();}
 await capture(view.container,kind==='review'?'contract-letter-review':kind==='company'?'contract-company-sign':'contract-employee-sign');
},120000);
it('captures actual settings and tenant-wide access administration with existing shared groups',async()=>{
 const props:ComponentProps<typeof SharedContractSettings>={companyId:company,today:'2026-11-17',setup:{installed:true,accessReady:false,v9Ready:true,jobId:null,canInstall:true,missing:[],groups:[],routings:[]},choices:{accessAdmin:true,companies:[{id:company,name:'Fictional Example Company'}],scopes:[],people:[{id:person,name:'Fictional People BP'}],groups:[{id:'peopleops',name:'Fictional People Ops'},{id:'posters',name:'Fictional Personnel approvers'}]},stored:{revision:2,accessAdmin:true,settings:{fallbackGroupId:'peopleops',postingApproverGroupId:'posters',stallEnabled:true,stallDays:5,automaticSuperior:{enabled:true,permissions:['view','decide']}}},access:{roles:[{id:'role-41',name:'Fictional decision owners',permissions:['view','decide'],revision:1}],members:[{id:'member-41',roleId:'role-41',userId:person,name:'Fictional People BP',companyId:null,businessGroupId:null,validFrom:'2026-01-01',validTo:null,revokedAt:null,revision:1}]}};
 commands.path='/lifecycle/contracts/settings';const view=mount(<SharedContractSettings {...props}/>);expect(screen.getByRole('heading',{name:'Contract settings and access'})).toBeVisible();expect(screen.getByRole('combobox',{name:/^Fallback assignment group/})).toHaveValue('peopleops');fireEvent.click(screen.getByRole('button',{name:'Fictional decision owners'}));expect(screen.getByLabelText('Role name')).toHaveValue('Fictional decision owners');await capture(view.container,'contract-settings');
},120000);

it('captures separate heading, paragraph and table wording with readable linked fields and unknown-token warning',async()=>{
 commands.path='/lifecycle/contracts/letters/'+id;
 const value=letter('review');const blocks=[{id:'title',type:'heading' as const,text:'Contract renewal',section:''},{id:'intro',type:'text' as const,text:'Dear {employee.name}, your position is {employee.jobTitle}.',section:''},{id:'terms',type:'table' as const,text:'',section:'',columns:'Term | Agreed detail',rows:'New period | {contract.newStart} to {contract.newEnd}\nReference | {unknown.reference}'}];
 value.body={...value.body!,definition:{...value.body!.definition,blocks},blocks:Object.fromEntries(blocks.map(block=>[block.id,block.type==='table'?block.rows!:block.text])),values:{'employee.name':'Fictional Alex Tan','employee.jobTitle':'Operations Specialist'},receipts:[],fingerprintSource:'native'};
 const body=automationDocument({id,name:value.name,templateId:value.templateId,templateVersion:value.templateVersion,blocks,fields:[],merge:value.body.values,createdAt:at});
 const view=mount(<SharedLetterPage letter={value} document={body}/>);fireEvent.click(screen.getByRole('button',{name:'Edit wording for this case'}));
 expect(screen.getByLabelText('Heading')).toHaveValue('Contract renewal');expect(screen.getByLabelText('Letter text')).toHaveValue('Dear {Full name}, your position is {Position}.');expect(screen.getByLabelText('Table rows')).toHaveValue('New period | {New start date} to {New end date}\nReference | {unknown.reference}');expect(screen.getByText(/It stays as typed/)).toBeVisible();expect(screen.getAllByRole('button',{name:'Restore template wording'})).toHaveLength(3);
 await capture(view.container,'contract-multiple-blocks');
},120000);
it('captures returned owner review with the recorded reason and resend control',async()=>{
 commands.path='/lifecycle/contracts/letters/'+id;const value=letter('review');value.returned=true;value.canResend=true;value.pendingAction=null;value.history=[{id:'return-41',stepId:'company',actorName:'Fictional company signatory',action:'returned',comment:'Please clarify the contract end date in the second paragraph.',at,revision:1,hash}];
 const view=mount(<SharedLetterPage letter={value} document={document}/>);expect(screen.getByRole('button',{name:'Resend letter'})).toBeEnabled();expect(screen.getByText(value.history[0].comment)).toBeVisible();await capture(view.container,'contract-returned');
},120000);
it('captures a genuinely held assigned employee identity without an invented replacement action',async()=>{
 commands.path='/lifecycle/contracts/letters/'+id;const value=letter('employee');value.pendingAction=null;value.layers[0].unavailable=true;value.layers[0].assigneeName='Fictional original employee';
 const view=mount(<SharedLetterPage letter={value} document={document}/>);expect(screen.getByText(/restoring the original assigned identity/)).toBeVisible();expect(screen.queryByRole('button',{name:'Sign and release letter'})).not.toBeInTheDocument();await capture(view.container,'contract-blocked');
},120000);
it('captures every case flag, stalled age and classified fallback recovery alongside retained progress',async()=>{
 commands.path='/lifecycle/contracts/'+id;const value=workspace('document');value.view.flow!.flags=['fallback','employee_cannot_sign','sent_back','template_stopped','posting_mismatch','no_workflow','pay_pending'];value.attention={caseId:id,stalledDays:8,attention:true,flags:value.view.flow!.flags};value.configuredFallbackGroup='Fictional People Ops';value.fallbackPage={total:1,hasMore:false,nextBefore:null,rows:[{ordinal:1,at,runId:'run-41',stepId:'letter',workflowName:'Renew contract — decision submitted',stepNumber:2,stepName:'Review and sign renewal letter',details:[{intended:'People BP review',reason:'The routing matched no eligible person.',groupCurrentName:'Fictional People Ops'}]}]};value.runs[0].status='failed';value.runs[0].log.push({at,kind:'stepFailed',stepId:'letter',type:'generateDocument',message:'The document template or signing route cannot run. People Ops must check publication and eligible routed accounts in HR Automation.',fallbackCount:2});
 value.attention.flags=[...value.attention.flags,'workflow_reconciliation'];
 const unstarted=reconciliationItem(0),legacy=reconciliationItem(1,'needs_reconciliation');unstarted.retainedRunIds=['historical-run'];unstarted.workflows.push({id:'frozen-second-workflow',revision:7,name:'Fictional frozen second workflow',stage:'not_started'});
 value.emailReconciliations={items:[unstarted,legacy],total:2,limit:50,offset:0,hasMore:false};
 value.runs.push({...value.runs[0],id:'historical-run',name:'Fictional historical follow-up',cursor:3,waitingFor:null,steps:[{id:'done',type:'requestApproval',name:'Fictional completed approval'},{id:'skipped',type:'notify',name:'Fictional skipped notice'},{id:'held',type:'generateDocument',name:'Fictional formerly waiting letter'},{id:'tail-posting',type:'createPosting',name:'Fictional unexecuted posting'},{id:'tail-offboarding',type:'startOffboarding',name:'Fictional unexecuted handoff'}],log:[{at,kind:'stepDone',stepId:'done',type:'requestApproval'},{at,kind:'stepSkipped',stepId:'skipped',type:'notify'},{at,kind:'waiting',stepId:'held',type:'generateDocument'},{at,kind:'failed',stepId:null,type:null,message:'The remaining steps require People Ops review.'}]});
 const view=mount(<SharedContractDetail workspace={value} today="2026-11-17"/>);expect(screen.getByText(/Stalled for.*8/)).toBeVisible();expect(screen.getByText('No workflow ran')).toBeVisible();expect(screen.getByRole('heading',{name:'Start workflow by hand'})).toBeVisible();
 const retained=within(screen.getByRole('heading',{name:'Fictional historical follow-up · Version 3'}).closest('section')!),steps=retained.getAllByRole('listitem');
 expect(steps).toHaveLength(5);expect(within(steps[0]).getByText('Completed')).toBeVisible();expect(within(steps[1]).getByText('Skipped')).toBeVisible();expect(within(steps[2]).getByText('Needs review')).toBeVisible();
 for(const step of steps.slice(3)){expect(within(step).getByText('Not run')).toBeVisible();expect(within(step).queryByText('Completed')).not.toBeInTheDocument();}
 expect(retained.queryByText('Waiting')).not.toBeInTheDocument();expect(retained.queryByText('Waiting for assigned action')).not.toBeInTheDocument();expect(screen.getByText('The document template or signing route cannot run. People Ops must check publication and eligible routed accounts in HR Automation.')).toBeVisible();
 const reviews=within(screen.getByRole('heading',{name:'Historical workflow review'}).closest('section')!);
 expect(reviews.getAllByRole('link',{name:'Open original Contract case · CT-FICTIONAL-40'})).toHaveLength(2);expect(reviews.getAllByRole('link')[0]).toHaveAttribute('href','/lifecycle/contracts/11111111-1111-4111-8111-111111111110');
 expect(within(reviews.getByText('Fictional frozen workflow 0').closest('li')!).getByText('Not run')).toBeVisible();expect(within(reviews.getByText('Fictional frozen workflow 1').closest('li')!).getByText('Needs People Ops review')).toBeVisible();
 expect(reviews.getByText('Fictional frozen second workflow').closest('li')).toHaveTextContent('Version 7');expect(reviews.getByText('2 of 2 historical review records')).toBeVisible();expect(reviews.queryByRole('button')).not.toBeInTheDocument();expect(screen.queryByText('workflow_reconciliation')).not.toBeInTheDocument();expect(screen.getByText('Historical workflows need People Ops review')).toBeVisible();
 await capture(view.container,'contract-flags');
},120000);
it('captures native Form fields, locked source hold and scoped immutable answer receipt',async()=>{
 commands.path='/lifecycle/contracts/letters/'+id;const value=letter('employee');const fields=[{id:'contact',label:'Emergency contact',type:'text' as const,owner:'employee' as const,pmKey:null,required:true,sensitive:false,options:[],section:'',when:null},{id:'reference',label:'Identity number',type:'text' as const,owner:'pmLocked' as const,pmKey:'icNo',required:true,sensitive:false,options:[],section:'',when:null},{id:'hrNote',label:'People BP check',type:'text' as const,owner:'hr' as const,pmKey:null,required:false,sensitive:false,options:[],section:'',when:null}];const blocks=[{id:'heading',type:'heading' as const,text:'Contact confirmation',section:''},{id:'answers',type:'fields' as const,text:'',section:''}];value.body={definition:{name:'Contact Form',blocks,fields},blocks:{heading:'Contact confirmation'},values:{icNo:''},receipts:[],fingerprintSource:'native'};value.layers=[{id:'review',label:'People BP',stage:1,kind:'review',owner:true,assigneeName:'Fictional People BP',fulfilled:true,unavailable:false},...value.layers];value.history=[{id:'hr-answers',stepId:'review',actorName:'Fictional People BP',action:'reviewed',comment:'Contact details checked.',at,revision:1,hash:'d'.repeat(64)}];
 const body=automationDocument({id,name:'Contact confirmation Form',templateId:value.templateId,templateVersion:2,blocks,fields,merge:{icNo:''},createdAt:at});const form={letterId:id,kind:'Form' as const,visible:true as const,responseRevision:2,responseHash:'b'.repeat(64),legalBaseHash:hash,values:{contact:'Fictional contact',reference:'',hrNote:'Fictional check complete'},editableFieldIds:['contact'],missingLockedFields:['reference'],receipts:[{actionId:'hr-answers',actorUserId:'private-uid',actorPersonId:'private-pid',legalBaseHash:hash,responseRevision:1,responseHash:'c'.repeat(64),actorName:'Fictional People BP',at,scope:'hr' as const,fieldIds:['reference','hrNote'],values:{reference:'FICTIONAL-PRIOR-IC',hrNote:'Fictional check complete'}}]};
 const view=mount(<SharedLetterPage letter={value} document={body} form={form} capabilities={{canBindEmployee:false,pendingRole:'employee'}}/>);expect(screen.getByRole('button',{name:'Sign and release letter'})).toBeDisabled();expect(screen.getByText('Required source fields need attention')).toBeVisible();expect(screen.getByText('FICTIONAL-PRIOR-IC')).toBeVisible();expect(view.container.textContent).not.toMatch(/private-uid|private-pid/);await capture(view.container,'contract-form');
},120000);

it('captures metadata-only employee account confirmation without a Form body or Sign action',async()=>{
 commands.path='/lifecycle/contracts/letters/'+id;
 const value={...letter('employee'),pendingAction:null,body:null,contentHash:null};
 const view=mount(<SharedLetterPage letter={value} document={null} form={{letterId:id,kind:'Form',visible:false}} capabilities={{canBindEmployee:true,canSelfBind:true,companyActionsAvailable:true,pendingRole:null}}/>);
 expect(screen.getByRole('button',{name:'Confirm your account to continue'})).toBeEnabled();
 expect(screen.queryByRole('button',{name:'Sign and release letter'})).not.toBeInTheDocument();
 expect(screen.queryByRole('link',{name:'Download PDF'})).not.toBeInTheDocument();
 await capture(view.container,'contract-self-account');
},120000);

it('reads the next bounded historical review page with the native count and actual old case links',async()=>{
 commands.path='/lifecycle/contracts/'+id;const value=workspace('document'),items=Array.from({length:50},(_,index)=>reconciliationItem(index));value.emailReconciliations={items,total:51,limit:50,offset:0,hasMore:true};
 commands.reconciliations.mockResolvedValue({ok:true,value:{items:[reconciliationItem(50)],total:51,limit:50,offset:50,hasMore:false}});
 mount(<SharedContractDetail workspace={value} today="2026-11-17"/>);
 expect(screen.getByText('50 of 51 historical review records')).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'Show more workflow reviews'}));
 expect(await screen.findByText('Fictional frozen workflow 50')).toBeVisible();expect(commands.reconciliations).toHaveBeenCalledExactlyOnceWith(id,50);expect(screen.getByText('51 of 51 historical review records')).toBeVisible();expect(screen.queryByRole('button',{name:'Show more workflow reviews'})).not.toBeInTheDocument();
});
it('discards an old in-flight review page when a refreshed workspace supplies a newer generation',async()=>{
 commands.path='/lifecycle/contracts/'+id;let resolve!:(value:{ok:true;value:NonNullable<Workspace['emailReconciliations']>})=>void;commands.reconciliations.mockReturnValue(new Promise(done=>{resolve=done;}));
 const value=workspace('document');value.emailReconciliations={items:Array.from({length:50},(_,index)=>reconciliationItem(index)),total:51,limit:50,offset:0,hasMore:true};const view=mount(<SharedContractDetail workspace={value} today="2026-11-17"/>);
 fireEvent.click(screen.getByRole('button',{name:'Show more workflow reviews'}));await waitFor(()=>expect(commands.reconciliations).toHaveBeenCalledOnce());
 const latest=workspace('document');latest.emailReconciliations={items:[reconciliationItem(99),...value.emailReconciliations.items.slice(0,49)],total:52,limit:50,offset:0,hasMore:true};view.rerender(<NextIntlClientProvider locale="en" messages={en}><div className="v9-workspace v9-workspace-global"><SharedContractDetail workspace={latest} today="2026-11-17"/></div></NextIntlClientProvider>);
 expect(await screen.findByText('Fictional frozen workflow 99')).toBeVisible();resolve({ok:true,value:{items:[reconciliationItem(50)],total:51,limit:50,offset:50,hasMore:false}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Show more workflow reviews'})).toBeEnabled());expect(screen.getByText('50 of 52 historical review records')).toBeVisible();expect(screen.queryByText('Fictional frozen workflow 50')).not.toBeInTheDocument();
});

it('refreshes the first historical review page when the same case native total changes during pagination',async()=>{
 const value=workspace('document');value.emailReconciliations={items:[reconciliationItem(0)],total:2,limit:1,offset:0,hasMore:true};
 commands.reconciliations.mockResolvedValueOnce({ok:true,value:{items:[reconciliationItem(1)],total:3,limit:1,offset:1,hasMore:true}}).mockResolvedValueOnce({ok:true,value:{items:[reconciliationItem(99)],total:3,limit:1,offset:0,hasMore:true}});
 mount(<SharedContractDetail workspace={value} today="2026-11-17"/>);fireEvent.click(screen.getByRole('button',{name:'Show more workflow reviews'}));
 expect(await screen.findByText('Fictional frozen workflow 99')).toBeVisible();expect(commands.reconciliations).toHaveBeenNthCalledWith(1,id,1);expect(commands.reconciliations).toHaveBeenNthCalledWith(2,id,0);expect(screen.getByText('1 of 3 historical review records')).toBeVisible();expect(screen.queryByText('Fictional frozen workflow 0')).not.toBeInTheDocument();
});
it('discards an in-flight fallback page after the native source snapshot changes',async()=>{
 type FallbackPage=ComponentProps<typeof ContractFallbackHistory>['initial'];
 const receipt=(ordinal:number):FallbackPage['rows'][number]=>({ordinal,at,runId:'run-41',stepId:'letter',workflowName:'Fictional workflow '+ordinal,stepNumber:2,stepName:'Fictional letter',details:[]});
 let resolve!:(value:{ok:true;value:FallbackPage})=>void;commands.fallbacks.mockReturnValue(new Promise(done=>{resolve=done;}));
 const initial:FallbackPage={rows:[receipt(3)],total:3,hasMore:true,nextBefore:3};
 const view=mount(<ContractFallbackHistory caseId={id} initial={initial}/>);fireEvent.click(screen.getByRole('button',{name:'Show more fallbacks'}));await waitFor(()=>expect(commands.fallbacks).toHaveBeenCalledExactlyOnceWith(id,3));
 const latest:FallbackPage={rows:[receipt(4)],total:4,hasMore:true,nextBefore:4};view.rerender(<NextIntlClientProvider locale="en" messages={en}><div className="v9-workspace v9-workspace-global"><ContractFallbackHistory caseId={id} initial={latest}/></div></NextIntlClientProvider>);
 expect(screen.getByText(/Fictional workflow 4/)).toBeVisible();resolve({ok:true,value:{rows:[receipt(2)],total:3,hasMore:true,nextBefore:2}});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Show more fallbacks'})).toBeEnabled());expect(screen.getByText('1 of 4 recorded fallback events')).toBeVisible();expect(screen.queryByText(/Fictional workflow 2/)).not.toBeInTheDocument();
});

it('keeps evicted earlier failed-run logs unknown while marking the untouched frozen suffix not run',()=>{
 const value=workspace('document'),steps:Workspace['runs'][number]['steps']=Array.from({length:250},(_,index)=>({id:'retained-'+index,type:'notify',name:'Fictional frozen step '+index}));
 // Native MAX_RUN_LOG retains only the last 200 entries: earlier completed receipts are no longer observable.
 const log:Workspace['runs'][number]['log']=Array.from({length:199},(_,index)=>({at,kind:'stepDone',stepId:'retained-'+(index+40),type:'notify'}));
 log.push({at,kind:'stepFailed',stepId:'retained-239',type:'notify',message:'Fictional retained failure requires People Ops review.'});
 value.runs=[{...value.runs[0],id:'evicted-log-run',name:'Fictional long failed workflow',status:'failed',cursor:240,waitingFor:null,steps,log}];
 expect(value.runs[0].steps).toHaveLength(250);expect(value.runs[0].log).toHaveLength(200);
 mount(<SharedContractDetail workspace={value} today="2026-11-17"/>);
 const retained=within(screen.getByRole('heading',{name:'Fictional long failed workflow · Version 3'}).closest('section')!),rows=retained.getAllByRole('listitem');
 expect(rows).toHaveLength(250);
 for(const index of [0,39]){expect(within(rows[index]).getByText('Needs review')).toBeVisible();expect(within(rows[index]).queryByText('Completed')).not.toBeInTheDocument();expect(within(rows[index]).queryByText('Not run')).not.toBeInTheDocument();}
 expect(within(rows[40]).getByText('Completed')).toBeVisible();expect(within(rows[238]).getByText('Completed')).toBeVisible();expect(within(rows[239]).getByText('Needs review')).toBeVisible();
 for(const row of rows.slice(240)){expect(within(row).getByText('Not run')).toBeVisible();expect(within(row).queryByText('Completed')).not.toBeInTheDocument();}
 expect(retained.getByText('Fictional retained failure requires People Ops review.')).toBeVisible();expect(retained.queryByText('Waiting')).not.toBeInTheDocument();
});

it.each(['waiting','running'] as const)('shows the authorized reconciliation hold over a retained %s run header without rewriting native step state',status=>{
 const value=workspace('document'),run=value.runs[0];run.status=status;const retainedLog=structuredClone(run.log);value.runs.push({...run,id:'unlisted-run',name:'Fictional unrelated current workflow'});
 const record=reconciliationItem(0,'needs_reconciliation');record.retainedRunIds=[run.id];value.emailReconciliations={items:[record],total:1,limit:50,offset:0,hasMore:false};
 mount(<SharedContractDetail workspace={value} today="2026-11-17"/>);
 const retainedHeading=screen.getByRole('heading',{name:'Renew contract — decision submitted · Version 3'}),retained=within(retainedHeading.closest('section')!);
 expect(retainedHeading.nextElementSibling).toHaveTextContent(/^Needs People Ops review$/);expect(retainedHeading.nextElementSibling).toBeVisible();expect(retained.queryByText('Running')).not.toBeInTheDocument();
 expect(retained.getByText('Completed')).toBeVisible();expect(retained.getByText('Waiting')).toBeVisible();expect(value.runs[0].status).toBe(status);expect(value.runs[0].log).toEqual(retainedLog);
 const unrelatedHeading=screen.getByRole('heading',{name:'Fictional unrelated current workflow · Version 3'}),unrelated=within(unrelatedHeading.closest('section')!);
 expect(unrelatedHeading.nextElementSibling).toHaveTextContent(status==='running'?/^Running$/:/^Waiting for assigned action$/);expect(unrelatedHeading.nextElementSibling).toBeVisible();expect(unrelated.queryByText('Needs People Ops review')).not.toBeInTheDocument();
});

it.each(['workflow','offboarding'] as const)('keeps the recorded decline visible and read-only while the case is %s',stage=>{
 commands.path='/lifecycle/contracts/'+id;
 const value=workspace('document'),flow=value.view.flow!;
 flow.stage=stage;flow.declined={reason:'fictional_retained_reason',notes:'The employee told People Ops they will not renew.',by:'44444444-4444-4444-8444-444444444444',at};
 flow.offboardingId=stage==='offboarding'?'55555555-5555-4555-8555-555555555555':null;
 value.reasons=[];value.reasonLabels=[{code:'fictional_retained_reason',label:'Current tenant decline label'}];
 value.waiting=null;value.view.permissions=['view','seePay'];
 const retained=JSON.stringify(value),mounted=mount(<SharedContractDetail workspace={value} today="2026-11-17"/>);
 const summary=within(screen.getByRole('heading',{name:'Employee declined renewal'}).closest('section')!);
 expect(summary.getByText('Current tenant decline label')).toBeVisible();
 expect(summary.getByText('The employee told People Ops they will not renew.')).toBeVisible();
 expect(summary.getByText(/17[/]11[/]2026/)).toBeVisible();
 expect(summary.queryByText('Recorded authorised actor')).not.toBeInTheDocument();
 expect(summary.queryByText('Fictional Direct Superior')).not.toBeInTheDocument();
 expect(summary.queryByText(flow.declined.by)).not.toBeInTheDocument();
 expect(summary.getByText('The employee declined this renewal. The renewal offer did not take effect; ending and Offboarding follow the configured workflow.')).toBeVisible();
 expect(summary.queryByRole('button')).not.toBeInTheDocument();expect(summary.queryByRole('textbox')).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'Record employee decline'})).not.toBeInTheDocument();
 const submitted=within(screen.getByRole('heading',{name:'Submitted decision'}).closest('section')!);
 expect(submitted.getByText('Renew')).toBeVisible();expect(submitted.getByText('RM 5,200.00')).toBeVisible();
 if(stage==='offboarding')expect(screen.getByRole('link',{name:'Open Offboarding case'})).toHaveAttribute('href','/lifecycle/v9?view=leavers&case='+flow.offboardingId);
 expect(commands.preview).not.toHaveBeenCalled();expect(JSON.stringify(value)).toBe(retained);
 mounted.unmount();
});
