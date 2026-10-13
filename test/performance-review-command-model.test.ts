import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adjudicateReviewCommands, type ReviewCommandFacts } from '../packs/performance/onehr/review-command-model';
const id=randomUUID();
const base:ReviewCommandFacts={text:'Record Delivery at 100; note: Shipped on time.',draft:{kind:'results',lines:[{id,actual:null,note:''}],remark:''},targets:[{id,label:'Delivery'}]};
const span=(text:string,value:string)=>({start:text.indexOf(value),end:text.indexOf(value)+value.length});
const command={action:'kpi_result',id,target:span(base.text,'Delivery'),actual:span(base.text,'100'),note:span(base.text,'Shipped on time.')};
describe('assessment chat draft adjudication',()=>{
 it('extracts only the employee’s literal actual and note, without submitting or modifying the input',()=>{
  const result=adjudicateReviewCommands(JSON.stringify({commands:[command]}),base);
  expect(result).toMatchObject({ok:true,changed:true,draft:{kind:'results',lines:[{id,actual:100,note:'Shipped on time.'}]}});
  expect(base.draft).toMatchObject({lines:[{actual:null,note:''}]});
 });
 it('rejects invented values, unknown fields, foreign items and mismatched references',()=>{
  for(const change of [{value:100},{id:randomUUID()},{target:span(base.text,'Record')},{actual:{start:999,end:1000}},{action:'submit'}])expect(adjudicateReviewCommands(JSON.stringify({commands:[{...command,...change}]}),base).ok).toBe(false);
  expect(adjudicateReviewCommands(JSON.stringify({commands:[command,command]}),base).ok).toBe(false);
  expect(adjudicateReviewCommands(JSON.stringify({commands:[command]}),{...base,targets:[...base.targets,{id:randomUUID(),label:'Delivery'}]}).ok).toBe(false);
 });
 it('refuses calculations and applies no partial changes when another command is invalid',()=>{
  const facts={...base,text:'Record Delivery at 50 + 50'};
  expect(adjudicateReviewCommands(JSON.stringify({commands:[{...command,actual:span(facts.text,'50 + 50'),note:undefined}]}),facts).ok).toBe(false);
  expect(adjudicateReviewCommands(JSON.stringify({commands:[command,{action:'overall_remark',text:{start:500,end:501}}]}),base).ok).toBe(false);
  expect(base.draft).toMatchObject({lines:[{actual:null,note:''}]});
 });
 it('supports literal competency answers while preserving other private answers',()=>{
  const text='Set Safe delivery to yes, note: Practised in the release.';
  const facts:ReviewCommandFacts={text,targets:[{id:'skill',label:'Safe delivery'}],draft:{kind:'competency_self',answers:{skill:{answer:null,remark:''},other:{answer:'no',remark:'Retain this'}},remark:''}};
  const update={action:'competency_answer',id:'skill',target:span(text,'Safe delivery'),answer:span(text,'yes'),remark:span(text,'Practised in the release.')};
  expect(adjudicateReviewCommands(JSON.stringify({commands:[update]}),facts)).toMatchObject({ok:true,draft:{answers:{skill:{answer:'yes',remark:'Practised in the release.'},other:{answer:'no',remark:'Retain this'}}}});
  expect(adjudicateReviewCommands(JSON.stringify({commands:[{...update,answer:span(text,'Set')}]}),facts).ok).toBe(false);
 });
 it('keeps the source’s overall remark ceiling and treats an empty proposal as no change',()=>{
  const text=Array(221).fill('word').join(' ');
  expect(adjudicateReviewCommands(JSON.stringify({commands:[{action:'overall_remark',text:{start:0,end:text.length}}]}),{...base,text}).ok).toBe(false);
  expect(adjudicateReviewCommands('{"commands":[]}',base)).toMatchObject({ok:true,changed:false});
 });
});
