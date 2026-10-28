/** Source-authored pure layout tests, not current-view authorization or browser evidence. */
import {describe,it,expect} from 'vitest';
import {conversationFactLayout,type ConversationFactReference} from '../lib/ai/assistant-answer-layout';
import {presentCanonicalModuleData} from '../lib/ai/module-job-presentation';
import type {JobPresentation} from '../lib/ai/module-jobs';
const payroll=(currencies=['MYR','MYR'])=>presentCanonicalModuleData('payroll',{truncated:false,rows:currencies.map((currency,index)=>({payPeriod:'2026-'+(index+1),company:'Fictional company',gross:'1234.567890123',deductions:'10',net:'1224.567890123',currency,runType:'regular',runSeq:1}))});
function refs(presentation:JobPresentation,cards=[0,1],facts=[1,3]):ConversationFactReference[]{return cards.flatMap(card=>facts.map(fact=>({sourceKey:'current-payroll-view',presentation,card,fact})));}
describe('source-owned conversation fact layout',()=>{
 it('uses actual canonical record presentations and original selected positions without copying values',()=>{
  const result=conversationFactLayout(refs(payroll()));expect(result).toEqual({kind:'comparison',columns:[{field:'gross',format:'money'},{field:'net',format:'money'}],rows:[{sourceKey:'current-payroll-view',card:0,positions:[0,1]},{sourceKey:'current-payroll-view',card:1,positions:[2,3]}]});
  const encoded=JSON.stringify(result);for(const value of['1234.567890123','1224.567890123','Fictional company','MYR','2026-1','href'])expect(encoded).not.toContain(value);
  expect(Object.isFrozen(result)).toBe(true);if(result.kind==='comparison'){expect(Object.isFrozen(result.columns)).toBe(true);expect(Object.isFrozen(result.columns[0])).toBe(true);expect(Object.isFrozen(result.rows)).toBe(true);expect(Object.isFrozen(result.rows[0])).toBe(true);expect(Object.isFrozen(result.rows[0].positions)).toBe(true);}
 });
 it('retains chosen source order and does not sort records or selected fact columns',()=>{
  const input=refs(payroll(),[1,0],[3,1]),result=conversationFactLayout(input);expect(result.kind).toBe('comparison');if(result.kind==='comparison'){expect(result.columns.map(column=>column.field)).toEqual(['net','gross']);expect(result.rows.map(row=>row.card)).toEqual([1,0]);expect(result.rows.map(row=>row.positions)).toEqual([[0,1],[2,3]]);}
  expect(input.map(ref=>[ref.card,ref.fact])).toEqual([[1,3],[1,1],[0,3],[0,1]]);
 });
 it('can compare actual canonical nonmonetary attendance records',()=>{
  const view=presentCanonicalModuleData('attendance',{truncated:false,rows:[{date:'2026-01-01',status:'present',workedMinutes:480,otMinutes:0},{date:'2026-01-02',status:'present',workedMinutes:420,otMinutes:0}]});
  expect(conversationFactLayout(refs(view,[0,1],[0,2]))).toMatchObject({kind:'comparison',columns:[{field:'date',format:'date'},{field:'workedMinutes',format:'number'}]});
 });
 it('refuses cross-currency, missing/invalid/duplicate currency and mismatched explicit units',()=>{
  expect(conversationFactLayout(refs(payroll(['MYR','USD'])))).toEqual({kind:'list'});
  for(const currency of['myr','','unknown'])expect(conversationFactLayout(refs(payroll([currency,currency])))).toEqual({kind:'list'});
  const base=payroll();for(const facts of[base.cards[0].facts.filter(fact=>fact.field!=='currency'),[...base.cards[0].facts,base.cards[0].facts[4]]]){
   const changed={...base,cards:[{...base.cards[0],facts},base.cards[1]]};expect(conversationFactLayout(refs(changed))).toEqual({kind:'list'});
  }
  const toil=presentCanonicalModuleData('toil',{truncated:false,rows:['days','hours'].map(leaveUnit=>({active:2,taken:0,expired:0,convertedToPay:0,leaveUnit,soonestExpiry:null,rows:{truncated:false,rows:[]}}))});
  expect(conversationFactLayout(refs(toil,[0,1],[0]))).toEqual({kind:'list'});
 });
 it('falls back without dropping facts when fields, formats or selected record lengths differ',()=>{
  const base=payroll();expect(conversationFactLayout([...refs(base).slice(0,3)])).toEqual({kind:'list'});
  expect(conversationFactLayout([...refs(base).slice(0,2),...refs(base,[1],[3,1])])).toEqual({kind:'list'});
  const changed={...base,cards:[base.cards[0],{...base.cards[1],facts:base.cards[1].facts.map((fact,index)=>index===1?{...fact,format:'number' as const}:fact)}]};expect(conversationFactLayout(refs(changed))).toEqual({kind:'list'});
 });
 it('rejects withheld/null/blank/nonfinite and unknown fields instead of inventing comparable values',()=>{
  const base=payroll();expect(conversationFactLayout(refs({...base,cards:[{...base.cards[0],withheld:true},base.cards[1]]}))).toEqual({kind:'list'});
  for(const poison of[null,' ',NaN,Infinity,'unknown']){const changed={...base,cards:[{...base.cards[0],facts:base.cards[0].facts.map((fact,index)=>index===1?{...fact,value:poison}:fact)},base.cards[1]]};expect(conversationFactLayout(refs(changed))).toEqual({kind:'list'});}
  const changed={...base,cards:[{...base.cards[0],facts:base.cards[0].facts.map((fact,index)=>index===1?{...fact,field:'model_claim' as never}:fact)},base.cards[1]]};expect(conversationFactLayout(refs(changed))).toEqual({kind:'list'});
 });
 it('does not combine different views/keys or interleaved/duplicate records and fields',()=>{
  const view=payroll(),input=refs(view);expect(conversationFactLayout([...input.slice(0,2),...refs(payroll()).slice(2)])).toEqual({kind:'list'});
  expect(conversationFactLayout(input.map((ref,index)=>index===3?{...ref,sourceKey:'another-view'}:ref))).toEqual({kind:'list'});
  expect(conversationFactLayout(refs(view,[0,1,0],[1]))).toEqual({kind:'list'});expect(conversationFactLayout(refs(view,[0,1],[1,1]))).toEqual({kind:'list'});
 });
 it('bounds groups/columns and rejects model-poisoned coordinates without mutating source facts',()=>{
  const view=payroll(),original=JSON.stringify(view);for(const [card,fact] of[[-1,0],[2,0],[0,-1],[0,99],[NaN,1],[0,Infinity],[0,1.5]])expect(conversationFactLayout([{sourceKey:'current-payroll-view',presentation:view,card,fact},...refs(view)])).toEqual({kind:'list'});
  expect(conversationFactLayout([{...refs(view)[0],value:'model invented HR value'} as ConversationFactReference,...refs(view).slice(1)])).toEqual({kind:'list'});
  expect(conversationFactLayout([])).toEqual({kind:'list'});expect(conversationFactLayout(refs(view,[0],[1]))).toEqual({kind:'list'});
  expect(conversationFactLayout(refs(payroll(Array(9).fill('MYR')),Array.from({length:9},(_,index)=>index),[1]))).toEqual({kind:'list'});
  expect(conversationFactLayout(refs(view,[0,1],[0,1,2,3,4,5,6]))).toEqual({kind:'list'});expect(JSON.stringify(view)).toBe(original);
 });
});
