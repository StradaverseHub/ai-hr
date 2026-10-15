import { describe,expect,it } from 'vitest';
import { defaultLibraryScoring,spreadScoring } from '../packs/performance/onehr/setting-default-model';
import { draftScoringSchema,kpiSchema,scoreKPI,validateScorecard } from '../packs/performance/onehr/model';
import { importKpiDefinition } from '../packs/performance/onehr/import-model';
import { randomUUID } from 'node:crypto';
const scoring={mechanism:'A' as const,method:'more' as const,target:200,rates:[1,2,3,4,5] as [number,number,number,number,number]},template={title:'Delivery',description:'',category:'',unit:'units',weightBp:10000,scoring,spread:{rate:[80,90,100,110,120]}};
describe('source KPI number defaults and incomplete drafts',()=>{
 it('prefers the preceding target ladder over the current library spread',()=>{
  const previous={...scoring,target:40,rates:[10,20,30,40,50] as [number,number,number,number,number]};
  expect(defaultLibraryScoring(template,previous)).toEqual({scoring:previous,numberSource:'history'});
  expect(defaultLibraryScoring(template)).toEqual({scoring:{...scoring,rates:[160,180,200,220,240]},numberSource:'spread'});
  expect(defaultLibraryScoring({...template,spread:null})).toEqual({scoring,numberSource:'library'});
 });
 it('keeps incomplete library numbers and cross-mechanism history incomplete instead of inventing values',()=>{
  const row=importKpiDefinition({kpi:'Delivery',method:'more'},'A','base',true);
  expect(row.scoring).toMatchObject({mechanism:'A',target:null,rates:[null,null,null,null,null]});
  expect(defaultLibraryScoring({...template,scoring:{mechanism:'B',method:'more',variant:'base',threshold:0,target:100,multiple:100,excellence:null}},scoring)).toMatchObject({numberSource:'history',scoring:{mechanism:'B',target:200,threshold:null,multiple:null,excellence:null}});
 });
 it('uses source figure rounding and retains the stretch multiplier while deriving only available spread fields',()=>{
  expect(spreadScoring(scoring,template.spread,2.675)).toMatchObject({target:2.67,rates:[2.14,2.41,2.67,2.94,3.21]});
  expect(scoreKPI(150,{mechanism:'B',method:'more',variant:'base',threshold:0,target:100,multiple:null,excellence:null})).toBe(100);
  expect(spreadScoring({mechanism:'B',method:'more',variant:'excellence',threshold:10,target:100,multiple:125,excellence:120},{threshold:80,excellence:null},200)).toEqual({mechanism:'B',method:'more',variant:'excellence',threshold:160,target:200,multiple:125,excellence:null});
 });
 it('saves partial and temporarily unordered numbers only as drafts, refusing proposal and scoring until ready',()=>{
  const incomplete=draftScoringSchema.parse({mechanism:'A',method:'more',rates:[null,20,null,40,null]});
  const line=kpiSchema.parse({id:randomUUID(),title:'Delivery',description:'',unit:'units',weightBp:10000,scoring:incomplete,moderatorEmploymentId:null,setting:'draft',settingRemark:'',actual:null,note:'',approvedActual:null,moderationRemark:'',locked:false});
  expect(line.scoring).toEqual(incomplete);expect(()=>validateScorecard([line])).toThrow(/target numbers/);expect(()=>scoreKPI(100,incomplete)).toThrow();
  const unordered={...scoring,rates:[50,10,30,20,40] as [number,number,number,number,number]};expect(draftScoringSchema.safeParse(unordered).success).toBe(true);expect(()=>validateScorecard([{...line,scoring:unordered}])).toThrow(/threshold order/);
 });
});
