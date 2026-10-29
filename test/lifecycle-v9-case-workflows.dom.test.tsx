import {expect,it,vi} from 'vitest';
import {fireEvent,render,screen} from '@testing-library/react';
import {CaseWorkflows} from '../app/lifecycle/v9/case-workflows';
import {v9Defaults} from '../lib/lifecycle-v9-defaults';
import type {Case,Workflow} from '../lib/lifecycle-v9-model';
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
