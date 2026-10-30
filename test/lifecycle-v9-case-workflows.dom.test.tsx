import {beforeAll,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,within} from '@testing-library/react';
import {CaseWorkflows} from '../app/lifecycle/v9/case-workflows';
import {v9Defaults} from '../lib/lifecycle-v9-defaults';
import {NextIntlClientProvider} from 'next-intl';
import {readFileSync} from 'node:fs';
import {V9Workspace} from '../app/lifecycle/v9/workspace';
import {readV9Email} from '../app/lifecycle/v9/actions';
import type {EmailPreview,Case,Workflow} from '../lib/lifecycle-v9-model';

vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../components/user-menu',()=>({UserMenu:()=>null}));
vi.mock('../app/lifecycle/v9/actions',()=>({readV9Email:vi.fn(),readV9Workflow:vi.fn(),readV9Case:vi.fn().mockResolvedValue({ok:false,error:'Fictional calculation unavailable'}),commandV9:vi.fn(),createV9Offboarding:vi.fn(),saveV9Config:vi.fn(),setupV9:vi.fn()}));
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
const messages=JSON.parse(readFileSync('messages/en.json','utf8'));
function fixture(){
 const c:Case={version:9,id:'fictional-case',number:'OFB-FICTIONAL',module:'off',revision:1,state:'submitted',facts:{name:'Fictional person',employeeNo:'',employmentId:'',personId:'',joinDate:'2026-01-01',lastDay:'2026-11-01',noticeDate:'2026-10-01',employeeUserId:'employee',supervisorUserId:null,pbpUserId:null,taUserId:null,businessGroup:'',company:'',department:'',grade:'',employmentType:'',title:'',caseType:'Resignation'},checklistId:null,checklistName:'',override:'automatic',tasks:[],items:[],documents:[],runs:[],mails:[],files:[],pmChanges:[],log:[],sourceRevision:'',submittedAt:'',closedAt:null,closedBy:null,closeReason:'',cancelReason:'',revokeDate:'',finalFigures:null,review:null};
 const workflow:Workflow={id:'manual',name:'Fictional manual workflow',module:'off',status:'published',trigger:{event:'manual',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'notify',type:'notify',to:'employee',cc:[],subject:'Fictional',body:''}],description:''};
 const config=v9Defaults();config.workflows=[workflow];return{c,config,workflow};
}
it('starts the selected live workflow by ID and preserves waits for explicit continuation',()=>{
 const {c,config,workflow}=fixture(),command=vi.fn(),view=render(<CaseWorkflows c={c} config={config} busy={false} command={command}/>);
 fireEvent.click(screen.getByRole('button',{name:'Start now Fictional manual workflow'}));expect(command).toHaveBeenCalledWith({type:'startWorkflow',workflowId:'manual'});
 c.runs=[{id:'run',workflowId:'manual',revision:1,date:'2026-10-29',status:'waiting',cursor:0,reason:'Delivery outcome is uncertain.',at:'',definition:workflow}];
 view.rerender(<CaseWorkflows c={c} config={config} busy={false} command={command}/>);expect(screen.getByText('Delivery outcome is uncertain.')).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'Continue Fictional manual workflow'}));expect(command).toHaveBeenLastCalledWith({type:'retryWorkflow',workflowId:'manual'});
 workflow.status='draft';view.rerender(<CaseWorkflows c={c} config={config} busy={false} command={command}/>);expect(screen.getByText('Paused')).toBeVisible();expect(screen.getByRole('button',{name:'Continue Fictional manual workflow'})).toBeDisabled();
});
it('keeps completed and closed cases from offering another start',()=>{
 const {c,config,workflow}=fixture(),command=vi.fn(),view=render(<CaseWorkflows c={c} config={config} busy={false} command={command}/>);
 c.state='cancelled';view.rerender(<CaseWorkflows c={c} config={config} busy={false} command={command}/>);expect(screen.getByRole('button',{name:'Start now Fictional manual workflow'})).toBeDisabled();
 c.state='submitted';c.runs=[{id:'run',workflowId:workflow.id,revision:1,date:'2026-10-29',status:'done',cursor:1,reason:'',at:''}];view.rerender(<CaseWorkflows c={c} config={config} busy={false} command={command}/>);expect(screen.getByRole('button',{name:'Start now Fictional manual workflow'})).toBeDisabled();
});

