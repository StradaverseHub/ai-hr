import {expect,it} from 'vitest';
import {advanceAutomationRun,newAutomationRun,resumeAutomationRun,type AutomationExecutors} from '../lib/automation/runtime';
import type {AutomationWorkflow} from '../lib/automation/workflow';
it('retains the exact held email step, retries it once after its resource is ready, and never repeats previous effects',async()=>{
 const workflow:AutomationWorkflow={id:'workflow',name:'Fictional email',module:'probation',status:'live',required:false,description:'',trigger:{event:'caseOpened',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:'before',type:'notify',conditions:[],to:[],cc:[],params:{}},{id:'email',type:'sendEmail',conditions:[],to:[],cc:[],params:{}},{id:'after',type:'notify',conditions:[],to:[],cc:[],params:{}}]};
 let ready=false;const calls:string[]=[];
 const executors:AutomationExecutors={notify:async({step})=>{calls.push(step.id);return {status:'done'};},sendEmail:async()=>{calls.push('email');return ready?{status:'done'}:{status:'hold',resourceId:'email-resource',message:'Upload Fictional file'};},notifyFailure:async()=>{throw new Error('not a failure');}};
 const deps={executors,read:()=>undefined,now:()=>new Date('2026-11-18T00:00:00Z').toISOString()};
 const initial=newAutomationRun({id:'run',workflow,revision:1,subjectId:'case',eventKey:'event',skipped:null,at:deps.now()});
 const held=await advanceAutomationRun(initial,deps);
 expect(held.status).toBe('waiting');expect(held.remaining.map(item=>item.step.id)).toEqual(['email','after']);expect(held.log.at(-1)?.message).toBe('Upload Fictional file');expect(calls).toEqual(['before','email']);
 expect(await resumeAutomationRun(held,'wrong-resource',deps)).toBe(held);
 ready=true;const complete=await resumeAutomationRun(held,'email-resource',deps);
 expect(complete.status).toBe('done');expect(calls).toEqual(['before','email','email','after']);expect(await resumeAutomationRun(complete,'email-resource',deps)).toBe(complete);
});
