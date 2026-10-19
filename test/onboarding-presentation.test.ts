import { describe,it,expect } from 'vitest';
import { blankCase,defaultConfig,dayDate,submitCase,cancelCase,requisitionItemCounts,currentReq,fulfil } from '../lib/onboarding-model';
import { onboardingBreakdown,onboardingNextStep,onboardingRelative,onboardingDate } from '../lib/onboarding-presentation';
import { todayInKualaLumpur } from '../lib/hr-date';
const today=todayInKualaLumpur(), join=dayDate(today,5);
const actor={id:'hr',name:'Fictional HR',module:true,hr:true,master:false};
function fixture(){let seq=0;const env={today,now:new Date().toISOString(),id:()=>String(++seq),nextNumber:()=> 'IT-'+(++seq),leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:['hr']};const config=defaultConfig('hr'),c=blankCase('case','OB-current','draft',{fullName:'Fictional Joiner',joinDate:join,title:'title',department:'department',company:'company',supervisor:'hr'},env);c.hiring='new_hire';return {config,c,env};}
describe('onboarding presentation follows current stored work and product dates',()=>{
 it('derives pending submission from the actual joining date without creating work',()=>{const {config,c}=fixture(),before=structuredClone(c);expect(onboardingNextStep(config,c)).toMatchObject({name:'Submit the onboarding case',due:dayDate(join,-7)});expect(c).toEqual(before);expect(c.tasks).toHaveLength(0);expect(c.requisitions).toHaveLength(0);});
 it('derives next action and progress from the live checklist and handover policy',()=>{const {config,c,env}=fixture();config.checklists[0]!.tasks=[{id:'welcome',name:'Prepare welcome',by:'manager',group:'',method:'manual',opens:null,due:1,gate:false}];submitCase(config,c,actor,env);expect(onboardingBreakdown(config,c)).toMatchObject({next:{name:'Prepare welcome',due:join},done:0,total:1});c.tasks[0]!.status='done';expect(onboardingNextStep(config,c).name).toBe('Equipment and access ready for Day 1');config.countEquipment=false;expect(onboardingBreakdown(config,c)).toMatchObject({percent:100,next:{name:'All done'}});expect(c.tasks).toHaveLength(1);});
 it('keeps cancelled work visible as history without suggesting current work',()=>{const {config,c,env}=fixture();submitCase(config,c,actor,env);cancelCase(c,'Candidate declined',actor,env);expect(onboardingNextStep(config,c)).toMatchObject({name:'No further action',due:''});expect(c.requisitions).toHaveLength(1);expect(c.history.some(x=>x.action==='case.cancelled')).toBe(true);});
 it('uses the supplied current date and locale rather than the prototype clock',()=>{expect(onboardingRelative(dayDate(today,2),today,'en')).toBe('tomorrow');expect(onboardingRelative(dayDate(today,1),dayDate(today,1),'en')).toBe('today');expect(onboardingDate('not-a-date')).toBe('Date needed');expect(onboardingRelative('',today)).toBe('');});
 it('counts pending approvals in requested items without counting them as ready',()=>{
  const {config,c,env}=fixture();config.groups.find(g=>g.id==='group-tech')!.members=['hr'];
  config.workflows=[{id:'approval',name:'Approval',mode:'seq',steps:[{id:'step',label:'Review',type:'person',target:'hr',method:'manual'}]}];
  config.catalogue=[{id:'direct',name:'Direct',type:'system',active:true,rules:{},workflow:null,team:'group-tech',card:false},{id:'approval-item',name:'Needs approval',type:'system',active:true,rules:{},workflow:'approval',team:'group-tech',card:false}];c.selected=['direct','approval-item'];submitCase(config,c,actor,env);
  const r=currentReq(c)!;expect(requisitionItemCounts(r)).toEqual({ready:0,total:2});fulfil(config,c,r.items.find(i=>i.catalogueId==='direct')!.id,'done',actor,env);expect(requisitionItemCounts(r)).toEqual({ready:1,total:2});
  r.items.find(i=>i.catalogueId==='approval-item')!.approval='withdrawn';expect(requisitionItemCounts(r)).toEqual({ready:1,total:1});
 });
});
