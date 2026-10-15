import { randomUUID } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { adjudicateSettingSuggestion } from '../packs/performance/onehr/setting-suggestion-model';
import type { KpiLibraryChoice } from '../packs/performance/onehr/setting-default-model';
const moderator=randomUUID();
const library:KpiLibraryChoice[]=Array.from({length:10},(_,i)=>({id:randomUUID(),revision:1,title:`Objective ${i}`,description:'Governed definition',category:'Delivery',unit:'units',weightBp:1000,scoring:{mechanism:'A',method:'more',target:100,rates:[80,90,100,110,120]},spread:{rate:[80,90,100,110,120]},defaultScoring:{mechanism:'A',method:'more',target:40,rates:[10,20,30,40,50]},numberSource:'history'}));
describe('source-grounded starter scorecard',()=>{
 it('drops unknown and duplicate identities, caps eight and balances relative weights to exactly 100%',()=>{
  const raw=JSON.stringify([{id:randomUUID(),weightage:100},{id:library[0].id,weightage:1},{id:library[0].id,weightage:5},...library.slice(1).map(item=>({id:item.id,weightage:1}))]);
  const result=adjudicateSettingSuggestion(raw,library,moderator)!;
  expect(result.kpis).toHaveLength(8);expect(result.kpis.reduce((n,k)=>n+k.weightBp,0)).toBe(10000);expect(new Set(result.kpis.map(k=>k.libraryId)).size).toBe(8);
  expect(result.kpis.every(k=>k.setting==='draft'&&k.actual===null&&!k.locked&&k.moderatorEmploymentId===moderator)).toBe(true);
 });
 it('matches source rounding drift and preserves governed wording and history defaults',()=>{
  const result=adjudicateSettingSuggestion('```json\n'+JSON.stringify(library.slice(0,3).map(item=>({id:item.id,weightage:1,title:'Invented wording',target:-4})))+'\n```',library,null)!;
  expect(result.kpis.map(k=>k.weightBp)).toEqual([3333,3333,3334]);expect(result.kpis[0]).toMatchObject({title:library[0].title,description:library[0].description,scoring:library[0].defaultScoring,numberSource:'history'});expect(result.aiBases.size).toBe(0);
 });
 it('derives an AI base only through a library spread and preserves the library B multiplier',()=>{
  const b:KpiLibraryChoice={...library[1],scoring:{mechanism:'B',variant:'base',method:'more',threshold:80,target:100,multiple:2,excellence:null},spread:{threshold:80},defaultScoring:{mechanism:'B',variant:'base',method:'more',threshold:30,target:40,multiple:4,excellence:null}};
  const noSpread={...library[0],spread:null},result=adjudicateSettingSuggestion(JSON.stringify([{id:noSpread.id,weightage:1,target:999},{id:b.id,weightage:1,target:250}]),[noSpread,b],null)!;
  expect(result.kpis[0].scoring).toEqual(noSpread.defaultScoring);expect(result.kpis[1]).toMatchObject({numberSource:'ai',scoring:{threshold:200,target:250,multiple:2}});expect(result.aiBases.get(result.kpis[1].id)).toBe(250);
 });
 it('returns no proposal for unusable identities or nonpositive weights without changing the catalogue',()=>{
  const before=JSON.stringify(library);
  for(const raw of ['not json','{}','[]',JSON.stringify([{id:library[0].id,weightage:0}]),JSON.stringify([{id:library[0].id,weightage:true}]),JSON.stringify([{id:randomUUID(),weightage:100}])])expect(adjudicateSettingSuggestion(raw,library,null)).toBeNull();
  expect(JSON.stringify(library)).toBe(before);
 });
});
