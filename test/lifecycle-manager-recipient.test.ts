import { describe, expect, it } from 'vitest';
import * as M from '../lib/lifecycle-v9-model';
import { managerRecipientResult, type PersonnelManagerRecipient } from '../lib/personnel-manager-recipient';
import { v9Defaults } from '../lib/lifecycle-v9-defaults';

function fixture() {
 let id=0;
 const config=v9Defaults(); config.workflows=[];config.templates=[];config.emails=[];
 const env:M.Environment={today:'2026-11-18',now:'2026-11-18T03:00:00Z',actor:{id:'hr',name:'HR'},nextId:()=>String(++id),onLeave:()=>false,openLoad:()=>0,lastAssigned:()=>0,eligibleUser:()=>false,userName:()=>'',mergeValues:{},supervisorRecipient:{employmentId:'manager-employment',name:'Fictional Manager',email:'manager.work@example.invalid',reason:null}};
 const c:M.Case={version:9,id:'case',number:'OB-TEST',module:'onb',revision:1,state:'submitted',facts:{name:'Fictional Joiner',employeeNo:'',employmentId:'employment',personId:'person',joinDate:'2026-11-20',lastDay:'',noticeDate:'',employeeUserId:null,supervisorUserId:null,taUserId:null,businessGroup:'',company:'',department:'',grade:'',employmentType:'',title:'',caseType:''},checklistId:null,checklistName:'',override:'automatic',tasks:[],items:[],documents:[],runs:[],mails:[],files:[],pmChanges:[],log:[],sourceRevision:'',submittedAt:null,closedAt:null,closedBy:null,closeReason:'',cancelReason:'',revokeDate:'',finalFigures:null,review:null};
 const workflow:M.Workflow={id:'notice',name:'Starts soon',module:'onb',status:'published',trigger:{event:'beforeJoin',days:3,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'email',type:'notify',to:'supervisor',cc:[],subject:'Starts soon',body:'Please prepare'}],description:''};
 config.workflows=[workflow];return{c,config,env,workflow};
}
const missing=(reason:PersonnelManagerRecipient['reason'])=>({employmentId:'manager',name:'Fictional Manager',email:null,reason});
describe('Personnel supervisor mailbox',()=>{
 it('needs no account and resolves again at each enqueue/preview',()=>{
  const {c,config,env,workflow}=fixture();
  expect(M.resolveStepRecipients(c,config,{to:['supervisor'],cc:[]},env)).toEqual({to:[{key:'address:manager.work@example.invalid',name:'Fictional Manager'}],cc:[],missing:[]});
  env.supervisorRecipient={employmentId:'new-manager',name:'New manager',email:'new@example.invalid',reason:null};
  M.runWorkflow(c,config,workflow,env,'date');
  expect(c.mails[0]).toMatchObject({to:['address:new@example.invalid'],delivery:{toNames:['New manager']}});
  expect(c.facts.supervisorUserId).toBeNull();
 });
 it.each(['none','ambiguous','unavailable','inactive','missingEmail','invalidEmail'] as const)('holds %s distinctly without leaking an address',reason=>{
  const {c,config,env}=fixture();env.supervisorRecipient=missing(reason);
  const result=M.resolveStepRecipients(c,config,{to:['supervisor'],cc:[]},env);
  expect(result.to).toEqual([]);expect(result.missing).toHaveLength(1);expect(result.missing[0].reason).not.toContain('@');
  if(reason==='missingEmail')expect(result.missing[0].reason).toBe('Line manager Fictional Manager has no work email');
  if(reason==='inactive')expect(result.missing[0].reason).toBe('Line manager Fictional Manager has inactive employment');
 });
 it('validates the work mailbox and preserves case recipient overrides',()=>{
  expect(managerRecipientResult({...missing(null),email:'bad address'})).toEqual({reason:'Line manager Fictional Manager has an invalid work email'});
  const {c,config,env,workflow}=fixture();
  M.overrideRecipients(c,config,{workflowId:workflow.id,stepId:'email',to:['address:chosen@example.invalid'],cc:[]},env);
  M.runWorkflow(c,config,workflow,env,'date');expect(c.mails[0].to).toEqual(['address:chosen@example.invalid']);
 });
});
describe('late held email decisions',()=>{
 function held(){const f=fixture();f.env.supervisorRecipient=missing('none');M.runWorkflow(f.c,f.config,f.workflow,f.env,'date');expect(f.c.runs[0].hold).toBeDefined();f.env.supervisorRecipient={...missing(null),email:'fixed@example.invalid'};return f;}
 it('requires explicit HR Send anyway after the due day, then captures one delivery',()=>{
  const {c,config,env,workflow}=held();
  expect(M.heldEmailDueOn(c,c.runs[0])).toBe('2026-11-17');
  M.runWorkflow(c,config,workflow,env,'resume',{continueHeld:true});expect(c.mails).toEqual([]);expect(c.runs[0].lateEmail?.dueOn).toBe('2026-11-17');
  M.decideLateEmail(c,config,{workflowId:workflow.id,runId:c.runs[0].id,stepId:'email',decision:'send'},env);
  expect(c.runs[0].status).toBe('done');expect(c.mails).toHaveLength(1);expect(c.log.map(l=>l.action)).toContain('workflow.lateEmailApproved');
  expect(()=>M.decideLateEmail(c,config,{workflowId:workflow.id,runId:c.runs[0].id,stepId:'email',decision:'send'},env)).toThrow(/changed/);
 });
 it('skips only the held email and records the HR decision',()=>{
  const {c,config,env,workflow}=held();M.decideLateEmail(c,config,{workflowId:workflow.id,runId:c.runs[0].id,stepId:'email',decision:'skip'},env);
  expect(c.mails).toEqual([]);expect(c.runs[0]).toMatchObject({status:'done',cursor:1});expect(c.runs[0].hold).toBeUndefined();expect(c.log.at(-2)?.action).toBe('workflow.lateEmailSkipped');
 });
 it('never lets a system sweep choose late send or replay an uncertain delivery',()=>{
  const {c,config,env,workflow}=held();env.actor={id:'system',name:'System'};
  M.runWorkflow(c,config,workflow,env,'resume',{continueHeld:true,lateDecision:{runId:c.runs[0].id,stepId:'email',decision:'send'}});expect(c.mails).toEqual([]);
  expect(()=>M.decideLateEmail(c,config,{workflowId:workflow.id,runId:c.runs[0].id,stepId:'email',decision:'skip'},env)).toThrow(/HR must/);
 });
 it('continues a due-today hold normally and uses frozen workflow/workday dates',()=>{
  const {c,config,env,workflow}=held();env.today='2026-11-17';M.runWorkflow(c,config,workflow,env,'resume',{continueHeld:true});expect(c.mails).toHaveLength(1);
  const frozen=c.runs[0];workflow.trigger.days=10;expect(M.heldEmailDueOn(c,frozen)).toBe('2026-11-17');
 });
});