function mailFixture(){
 const value=fixture(),email=value.config.emails.find(email=>email.id==='e3')!;email.slots=[{id:'proof',label:'Fictional individual voucher',required:true}];value.config.emails=[email];value.workflow.steps=[{id:'mail',type:'email',template:email.id,to:'employee',cc:[]}];
 const preview:EmailPreview={emailId:email.id,name:email.name,subject:'Reviewed fictional subject',body:'Reviewed fictional message',edit:{subject:'Subject for {employee.name}',body:'Personal draft'},to:[{id:'employee',name:'Fictional person'}],cc:[{id:'manager',name:'Fictional manager'}],documents:[{templateId:'t4',name:'Fictional letter',version:1,generated:false}],holds:['Upload the individual voucher.'],canSend:false};
 return {...value,email,preview};
}
it('opens the actual full email preview from a workflow, including recipients, documents and required files',async()=>{
 const {c,config,preview}=mailFixture(),command=vi.fn().mockResolvedValue({ok:true});vi.mocked(readV9Email).mockResolvedValueOnce({ok:true,preview});render(<CaseWorkflows c={c} config={config} busy={false} command={command}/>);
 fireEvent.click(screen.getByRole('button',{name:'Preview message'}));const dialog=await screen.findByRole('dialog',{name:'Email preview'});
 expect(await within(dialog).findByText('Reviewed fictional subject')).toBeVisible();expect(within(dialog).getByText('Fictional person')).toBeVisible();expect(within(dialog).getByText('Fictional manager')).toBeVisible();expect(within(dialog).getByText(/Fictional letter/)).toBeVisible();expect(within(dialog).getByLabelText('File (up to 10 MB)')).toBeVisible();expect(within(dialog).getByRole('button',{name:'Send email'})).toBeDisabled();expect(command).not.toHaveBeenCalled();
});
it('opens per-person email editing immediately and saves through the existing case command',async()=>{
 const {c,config,preview,email}=mailFixture(),command=vi.fn().mockResolvedValue({ok:true});vi.mocked(readV9Email).mockResolvedValueOnce({ok:true,preview});render(<CaseWorkflows c={c} config={config} busy={false} command={command}/>);
 fireEvent.click(screen.getByRole('button',{name:'Edit for this person'}));expect(await screen.findByLabelText('Subject')).toHaveValue('Subject for {employee.name}');fireEvent.change(screen.getByLabelText('Message'),{target:{value:'Only this person'}});fireEvent.click(screen.getByRole('button',{name:'Save for this person'}));expect(command).toHaveBeenCalledExactlyOnceWith({type:'emailEdit',emailId:email.id,subject:'Subject for {employee.name}',body:'Only this person'});
});
it('keeps closed cases from editing or testing email while retaining read-only preview',()=>{
 const {c,config}=mailFixture(),command=vi.fn();c.state='cancelled';render(<CaseWorkflows c={c} config={config} busy={false} command={command}/>);expect(screen.getByRole('button',{name:'Edit for this person'})).toBeDisabled();expect(screen.getByRole('button',{name:'Send test'})).toBeDisabled();expect(screen.getByRole('button',{name:'Preview message'})).toBeEnabled();fireEvent.click(screen.getByRole('button',{name:'Send test'}));expect(command).not.toHaveBeenCalled();
});
it('opens the selected workflow from an already-mounted offboarding case and clears the selected case',async()=>{
 const {c,config}=fixture();const initial:Parameters<typeof V9Workspace>[0]['initial']={config,cases:[c],actor:{id:'hr',name:'Fictional HR'},canConfigure:true,personnelWritableKeys:[],permissions:{onboarding:false,offboarding:true,administration:true},options:{users:[],companies:[],employees:[],labels:{}}};
 render(<NextIntlClientProvider locale="en" messages={messages}><V9Workspace initial={initial} viewer={{name:'Fictional HR',employeeCode:null,employed:false}}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Fictional person'}));expect(screen.getByRole('button',{name:/Back to list/})).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'Open workflow'}));expect(await screen.findByRole('heading',{name:'Workflows',level:1})).toBeVisible();expect(screen.queryByRole('button',{name:/Back to list/})).not.toBeInTheDocument();expect(within(screen.getByRole('dialog',{name:'Edit workflow'})).getByLabelText('Workflow name')).toHaveValue('Fictional manual workflow');
});
