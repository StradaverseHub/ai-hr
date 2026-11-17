import {describe,it,expect} from 'vitest';
import {synchronizeResignationLastDay,type Case,type Task,type Item} from '../lib/lifecycle-v9-model';
const env={actor:{id:'verified-owner',name:'Verified owner'},now:'2026-11-17T05:00:00Z',nextId:()=> 'correction-log'};
function fixture(){
 const task=(id:string,status:Task['status']):Task=>({id,name:id,by:'employee',group:null,mode:'manual',opens:-5,due:-1,required:true,documentTemplate:null,documentAction:'completed',opensOn:'2026-12-05',dueOn:'2026-12-09',assignee:'employee',status,reason:'',assignmentFailure:null});
 const item=(id:string,dueDay:number|null,status:Item['status']):Item=>({id,name:id,kind:'device',sourceId:null,group:'configured-group',assignee:'existing-assignee',method:'manual',dueDay,dueOn:'2026-12-09',status,reason:''});
 const c:Case={version:9,id:'off-case',number:'OFB9-0001',module:'off',revision:7,state:'submitted',facts:{name:'Fictional employee',employeeNo:'E1',employmentId:'employment',personId:'employee-person',company:'company',businessGroup:'bg',department:'department',grade:'grade',title:'title',employmentType:'full_time',caseType:'Resignation',joinDate:'2026-01-01',lastDay:'2026-12-10',noticeDate:'2026-11-10',employeeUserId:'employee',supervisorUserId:'manager',pbpUserId:null,taUserId:null},checklistId:'checklist',checklistName:'Clearance',override:'automatic',tasks:[task('open','progress'),task('finished','done')],items:[item('relative',-1,'progress'),item('absolute',null,'todo'),item('completed',0,'done')],documents:[],runs:[],mails:[],files:[],pmChanges:[],log:[],sourceRevision:'personnel-source',submittedAt:'2026-11-10T00:00:00Z',closedAt:null,closedBy:null,closeReason:'',cancelReason:'',revokeDate:'2026-12-10',finalFigures:null,review:{firstAt:env.now,open:2,overdue:0,notReturned:0,detail:'Previous review'},returnAnchor:'2026-12-10'};
 return Object.assign(c,{resignationSourceCaseId:'journey'});
}
describe('managed resignation last-working-day projection',()=>{
 it('moves unresolved relative dates while preserving completed work, manual absolute dates and assignments',()=>{
  const c=fixture(),completed=structuredClone(c.tasks[1]),absolute=structuredClone(c.items[1]),doneItem=structuredClone(c.items[2]);
  synchronizeResignationLastDay(c,'2026-12-10','2026-12-20','2026-12-20',env);
  expect(c.facts.lastDay).toBe('2026-12-20');expect(c.revokeDate).toBe('2026-12-20');expect(c.returnAnchor).toBe('2026-12-20');
  expect(c.tasks[0]).toMatchObject({dueOn:'2026-12-19',opensOn:'2026-12-15',status:'progress',assignee:'employee'});expect(c.tasks[1]).toEqual(completed);
  expect(c.items[0]).toMatchObject({dueOn:'2026-12-19',method:'manual',assignee:'existing-assignee',group:'configured-group'});expect(c.items[1]).toEqual(absolute);expect(c.items[2]).toEqual(doneItem);
  expect(c.review).toBeNull();expect(c.finalFigures).toBeNull();expect(c.log.at(-1)).toMatchObject({actor:env.actor,action:'case.resignationLastDaySynchronized'});
 });
 it('keeps explicit revoke dates and rejects stale, closed or unmanaged sources without changing them',()=>{
  const c=fixture();c.revokeMode='date';c.revokeDate='2026-12-08';synchronizeResignationLastDay(c,'2026-12-10','2026-12-20','2026-12-20',env);expect(c.revokeDate).toBe('2026-12-08');
  for(const kind of ['stale','closed','unmanaged'] as const){const other=fixture();if(kind==='closed')other.state='cleared';if(kind==='unmanaged')delete (other as Case&{resignationSourceCaseId?:string}).resignationSourceCaseId;const before=structuredClone(other);expect(()=>synchronizeResignationLastDay(other,kind==='stale'?'2026-12-11':'2026-12-10','2026-12-20','2026-12-20',env)).toThrow();expect(other).toEqual(before);}
 });
});
