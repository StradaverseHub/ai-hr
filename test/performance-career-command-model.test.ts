import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adjudicateCareerCommands, type CareerCommandFacts } from '../packs/performance/onehr/career-command-model';
const id=randomUUID(),roleId=randomUUID();
const span=(text:string,value:string)=>({start:text.indexOf(value),end:text.indexOf(value)+value.length});
const facts=(text:string):CareerCommandFacts=>({text,career:{aspiration:'Keep this aspiration',mobility:null,mobilityNote:'',targetProfileId:null},careerRevision:null,planRevision:null,goals:[{id,area:'Facilitation',dueOn:'',onJob:'Run a workshop',fromOthers:'Observe a colleague',formalLearning:'',status:'not_started',managerComment:''}],canEditCareer:true,canEditGoals:true,roles:[{id:roleId,label:'Operations Manager · 15'}]});
describe('career and development conversation adjudication',()=>{
 it('uses literal career wording and mobility choices without rewriting other fields',()=>{
  const text='My next goal is Lead operations, and mobility is role_in_unit.';
  expect(adjudicateCareerCommands(JSON.stringify({commands:[{action:'career_field',field:'aspirationNow',value:span(text,'Lead operations')},{action:'mobility',value:span(text,'role_in_unit')}]}),facts(text))).toMatchObject({ok:true,career:{aspiration:'Keep this aspiration',aspirationNow:'Lead operations',mobility:'role_in_unit'},careerChanged:true,goalsChanged:false});
 });
 it('adds a goal from the employee’s words and leaves its optional target date blank',()=>{
  const text='Add Analysis; on the job: Prepare the monthly review.';
  expect(adjudicateCareerCommands(JSON.stringify({commands:[{action:'add_goal',area:span(text,'Analysis'),onJob:span(text,'Prepare the monthly review.')}]}),facts(text))).toMatchObject({ok:true,goals:[{id,area:'Facilitation'},{area:'Analysis',onJob:'Prepare the monthly review.',dueOn:'',status:'not_started'}],careerChanged:false,goalsChanged:true});
 });
 it('updates a named goal without erasing absent actions and requires an exact catalogue role',()=>{
  const text='For Facilitation, learn Facilitation basics. Target Operations Manager · 15.';
  expect(adjudicateCareerCommands(JSON.stringify({commands:[{action:'edit_goal',id,target:span(text,'Facilitation'),formalLearning:span(text,'Facilitation basics.')},{action:'role_choice',field:'targetProfileId',id:roleId,target:span(text,'Operations Manager · 15')}]}),facts(text))).toMatchObject({ok:true,career:{targetProfileId:roleId},goals:[{onJob:'Run a workshop',fromOthers:'Observe a colleague',formalLearning:'Facilitation basics.'}]});
  expect(adjudicateCareerCommands(JSON.stringify({commands:[{action:'role_choice',field:'targetProfileId',id:randomUUID(),target:span(text,'Operations Manager · 15')}]}),facts(text)).ok).toBe(false);
 });
 it('rejects invented fields, invalid dates, foreign goals and repeated changes atomically',()=>{
  const text='Facilitation by tomorrow';const base={action:'edit_goal',id,target:span(text,'Facilitation'),dueOn:span(text,'tomorrow')};
  for(const commands of [[base],[{...base,dueOn:undefined,id:randomUUID()}],[{action:'career_field',field:'aspiration',value:span(text,'Facilitation')},{action:'share'}],[{action:'career_field',field:'aspiration',value:span(text,'Facilitation'),wording:'Invented'}]])expect(adjudicateCareerCommands(JSON.stringify({commands}),facts(text)).ok).toBe(false);
  expect(facts(text).career.aspiration).toBe('Keep this aspiration');
 });
 it('locks completed career wording with a shared plan and never shares or signs off',()=>{
  const text='Facilitation';const context={...facts(text),canEditCareer:false,canEditGoals:false};
  expect(adjudicateCareerCommands(JSON.stringify({commands:[{action:'career_field',field:'strengths',value:span(text,text)}]}),context)).toMatchObject({ok:false});
  for(const command of [{action:'remove_goal',id,target:span(text,text)},{action:'acknowledge'},{action:'approve'},{action:'share'}])expect(adjudicateCareerCommands(JSON.stringify({commands:[command]}),context).ok).toBe(false);
 });
});
