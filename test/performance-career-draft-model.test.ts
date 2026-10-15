import { describe,expect,it } from 'vitest';
import { careerDraftItems,parseCareerActions,parseCareerAspiration } from '../packs/performance/onehr/career-draft-model';
import { defaultPolicy,kpiSchema } from '../packs/performance/onehr/model';
import { careerGap } from '../packs/performance/onehr/career-model';
import framework from '../packs/performance/onehr/framework.json';
const policy=defaultPolicy(framework);
const line=(title:string,actual:number|null)=>kpiSchema.parse({id:crypto.randomUUID(),title,description:'',unit:'units',weightBp:10000,scoring:{mechanism:'A',method:'more',rates:[0,10,20,30,40]},moderatorEmploymentId:null,setting:'approved',settingRemark:'',actual,note:'',approvedActual:null,moderationRemark:'',locked:false});
const fallback=[{id:'tc:0',kind:'technical' as const,label:'Facilitation',detail:'Facilitate a workshop',note:'not demonstrated',source:'Reviewed competency'}];
describe('source whole-career drafting contract',()=>{
 it('uses actual target skill gaps then weak keyed KPI results, de-duplicating an area without inventing one',()=>{
  const gap=careerGap({Delivery:2},{id:crypto.randomUUID(),name:'Chosen',grade:'14',companyId:null,competencies:[{id:'delivery',principle:'Technical',text:'Delivery',skillTitle:'Delivery',skillLevel:3,future:false},{id:'design',principle:'Technical',text:'Design',skillTitle:'Design',skillLevel:2,future:false}]});
  const pool=careerDraftItems(gap,[line('Delivery',0),line('Quality',0),line('Met delivery',20),line('Unkeyed',null)],policy,'company',fallback);
  expect(pool.map(i=>[i.area,i.kind])).toEqual([['Delivery','stretch'],['Design','missing'],['Quality','performance']]);
  expect(pool[0].detail).toContain('level 2');expect(pool[0].detail).toContain('level 3');
 });
 it('uses generic released/manager-reviewed gaps only when no target or KPI gap is present',()=>{
  expect(careerDraftItems(null,[line('Meets',20)],policy,'company',fallback)).toMatchObject([{id:'tc:0',area:'Facilitation',kind:'technical'}]);
  expect(careerDraftItems(null,[line('Shortfall',0)],policy,'company',fallback).map(i=>i.area)).toEqual(['Shortfall']);
 });
 it('takes only indexed actions; deterministic areas survive malformed or failed AI action drafts',()=>{
  const items=careerDraftItems(null,[line('Delivery',0),line('Quality',0)],policy,'company',[]);
  const goals=parseCareerActions(JSON.stringify([{i:0,area:'Invented area',experience:'Lead a delivery retrospective',exposure:'Ask a mentor',education:'Study practice',dueOn:'2099-01-01',mobility:'relocate'},{i:5,experience:'Foreign item'}]),items);
  expect(goals).toMatchObject([{area:'Delivery',onJob:'Lead a delivery retrospective'},{area:'Quality',onJob:''}]);
  expect(goals[0]).not.toHaveProperty('dueOn');expect(goals[0]).not.toHaveProperty('mobility');
  expect(parseCareerActions('not JSON',items)).toEqual(items.map(i=>({area:i.area,itemIds:[i.id],onJob:'',fromOthers:'',formalLearning:''})));
 });
 it('extracts only a bounded longer-term aspiration, never an AI role ID or mobility choice',()=>{
  expect(parseCareerAspiration('{"aspirationLong":"  Grow my practice  ","targetProfileId":"invented","mobility":"relocate","strengths":"Invented"}')).toBe('Grow my practice');
  expect(parseCareerAspiration('not JSON')).toBe('');expect(parseCareerAspiration('{"aspirationLong":42}')).toBe('');
  expect(parseCareerAspiration(JSON.stringify({aspirationLong:'x'.repeat(5000)}))).toHaveLength(4000);
 });
});
