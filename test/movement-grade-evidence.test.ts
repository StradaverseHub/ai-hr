import {describe,it,expect} from 'vitest';
import {movementGradeEvidence} from '../lib/movement-grade-evidence';
type Event=Parameters<typeof movementGradeEvidence>[0][number];
type Row=Parameters<typeof movementGradeEvidence>[1][number];
const time=new Date('2026-11-18T03:00:00Z');
const grade=(id:string,sequence:number,before:string|null,after:string|null,group=id,secondary=false):Event=>({id,eventType:'employment.grade.changed',sequence,occurredAt:time,actorId:'hr',payload:{before,after,movement:{type:'promotion',groupId:group,secondary}}});
const row=(id:string,on:string,status='applied',group=id):Row=>({id,kind:'promotion',groupId:group,effectiveDate:on,status});
const correction=(id:string,sequence:number,from:string,after:string|null,until?:string,replaces:number[]=[],before:string|null='A'):Event=>({id,sequence,eventType:'employment.information.corrected',occurredAt:time,actorId:'hr',payload:{fields:['gradeId'],effectiveOn:from,before:{gradeId:before},after:{gradeId:after},...(until?{until:{gradeId:until}}:{}),replacedCorrectionSequences:replaces}});
const reversal=(source:string,sequence:number,inverseGroup?:string):Event=>({id:'undo-'+source,sequence,eventType:'employment.movement.reversed',occurredAt:time,actorId:'hr',payload:{movementId:source,...(inverseGroup?{reversalGroupId:inverseGroup}:{})}});
const values=(evidence:ReturnType<typeof movementGradeEvidence>,...dates:string[])=>dates.map(date=>evidence.at(date));
const known=(gradeId:string|null)=>({gradeId,gradeKnown:true});

