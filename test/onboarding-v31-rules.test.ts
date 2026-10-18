import { describe,it,expect,beforeEach } from 'vitest';
import * as M from '../lib/onboarding-model';
import { onboardingCommandSchema,onboardingConfigSchema } from '../lib/onboarding-validation';
let config:M.Config,c:M.Case,env:M.Environment;
const hr:M.Actor={id:'sarah',name:'Sarah',module:true,hr:true,master:false};
const tech:M.Actor={id:'kevin',name:'Kevin',module:false,hr:false,master:false};
const aina:M.Actor={...tech,id:'aina',name:'Aina'};
const approver:M.Actor={...tech,id:'raj',name:'Raj'};
function cat(id:string,patch:Partial<M.Catalogue>={}):M.Catalogue{return {id,name:id,type:'system',active:true,rules:{},workflow:null,team:'group-tech',card:false,...patch};}
function template(id:string,patch:Partial<M.TaskDef>={}):M.TaskDef{return {id,name:id,by:'group',group:'people-gbs',method:'rr',opens:null,due:1,gate:false,...patch};}
beforeEach(()=>{
 let n=0;env={now:'2030-04-01T02:00:00.000Z',today:'2030-04-01',id:()=>String(++n),nextNumber:()=> 'IT-REQ-'+String(++n),leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:['sarah','farid','kevin','aina','raj','mei','hafiz','nadia']};
 config=M.defaultConfig(hr.id);config.groups.find(g=>g.id==='people-gbs')!.members=['sarah','farid'];config.groups.find(g=>g.id==='group-tech')!.members=['kevin','aina'];config.groups.find(g=>g.id==='tech-bp')!.members=['raj'];config.groups.find(g=>g.id==='facility')!.members=['nadia'];
 config.catalogue=[cat('M365'),cat('VPN',{rules:{businessGroup:['manufacturing']},workflow:'standard'}),cat('AutoCAD'),cat('Access card',{type:'device',team:'facility',card:true})];
 c=M.blankCase('case-1','OB-2030-0001','draft-1',{fullName:'Haziq',joinDate:'2030-04-05',company:'company-a',businessGroup:'manufacturing',title:'analyst',department:'finance'},env);
 c.local.supervisor='boss';c.hiring='new_hire';
});
describe('V3.1 intake, selection and checklist rules',()=>{
 it('locks only Personnel-supplied values, with HR-only fields independently guarded',()=>{
  expect(()=>M.saveCase(config,c,{local:{fullName:'Changed'}},hr,env)).toThrow('Personnel');
  M.saveCase(config,c,{local:{employeeId:'E001',costCentre:'cost-1'}},hr,env);
  expect(M.effectiveFacts(c).employeeId).toBe('E001');
  expect(()=>M.saveCase(config,c,{local:{ic:'secret'}},{...hr,hr:false},env)).toThrow('HR');
 });
 it('offers only active entries matching every populated dimension',()=>{
  const f=M.effectiveFacts(c);
  expect(M.matches({businessGroup:['construction','manufacturing'],department:['finance']},f)).toBe(true);
  expect(M.matches({businessGroup:['construction'],department:[]},f)).toBe(false);
  expect(M.matches({},f)).toBe(true);
 });
 it('allows incomplete pending save but blocks submission with named missing fields',()=>{
  c.hiring='';delete c.local.supervisor;M.saveCase(config,c,{notes:'Preparing'},hr,env);
  expect(()=>M.submitCase(config,c,hr,env)).toThrow('Supervisor, New hire or replacement');
  expect(c.requisitions).toHaveLength(0);
 });
 it('requires replacement name, valid optional email and exception reason',()=>{
  c.hiring='replacement';expect(()=>M.validateCase(config,c)).toThrow('Employee being replaced');
  c.replacedEmployee='Previous employee';c.local.email='bad';expect(()=>M.validateCase(config,c)).toThrow('email');
  c.local.email='';c.extras=[{catalogueId:'AutoCAD',reason:'',approval:false}];expect(()=>M.validateCase(config,c)).toThrow('reason');
 });
 it('ranks dimensions, preserves oldest tie break, supports manual None',()=>{
  config.checklists.push({id:'specific',name:'Specific',owner:'sarah',createdAt:'2029-01-01T00:00:00.000Z',rules:{company:['company-a'],department:['finance']},tasks:[]});
  config.checklists.push({...structuredClone(config.checklists[1]!),id:'newer',createdAt:'2030-01-01T00:00:00.000Z'});
  expect(M.matchChecklist(config,c)).toMatchObject({checklist:{id:'specific'},tie:true});
  c.checklistOverride='none';expect(M.matchChecklist(config,c)).toMatchObject({checklist:null,manual:true});
 });
 it('assigns by due-date leave, load, recency and limit, storing failure',()=>{
  config.checklists[0]!.tasks=[template('pack'),template('safety',{group:'facility'})];
  env.leave.farid=['2030-04-05'];env.leave.nadia=['2030-04-05'];
  M.submitCase(config,c,hr,env);
  expect(c.tasks[0]?.assignee).toBe('sarah');expect(c.tasks[1]?.assignee).toBeNull();expect(c.tasks[1]?.failure).toContain('2030-04-05');
  expect(c.history.some(h=>h.action==='task.assignment_failed')).toBe(true);
 });
 it('balances equal loads with least recent automatic assignment',()=>{
  config.checklists[0]!.tasks=[template('pack')];env.lastTaskAssignment={sarah:'2030-03-30',farid:'2030-03-01'};
  M.submitCase(config,c,hr,env);expect(c.tasks[0]?.assignee).toBe('farid');
 });
 it('creates exactly one requisition on submission and no artificial IT task',()=>{
  c.selected=['M365','Access card'];M.submitCase(config,c,hr,env);M.submitCase(config,c,hr,env);
  expect(c.requisitions).toHaveLength(1);expect(c.tasks).toHaveLength(0);
  expect(M.currentReq(c)?.items).toHaveLength(2);expect(M.currentReq(c)?.items[1]).toMatchObject({stage:'facility',team:'facility',state:'todo'});
 });
 it('blocks stale nonmatching selections and duplicates across selection and extras',()=>{
  c.selected=['VPN'];config.catalogue.find(i=>i.id==='VPN')!.rules={company:['other']};expect(()=>M.submitCase(config,c,hr,env)).toThrow('no longer matches');
  c.selected=['AutoCAD'];c.extras=[{catalogueId:'AutoCAD',reason:'needed',approval:false}];expect(()=>M.validateCase(config,c)).toThrow('once');
 });
});
describe('V3.1 per-item approval precedence and resolution',()=>{
 function request(id='VPN',approval=true){c.extras=[{catalogueId:id,reason:'For role',approval}];M.submitCase(config,c,hr,env);return M.currentReq(c)!.items[0]!;}
 it('uses mandatory item workflow even when exception approval is disabled',()=>{
  config.exceptions.workflow=null;const i=request('VPN',false);expect(i.approval).toBe('pending');expect(i.workflowId).toBe('standard');
 });
 it('starts unflagged unticked AutoCAD exception directly To do',()=>{
  const i=request('AutoCAD',false);expect(i).toMatchObject({approval:'none',state:'todo',source:'exception',reason:'For role',fromCase:true});
 });
 it('resolves routing by specificity and group leave fallback',()=>{
  config.groups.push({id:'manufacturing',name:'Manufacturing',members:['mei','hafiz'],limit:4});
  config.routings=[{id:'bp-routing',name:'Tech BP routing',rows:[{id:'default',rules:{},group:'tech-bp'},{id:'manufacturing',rules:{businessGroup:['manufacturing']},group:'manufacturing'}]}];
  config.workflows[0]!.steps=[{id:'route',label:'Tech BP',type:'routing',target:'bp-routing',method:'rr'}];
  env.leave.mei=[env.today];env.leave.hafiz=[env.today];const i=request();
  expect(i.steps[0]).toMatchObject({group:'tech-bp',user:'raj',viaDefault:'Manufacturing'});
 });
 it('uses one approver for same group across items and supports a batch',()=>{
  config.catalogue.push(cat('SAP',{workflow:'standard'}));c.selected=['VPN','SAP'];M.submitCase(config,c,hr,env);
  const items=M.currentReq(c)!.items;expect(items.map(i=>i.steps[0]?.user)).toEqual(['raj','raj']);
  M.decide(config,c,items.map(i=>i.id),'approve',approver,env);expect(items.every(i=>i.approval==='approved')).toBe(true);
 });
 it('manual approval must be assigned before decision, group backup records actual actor',()=>{
  config.groups.find(g=>g.id==='tech-bp')!.members=['mei','hafiz'];config.workflows[0]!.steps[0]!.method='manual';
  const i=request();const mei={...approver,id:'mei'},hafiz={...approver,id:'hafiz'};
  expect(()=>M.decide(config,c,[i.id],'approve',mei,env)).toThrow('not assigned');
  M.assignApproval(config,c,i.id,i.steps[0]!.id,'hafiz',mei,env);
  M.decide(config,c,[i.id],'approve',mei,env);expect(i.steps[0]).toMatchObject({user:'hafiz',by:'mei',status:'approved'});
 });
 it('sequential chains cannot skip and parallel chains permit independent pending steps',()=>{
  config.workflows[0]!.steps.push({id:'person-2',label:'Second approval',type:'person',target:'mei',method:'rr'});
  const i=request();expect(()=>M.decide(config,c,[i.id],'approve',{...approver,id:'mei'},env)).toThrow();
  M.decide(config,c,[i.id],'approve',approver,env);expect(i.approval).toBe('pending');
  M.decide(config,c,[i.id],'approve',{...approver,id:'mei'},env);expect(i.approval).toBe('approved');
 });
 it('automatically approves requester step with explicit audit, retaining other required approval',()=>{
  config.groups.find(g=>g.id==='tech-bp')!.members=['sarah'];
  config.workflows[0]!.steps.push({id:'independent',label:'Independent',type:'person',target:'raj',method:'rr'});
  const i=request();expect(i.steps[0]?.status).toBe('approved');expect(i.approval).toBe('pending');expect(c.history.some(h=>h.action==='approval.auto_approved')).toBe(true);
 });
 it('rejects immediately on a rejected parallel step',()=>{
  config.workflows[0]!.mode='par';config.workflows[0]!.steps.push({id:'second',label:'Second',type:'person',target:'mei',method:'rr'});
  const i=request();M.decide(config,c,[i.id],'reject',{...approver,id:'mei'},env);expect(i.approval).toBe('rejected');expect(M.activeItem(i)).toBe(false);
 });
 it('withdraws only removed HR extra and preserves Group Tech additions',()=>{
  c.extras=[{catalogueId:'AutoCAD',reason:'Design',approval:true},{catalogueId:'VPN',reason:'Remote',approval:true}];M.submitCase(config,c,hr,env);
  const r=M.currentReq(c)!;M.addItem(config,c,r,cat('printer'),'exception',false,'Manager confirmed',false,null,tech,env);
  const removed=r.items.find(i=>i.catalogueId==='AutoCAD')!;M.saveCase(config,c,{extras:[{catalogueId:'VPN',reason:'Remote',approval:true}]},hr,env);
  expect(removed).toMatchObject({removed:true,approval:'withdrawn'});expect(removed.steps.every(s=>s.status==='withdrawn')).toBe(true);expect(r.items.find(i=>i.catalogueId==='printer')?.removed).toBe(false);expect(r.items.find(i=>i.catalogueId==='VPN')?.approval).toBe('pending');
 });
});
describe('V3.1 fulfilment, gates, progress and retained history',()=>{
 it('claims atomically at command level and refuses another team member, then releases',()=>{
  c.selected=['M365'];M.submitCase(config,c,hr,env);const i=M.currentReq(c)!.items[0]!;
  M.fulfil(config,c,i.id,'progress',tech,env);expect(i.claim).toBe('kevin');expect(()=>M.fulfil(config,c,i.id,'done',aina,env)).toThrow('claimed');
  M.fulfil(config,c,i.id,'todo',tech,env);M.fulfil(config,c,i.id,'done',aina,env);expect(i.state).toBe('ready');expect(i.claim).toBeNull();
 });
 it('hands access card from Facility printing to Tech activation',()=>{
  c.selected=['Access card'];M.submitCase(config,c,hr,env);const i=M.currentReq(c)!.items[0]!;
  expect(()=>M.fulfil(config,c,i.id,'done',tech,env)).toThrow('fulfilling team');
  M.fulfil(config,c,i.id,'done',{...tech,id:'nadia'},env);expect(i).toMatchObject({state:'printed',stage:'tech',team:'group-tech'});
  M.fulfil(config,c,i.id,'done',tech,env);M.handover(config,c,tech,env);expect(M.requisitionStatus(M.currentReq(c)!)).toBe('completed');
 });
 it('distinguishes preparation from handover and reserves equipment progress credit',()=>{
  config.checklists[0]!.tasks=Array.from({length:7},(_,i)=>template('task-'+i));c.selected=['M365'];M.submitCase(config,c,hr,env);
  for(const t of c.tasks.slice(0,5))t.status='done';const r=M.currentReq(c)!;M.fulfil(config,c,r.items[0]!.id,'done',tech,env);
  expect(M.requisitionStatus(r)).toBe('ready');expect(M.progress(config,c).percent).toBeLessThan(75);
  M.handover(config,c,tech,env);expect(M.progress(config,c).percent).toBe(75);config.countEquipment=false;expect(M.progress(config,c).percent).toBe(71);
 });
 it('matches the handoff 43 percent example',()=>{
  config.checklists[0]!.tasks=Array.from({length:5},(_,i)=>template('task-'+i));config.catalogue=Array.from({length:6},(_,i)=>cat('item-'+i));c.selected=config.catalogue.map(i=>i.id);M.submitCase(config,c,hr,env);
  c.tasks.slice(0,2).forEach(t=>{t.status='done';});M.currentReq(c)!.items.slice(0,4).forEach(i=>{i.state='ready';});expect(M.progress(config,c).percent).toBe(43);
 });
 it('opens relative days and blocks acknowledgement task until handover',()=>{
  expect(M.dayDate('2030-04-05',1)).toBe('2030-04-05');expect(M.dayDate('2030-04-05',7)).toBe('2030-04-11');expect(M.dayDate('2030-04-05',-3)).toBe('2030-04-02');expect(()=>M.dayDate('2030-04-05',0)).toThrow('Day 0');
  config.checklists[0]!.tasks=[template('survey',{opens:7,due:14}),template('accept',{gate:true})];M.submitCase(config,c,hr,env);
  expect(()=>M.setTask(config,c,'survey','done',hr,env)).toThrow('opened');expect(()=>M.setTask(config,c,'accept','done',{...hr,id:c.tasks.find(t=>t.id==='accept')!.assignee!},env)).toThrow('handover');
 });
 it('does not complete an empty requisition without an explicit handover',()=>{
  M.submitCase(config,c,hr,env);expect(M.requisitionStatus(M.currentReq(c)!)).toBe('submitted');M.handover(config,c,tech,env);expect(M.requisitionStatus(M.currentReq(c)!)).toBe('completed');
 });
 it('cancels all actionable work and preserves task and requisition generations on reopen/resubmit',()=>{
  config.checklists[0]!.tasks=[template('pack')];c.selected=['M365'];M.submitCase(config,c,hr,env);const first=M.currentReq(c)!.number;c.tasks[0]!.status='done';
  expect(()=>M.cancelCase(c,'',hr,env)).toThrow('reason');M.cancelCase(c,'Candidate declined',hr,env);expect(M.currentReq(c)).toBeNull();expect(c.requisitions[0]?.cancelledAt).toBe(env.now);
  M.reopenCase(c,hr,env);expect(c.taskHistory[0]?.[0]?.status).toBe('done');M.submitCase(config,c,hr,env);expect(M.currentReq(c)!.number).not.toBe(first);expect(c.requisitions).toHaveLength(2);expect(c.history.some(h=>h.action==='case.cancelled')).toBe(true);
 });
 it('rejects work without module, assigned-task or team rights',()=>{
  expect(()=>M.submitCase(config,c,tech,env)).toThrow('access');config.checklists[0]!.tasks=[template('pack')];M.submitCase(config,c,hr,env);expect(()=>M.setTask(config,c,'pack','done',tech,env)).toThrow('assigned');
 });
 it('keeps workflow, checklist and fallback safeguards and rejects malformed wire input',()=>{
  expect(()=>M.validateConfig({...config,workflows:[]})).toThrow('at least');expect(()=>M.validateConfig({...config,checklists:[]})).toThrow('at least');
  expect(onboardingCommandSchema.safeParse({type:'fulfil',itemId:'1',status:'handed'}).success).toBe(false);
  expect(onboardingConfigSchema.safeParse({...config,access:{onboarding:['sarah'],offboarding:[],admin:['attacker']}}).success).toBe(false);
 });
});
