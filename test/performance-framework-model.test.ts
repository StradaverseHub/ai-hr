import {describe,it,expect} from 'vitest';
import {defaultPolicy,potential} from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import {currentPrincipleComments,editLeadershipFramework,leadershipPrinciples} from '../packs/performance/onehr/framework-model';
import {anonymousFeedbackReport} from '../packs/performance/onehr/feedback-report';
const initial=()=>defaultPolicy(framework),id=()=> 'new-stable-id';
describe('live leadership framework edits',()=>{
 it('renames a principle without reidentifying behaviours or losing comments under its prior names',()=>{
  const original=initial(),principle=leadershipPrinciples(original)[0],first=editLeadershipFramework(original,{action:'edit_principle',principleId:principle.id,name:'Customer focus',description:'Observe service outcomes'},id);
  const next=editLeadershipFramework(first,{action:'edit_principle',principleId:principle.id,name:'Service practice',description:'Current description'},id),questions=next.framework[0].statements;
  expect(questions.map(s=>s.id)).toEqual(original.framework[0].statements.map(s=>s.id));
  expect(currentPrincipleComments(questions,{[principle.name]:'Original feedback'})).toEqual({'Service practice':'Original feedback'});
  expect(anonymousFeedbackReport(questions,[{answers:{},remark:'',comments:{[principle.name]:'Original feedback'}}]).comments).toEqual([{principle:'Service practice',text:'Original feedback'}]);
  expect(original.leadershipPrinciples).toBeUndefined();
 });
 it('retains an empty principle, adds a stable question at one tier and removes it from effective scoring',()=>{
  const added=editLeadershipFramework(initial(),{action:'add_principle',name:'Decision quality',description:'Use evidence'},id);
  expect(leadershipPrinciples(added).some(p=>p.name==='Decision quality')).toBe(true);
  const next=editLeadershipFramework(added,{action:'add_behaviour',principleId:id(),tier:0,text:'Checks competing explanations',future:true},()=> 'new-question');
  expect(next.framework[0].statements.find(s=>s.id==='new-question')).toMatchObject({future:true,principle:'Decision quality'});
  expect(next.framework.slice(1).some(t=>t.statements.some(s=>s.id==='new-question'))).toBe(false);
  const removed=editLeadershipFramework(next,{action:'remove_principle',principleId:id()},id);
  expect(removed.framework.flatMap(t=>t.statements).some(s=>s.id==='new-question')).toBe(false);
  expect(removed.leadershipPrinciples?.find(p=>p.id===id())?.archived).toBe(true);
  expect(()=>editLeadershipFramework(removed,{action:'add_principle',name:'Decision quality',description:''},id)).toThrow(/distinct/);
 });
 it('keeps question identity when editing its text and refuses stale identities',()=>{
  const original=initial(),statement=original.framework[0].statements[0];
  expect(editLeadershipFramework(original,{action:'edit_behaviour',statementId:statement.id,text:'Updated observable behaviour'},id).framework[0].statements[0]).toMatchObject({id:statement.id,text:'Updated observable behaviour',future:statement.future});
  expect(()=>editLeadershipFramework(original,{action:'remove_behaviour',statementId:'missing'},id)).toThrow(/changed/);
 });
 it('does not invent a High potential band when all questions have been removed',()=>{
  expect(potential(Array.from({length:4},()=>({score:0,max:0})),null,initial(),'12')).toEqual({pct:null,band:null,valid:false});
 });
});
