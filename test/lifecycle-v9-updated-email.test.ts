import {expect,it} from 'vitest';
import * as M from '../lib/lifecycle-v9-model';
import {v9Defaults} from '../lib/lifecycle-v9-defaults';
import {fictionalV9Case} from './fixtures/lifecycle-v9/case';
function fixture(){let sequence=0;const c=fictionalV9Case(),config=v9Defaults();config.emails=[{id:'updated',name:'Fictional update',module:'off',active:true,sender:'hr',subject:'Original subject',body:'Original body',cc:[],links:[],attachments:[],slots:[]}];const env:M.Environment={today:'2026-10-30',now:'2026-10-30T00:00:00Z',actor:{id:'hr',name:'Fictional HR'},nextId:()=>`updated-${++sequence}`,onLeave:()=>false,openLoad:()=>0,lastAssigned:()=>0,eligibleUser:()=>true,userName:id=>id,mergeValues:{'employee.name':c.facts.name},requireDeliveryAck:true};return {c,config,env};}
it('plans the current copy and recipient without changing the old intent or case',()=>{
 const {c,config,env}=fixture();M.queueEmail(c,config,'updated',env);const original=c.mails[0];original.status='failed';original.failure='smtpRejected';c.emailEdits={updated:{subject:'Reviewed subject',body:'Reviewed current copy'}};c.facts.employeeUserId='new-linked-employee';const before=JSON.stringify({c,config});
 const plan=M.updatedDeliveryPlan(c,config,original.id,env);expect(JSON.stringify({c,config})).toBe(before);expect(plan.mail).toMatchObject({subject:'Reviewed subject',body:'Reviewed current copy',to:['new-linked-employee'],retryOf:original.id,retryMode:'updated',status:'pending'});expect(plan.case.mails[0]).toEqual(original);
 original.status='uncertain';expect(()=>M.updatedDeliveryPlan(c,config,original.id,env)).toThrow('cannot be replaced');
});
it('keeps a replacement on the original frozen workflow chain and never repeats it on resume',()=>{
 const {c,config,env}=fixture();const workflow:M.Workflow={id:'flow',name:'Fictional flow',module:'off',status:'published',trigger:{event:'manual',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'email',type:'email',template:'updated',to:'employee',cc:[]}],description:''};config.workflows=[workflow];M.runWorkflow(c,config,workflow,env,'manual');const original=c.mails[0];original.status='failed';original.failure='smtpRejected';c.emailEdits={updated:{subject:'New subject',body:'New copy'}};
 const plan=M.updatedDeliveryPlan(c,config,original.id,env);M.markDelivered(plan.case,plan.mail.id,env);expect(M.runWorkflow(plan.case,config,workflow,env,'resume')?.status).toBe('done');expect(plan.case.mails).toHaveLength(2);expect(plan.case.mails[0].status).toBe('failed');expect(()=>M.updatedDeliveryPlan(plan.case,config,original.id,env)).toThrow('cannot be replaced');
});