describe('canonical business-date grade evidence',()=>{
 it('uses deliberate Effective Date, never current grade or entry order',()=>{
  const ordered=movementGradeEvidence([grade('later',3,'B','C'),grade('earlier',2,'A','B')],[row('earlier','2026-03-01'),row('later','2026-06-01')],'WRONG CURRENT');
  expect(values(ordered,'2026-02-28','2026-03-01','2026-05-31','2026-06-01')).toEqual([known('A'),known('B'),known('B'),known('C')]);
 });
 it('does not apply a reversed grade decision and verifies its legacy inverse as technical restoration',()=>{
  const events=[grade('original',1,'A','B'),grade('inverse',2,'B','A','inverse-group',true),reversal('original',3)];
  const evidence=movementGradeEvidence(events,[row('original','2026-03-01','reversed')],'WRONG CURRENT');
  expect(values(evidence,'2026-02-28','2026-03-01','2026-11-18')).toEqual([known('A'),known('A'),known('A')]);
 });
 it('uses an explicit inverse group for new reversals and retains exact blank restoration',()=>{
  const events=[grade('original',1,null,'B'),grade('inverse',2,'B',null,'inverse-group',true),reversal('original',3,'inverse-group')];
  expect(movementGradeEvidence(events,[row('original','2026-03-01','reversed')],'WRONG CURRENT').at('2026-04-01')).toEqual(known(null));
 });
 it('restores a corrected original predecessor at the original movement boundary, not undo entry day',()=>{
  const original=grade('original',1,'A','B'),fixed=correction('hire-correction',2,'2026-01-01','C','2026-03-01');
  fixed.payload={...(fixed.payload as object),source:'original-hire'};
  const events=[original,fixed,grade('inverse',3,'B','C','inverse-group',true),reversal('original',4)];
  const evidence=movementGradeEvidence(events,[row('original','2026-03-01','reversed')],'WRONG CURRENT');
  expect(values(evidence,'2025-12-31','2026-02-01','2026-03-01','2026-04-01')).toEqual([known('A'),known('C'),known('C'),known('C')]);
 });
 it('supports temporary rollback/replay while correcting an earlier movement',()=>{
  const events=[grade('first',1,'A','B'),grade('later',2,'B','C'),grade('undo-later',3,'C','B','undo-later-group',true),reversal('later',4),grade('undo-first',5,'B','A','undo-first-group',true),reversal('first',6),grade('replacement',7,'A','D'),grade('replay',8,'D','C')];
  const rows=[row('first','2026-03-01','reversed'),row('later','2026-06-01','reversed'),row('replacement','2026-03-01'),row('replay','2026-06-01')];
  expect(values(movementGradeEvidence(events,rows,'WRONG CURRENT'),'2026-02-01','2026-04-01','2026-07-01')).toEqual([known('A'),known('D'),known('C')]);
 });
 it('refuses unrelated, ambiguous, wrong-actor and wrong-delta secondary legs',()=>{
  const original=grade('original',1,'A','B'),inverse=grade('inverse',2,'B','A','inverse-group',true),marker=reversal('original',4);
  for(const events of [[original,inverse],[original,inverse,grade('duplicate',3,'B','A','other-group',true),marker],[original,{...inverse,actorId:'other'},marker],[original,grade('wrong',2,'B','WRONG','inverse-group',true),marker]]){
   expect(movementGradeEvidence(events,[row('original','2026-03-01','reversed')],'A').at('2026-01-01')).toEqual({gradeId:null,gradeKnown:false});
  }
 });
 it('does not treat an arbitrary untagged grade write as a dated fact',()=>{
  const event=grade('unattributed',1,'A','B');event.payload={before:'A',after:'B'};
  expect(movementGradeEvidence([event],[],'B').at('2026-03-01')).toEqual({gradeId:null,gradeKnown:false});
 });
 it('honours a field-specific half-open correction span and retains the later deliberate decision',()=>{
  const move=grade('movement',1,'A','B'),fix=correction('correction',2,'2026-01-01','C','2026-03-01');
  const evidence=movementGradeEvidence([move,fix],[row('movement','2026-03-01')],'WRONG CURRENT');
  expect(values(evidence,'2025-12-31','2026-01-01','2026-02-28','2026-03-01')).toEqual([known('A'),known('C'),known('C'),known('B')]);
 });
 it('keeps a later movement authoritative even for a legacy correction without an until field',()=>{
  const move=grade('movement',1,'A','B'),fix=correction('correction',2,'2026-01-01','C');
  expect(values(movementGradeEvidence([move,fix],[row('movement','2026-03-01')],'WRONG CURRENT'),'2026-02-01','2026-04-01')).toEqual([known('C'),known('B')]);
 });
 it('applies corrections in saved order and suppresses replaced grade correction revisions',()=>{
  const old=correction('old',1,'2026-03-01','B'),newer=correction('new',2,'2026-02-01','C',undefined,[1]);
  expect(values(movementGradeEvidence([old,newer],[],'WRONG CURRENT'),'2026-01-31','2026-02-01','2026-03-01','2026-05-01')).toEqual([known('A'),known('C'),known('C'),known('C')]);
 });
 it('does not resurrect an explicitly replaced correction when the replacement period ends',()=>{
  const old=correction('old',1,'2026-03-01','B'),newer=correction('new',2,'2026-02-01','C','2026-04-01',[1]);
  expect(values(movementGradeEvidence([old,newer],[],'WRONG CURRENT'),'2026-03-01','2026-04-01')).toEqual([known('C'),known('A')]);
 });
 it('does not let unrelated correction snapshots or unrelated replacement metadata rewrite grade',()=>{
  const move=grade('movement',1,'A','B'),unrelated=correction('unrelated',3,'2026-01-01','WRONG');
  unrelated.payload={fields:['departmentId'],effectiveOn:'2026-01-01',before:{gradeId:'B'},after:{gradeId:'WRONG'},replacedCorrectionSequences:[2]};
  const fixed=correction('grade-correction',2,'2026-04-01','C');
  expect(values(movementGradeEvidence([move,fixed,unrelated],[row('movement','2026-03-01')],'WRONG CURRENT'),'2026-02-01','2026-03-01','2026-04-01')).toEqual([known('A'),known('B'),known('C')]);
 });
 it('uses same-day saved sequence while respecting the explicit original-hire bound',()=>{
  const first=correction('before-move',1,'2026-03-01','B'),move=grade('movement',2,'B','C'),after=correction('after-move',3,'2026-03-01','D');
  expect(movementGradeEvidence([first,move],[row('movement','2026-03-01')],'WRONG CURRENT').at('2026-03-01')).toEqual(known('C'));
  expect(movementGradeEvidence([first,move,after],[row('movement','2026-03-01')],'WRONG CURRENT').at('2026-03-01')).toEqual(known('D'));
 });
 it('does not project an automatic company-scope grade clear over historical periods',()=>{
  const clear:Event={id:'company-clear',sequence:1,eventType:'employment.information.corrected',occurredAt:time,actorId:'hr',payload:{source:'original-hire',fields:['companyId'],effectiveOn:'2026-01-01',before:{gradeId:'A'},after:{gradeId:'A'},clearedGradeId:'A'}};
  expect(movementGradeEvidence([clear],[],null).at('2026-02-01')).toEqual({gradeId:null,gradeKnown:false});
 });
 it('distinguishes a recorded blank from an unknown preimage and rejects invalid date evidence',()=>{
  expect(movementGradeEvidence([],[],null).at('2026-01-01')).toEqual(known(null));
  const unknown=correction('unknown',1,'2026-03-01','B');unknown.payload={...(unknown.payload as object),before:{}};
  expect(values(movementGradeEvidence([unknown],[],'WRONG CURRENT'),'2026-02-01','2026-03-01')).toEqual([{gradeId:null,gradeKnown:false},known('B')]);
  expect(movementGradeEvidence([correction('invalid',1,'2026-02-31','B')],[],'A').at('2026-03-01')).toEqual({gradeId:null,gradeKnown:false});
 });
});
