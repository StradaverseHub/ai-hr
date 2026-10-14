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
 it('adds a literal justification without clearing an already drafted numeric result',()=>{
  const text='Delivery note: Verified against the service ledger.',facts:ReviewCommandFacts={...base,text,draft:{kind:'moderation',lines:[{id,actual:150,note:'Earlier note'}],remark:'Retain this overall remark'}};
  const command={action:'kpi_note',id,target:span(text,'Delivery'),note:span(text,'Verified against the service ledger.')};
  expect(adjudicateReviewCommands(JSON.stringify({commands:[command]}),facts)).toMatchObject({ok:true,changed:true,draft:{kind:'moderation',lines:[{id,actual:150,note:'Verified against the service ledger.'}],remark:'Retain this overall remark'}});
  expect(facts.draft).toMatchObject({lines:[{actual:150,note:'Earlier note'}]});
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
 it('records explicit observed/not-yet feedback and literal principle comments in the assigned colleague draft',()=>{
  const text='Record Follows through as not yet. Reliability comment: Kept me informed.';
  const facts:ReviewCommandFacts={text,draft:{kind:'feedback',answers:{existing:'yes'},comments:{Other:'Retain this'},remark:''},targets:[{id:'follow',label:'Follows through'},{id:'principle:Reliability',label:'Reliability'}]};
  const commands=[{action:'feedback_answer',id:'follow',target:span(text,'Follows through'),answer:span(text,'not yet')},{action:'feedback_comment',id:'principle:Reliability',target:span(text,'Reliability'),text:span(text,'Kept me informed.')}];
  expect(adjudicateReviewCommands(JSON.stringify({commands}),facts)).toMatchObject({ok:true,draft:{kind:'feedback',answers:{existing:'yes',follow:'no'},comments:{Other:'Retain this',Reliability:'Kept me informed.'}}});
  expect(facts.draft).toMatchObject({answers:{existing:'yes'},comments:{Other:'Retain this'}});
  expect(adjudicateReviewCommands(JSON.stringify({commands}),{...facts,targets:[{id:'foreign',label:'Follows through'}]}).ok).toBe(false);
 });
 it('cannot use colleague feedback commands on a KPI draft or invent comment words',()=>{
  const text='Delivery yes',commands=[{action:'feedback_answer',id,target:span(text,'Delivery'),answer:span(text,'yes')}];
  expect(adjudicateReviewCommands(JSON.stringify({commands}),{...base,text}).ok).toBe(false);
  expect(adjudicateReviewCommands(JSON.stringify({commands:[{action:'feedback_comment',id:'principle:Reliability',target:span(text,'Delivery'),text:{start:500,end:501}}]}),{text,draft:{kind:'feedback',answers:{},remark:''},targets:[{id:'principle:Reliability',label:'Delivery'}]}).ok).toBe(false);
 });

 it('accepts the source competency vocabulary, preserves notes on button taps and guards only the paired self level',()=>{
  for(const [word,answer] of Object.entries({yes:'yes',demonstrate:'yes',demonstrated:'yes',no:'no',developing:'no',develop:'no'})){
   const text=`Record Higher as ${word}. Add example`,facts:ReviewCommandFacts={text,targets:[{id:'lo',label:'Lower',competency:{title:'Planning',category:'Technical',future:false}},{id:'hi',label:'Higher',competency:{title:'Planning',category:'Technical',future:true}}],draft:{kind:'competency_self',answers:{lo:{answer:'yes',remark:''},hi:{answer:null,remark:'Keep the actual observed example.'}},remark:''}};
   const command={action:'competency_answer',id:'hi',target:span(text,'Higher'),answer:span(text,word),remark:span(text,'Add example')},run=(f:ReviewCommandFacts)=>adjudicateReviewCommands(JSON.stringify({commands:[command]}),f);
   expect(run(facts)).toMatchObject({ok:true,draft:{answers:{hi:{answer,remark:'Keep the actual observed example.'}}}});
   if(facts.draft.kind!=='competency_self')throw Error('Wrong fixture');facts.draft.answers.lo.answer='no';
   expect(run(facts).ok).toBe(answer==='no');
   expect(run({...facts,draft:{...facts.draft,kind:'competency_manager'}}).ok).toBe(true);
   expect(run({...facts,targets:facts.targets.map(t=>t.id==='lo'?{...t,competency:{...t.competency!,category:'Other'}}:t)}).ok).toBe(true);
   facts.draft.answers.lo.answer=null;expect(run(facts).ok).toBe(true);
  }
 });
 it('refuses competency reflection stubs and source placeholders without changing the draft',()=>{
  for(const text of ['Yes please!','Add an example','[Write your note here]','Please replace this with a note.']){
   const facts:ReviewCommandFacts={text,targets:[],draft:{kind:'competency_self',answers:{},remark:'Existing actual reflection.'}};
   expect(adjudicateReviewCommands(JSON.stringify({commands:[{action:'overall_remark',text:{start:0,end:text.length}}]}),facts).ok).toBe(false);
   expect(facts.draft.remark).toBe('Existing actual reflection.');
  }
 });

});
