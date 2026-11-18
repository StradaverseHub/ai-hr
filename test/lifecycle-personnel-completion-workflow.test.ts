import {expect,it} from 'vitest';
import * as M from '../lib/lifecycle-v9-model';
import {v9Defaults} from '../lib/lifecycle-v9-defaults';
import {newV9Template} from '../lib/lifecycle-v9-authoring';

function fixture(ordinaryRequired=false){
 let sequence=0;
 const config=v9Defaults();config.workflows=[];config.emails=[];
 const env:M.Environment={today:'2026-11-17',now:'2026-11-17T03:00:00Z',actor:{id:'hr',name:'Fictional HR'},nextId:()=>String(++sequence),onLeave:()=>false,openLoad:()=>0,lastAssigned:()=>0,eligibleUser:()=>true,userName:()=> 'Fictional employee',mergeValues:{'employee.name':'Fictional employee'},requireDeliveryAck:true,personnelCompletion:{country:'MY',source:{address:''},fingerprint:()=> 'official-source'}};
 const c:M.Case={version:9,id:'case',number:'OB-TEST',module:'onb',revision:1,state:'submitted',facts:{name:'Fictional employee',employeeNo:'',employmentId:'employment',personId:'person',joinDate:'2026-11-20',lastDay:'',noticeDate:'',employeeUserId:'employee',supervisorUserId:null,taUserId:null,businessGroup:'',company:'',department:'',grade:'',employmentType:'',title:'',caseType:''},checklistId:null,checklistName:'',override:'automatic',tasks:[],items:[],documents:[],runs:[],mails:[],files:[],pmChanges:[],log:[],sourceRevision:'source',submittedAt:null,closedAt:null,closedBy:null,closeReason:'',cancelReason:'',revokeDate:'',finalFigures:null,review:null};
 const template=newV9Template('Form',env.actor,'completion',env.now);template.versions[0].state='published';template.versions[0].fields[0]={...template.versions[0].fields[0],id:'address',pmKey:'address',owner:'pmLocked',required:true};template.versions[0].blocks.forEach(block=>{if(block.type==='field')block.fieldId='address';});if(ordinaryRequired){template.versions[0].fields[0].required=false;template.versions[0].fields.push({...template.versions[0].fields[0],id:'ordinary',pmKey:null,owner:'employee',required:true});template.versions[0].blocks.push({id:'ordinary-block',type:'field',fieldId:'ordinary',text:'',section:'main'});}config.templates=[template];
 const workflow:M.Workflow={id:'notice',name:'Original scheduled notice',module:'onb',status:'published',trigger:{event:'beforeJoin',days:3,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'document',type:'doc',template:template.id,release:true},{id:'notice-one',type:'notify',to:'employee',cc:[],subject:'First notice',body:'Original notice'},{id:'notice-two',type:'notify',to:'employee',cc:[],subject:'Second notice',body:'Original second notice'}],description:''};config.workflows=[workflow];
 M.runWorkflow(c,config,workflow,env,'date');
 expect(c.runs[0].status).toBe('waiting');expect(c.documents[0].personnelCompletion?.preparation).toBeDefined();expect(c.mails).toEqual([]);
 return {c,config,env,workflow};
}
function ready(f:ReturnType<typeof fixture>){const d=f.c.documents[0];d.values.address='Fictional completed address';d.personnelCompletion!.submitted={at:f.env.now,by:{id:'employee',name:'Fictional employee'},sourceFingerprint:'official-source'};}
it('retains the original due date through unsigned preparation and adjudicates each later uncaptured message',()=>{
 const f=fixture(),{c,config,env,workflow}=f,hold=structuredClone(c.runs[0].completionHold);expect(hold).toEqual({documentId:c.documents[0].id,stepId:'document',dueOn:'2026-11-17',at:env.now});
 ready(f);env.today='2026-11-18';env.now='2026-11-18T03:00:00Z';c.facts.joinDate='2026-12-20';
 M.runWorkflow(c,config,workflow,env,'resume');expect(c.mails).toEqual([]);expect(c.runs[0].lateEmail).toMatchObject({stepId:'notice-one',dueOn:'2026-11-17'});expect(c.runs[0].completionHold).toEqual(hold);
 M.decideLateEmail(c,config,{workflowId:workflow.id,runId:c.runs[0].id,stepId:'notice-one',decision:'send'},env);
 expect(c.mails).toHaveLength(1);expect(c.runs[0].lateEmail).toBeUndefined();expect(c.runs[0].reason).toContain('delivery confirmation');
 c.mails[0].status='sent';M.runWorkflow(c,config,workflow,env,'resume');expect(c.mails).toHaveLength(1);expect(c.runs[0].lateEmail?.stepId).toBe('notice-two');
 M.decideLateEmail(c,config,{workflowId:workflow.id,runId:c.runs[0].id,stepId:'notice-two',decision:'skip'},env);expect(c.runs[0].status).toBe('done');expect(c.runs[0].completionHold).toBeUndefined();expect(c.mails).toHaveLength(1);
});
it('queues on-time completion once and preserves a future original due day',()=>{
 const f=fixture();ready(f);f.c.runs[0].completionHold!.dueOn='2026-11-20';
 M.runWorkflow(f.c,f.config,f.workflow,f.env,'resume');expect(f.c.mails).toEqual([]);expect(f.c.runs[0].resumeOn).toBe('2026-11-20');
 f.env.today='2026-11-20';M.runWorkflow(f.c,f.config,f.workflow,f.env,'resume');expect(f.c.mails).toHaveLength(1);expect(f.c.runs[0].lateEmail).toBeUndefined();M.runWorkflow(f.c,f.config,f.workflow,f.env,'resume');expect(f.c.mails).toHaveLength(1);
});
it('holds unknown dates and never treats an uncertain receipt as permission to replay',()=>{
 const f=fixture();ready(f);f.c.runs[0].completionHold!.dueOn=null;M.runWorkflow(f.c,f.config,f.workflow,f.env,'resume');expect(f.c.mails).toEqual([]);expect(f.c.runs[0].reason).toContain('scheduled date is unavailable');
 f.c.runs[0].completionHold!.dueOn='2026-11-16';M.runWorkflow(f.c,f.config,f.workflow,f.env,'resume');const input={workflowId:f.workflow.id,runId:f.c.runs[0].id,stepId:'notice-one',decision:'send' as const};M.decideLateEmail(f.c,f.config,input,f.env);f.c.mails[0].status='uncertain';
 M.runWorkflow(f.c,f.config,f.workflow,f.env,'resume');expect(f.c.mails).toHaveLength(1);expect(f.c.runs[0].reason).toContain('uncertain');expect(()=>M.decideLateEmail(f.c,f.config,input,f.env)).toThrow();
});
it('resumes the reviewed second frozen run without consuming an earlier run of the same workflow',()=>{
 const f=fixture();ready(f);const first=structuredClone(f.c.runs[0]),second=structuredClone(first);second.id='reviewed-second-run';f.c.runs.push(second);
 M.runWorkflow(f.c,f.config,f.workflow,f.env,'resume',{resumeRunId:second.id});expect(f.c.runs[0]).toEqual(first);expect(f.c.mails).toHaveLength(1);expect(f.c.mails[0].key).toBe('reviewed-second-run:notice-one:main');
});

it('opens unsigned preparation for required ordinary employee answers when a new policy also contains an optional Personnel field',()=>{
 const f=fixture(true);expect(f.c.documents[0].personnelCompletion?.preparation).toBeDefined();expect(f.c.documents[0].sentAt).toBeNull();expect(f.c.runs[0]).toMatchObject({status:'waiting',cursor:0});expect(f.c.mails).toEqual([]);
});
