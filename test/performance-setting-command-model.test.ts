import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adjudicateSettingCommands, applyLibraryTarget, type SettingCommandFacts } from '../packs/performance/onehr/setting-command-model';
import { kpiSchema } from '../packs/performance/onehr/model';
const id=randomUUID(),libraryId=randomUUID();
const kpi=kpiSchema.parse({id,title:'Delivery',description:'',unit:'units',weightBp:10000,scoring:{mechanism:'A',method:'more',rates:[0,50,100,150,200]},moderatorEmploymentId:null,setting:'draft',settingRemark:'',actual:null,note:'',approvedActual:null,moderationRemark:'',locked:false});
const library={id:libraryId,revision:1,title:'Delivery',description:'From the governed library',category:'',unit:'units',weightBp:10000,scoring:kpi.scoring,spread:{rate:[0,50,100,150,200]}};
const span=(text:string,value:string)=>({start:text.indexOf(value),end:text.indexOf(value)+value.length});
const facts=(text:string):SettingCommandFacts=>({text,kpis:[kpi],library:[library],moderatorEmploymentId:null});
describe('guided KPI setup commands',()=>{
 it('extracts a literal weight without changing results, submission or the input',()=>{
  const text='Set Delivery weight to 35%';
  expect(adjudicateSettingCommands(JSON.stringify({commands:[{action:'set_weight',id,target:span(text,'Delivery'),value:span(text,'35%')}]}),facts(text))).toMatchObject({ok:true,kpis:[{weightBp:3500,actual:null,setting:'draft',locked:false}]});
  expect(kpi.weightBp).toBe(10000);
 });
 it('adds only exact eligible definitions and rejects invented or duplicate library entries',()=>{
  const text='Add Delivery',command={action:'add_kpi',id:libraryId,target:span(text,'Delivery')};
  const empty={...facts(text),kpis:[]};
  expect(adjudicateSettingCommands(JSON.stringify({commands:[command]}),empty)).toMatchObject({ok:true,kpis:[{libraryId,title:'Delivery',description:library.description,weightBp:10000}]});
  for(const c of [{...command,id:randomUUID()},{...command,title:'Invented'},command]){
   const context=c===command?{...empty,kpis:[{...kpi,libraryId}]}:empty;
   expect(adjudicateSettingCommands(JSON.stringify({commands:[c]}),context).ok).toBe(false);
  }
 });
 it('uses administrator spread and Python figure rounding for a new base, including descending ladders',()=>{
  expect(applyLibraryTarget(kpi,library,2.675)).toMatchObject({rates:[0,1.34,2.67,4.01,5.35]});
  expect(applyLibraryTarget({...kpi,scoring:{mechanism:'A',method:'less',rates:[200,150,100,50,0]}},{...library,spread:{rate:[200,150,100,50,0]}},100)).toMatchObject({rates:[200,150,100,50,0]});
  expect(applyLibraryTarget(kpi,undefined,250)).toMatchObject({target:250,rates:[0,50,100,150,200]});
 });
 it('rejects inappropriate mechanisms, formulas, ambiguous names and conflicting edits atomically',()=>{
  const text='Set Delivery weight to 50 + 50',command={action:'set_weight',id,target:span(text,'Delivery'),value:span(text,'50 + 50')};
  expect(adjudicateSettingCommands(JSON.stringify({commands:[command]}),facts(text)).ok).toBe(false);
  expect(adjudicateSettingCommands(JSON.stringify({commands:[{...command,value:span(text,'50')},{action:'remove_kpi',id,target:command.target}]}),facts(text)).ok).toBe(false);
  expect(adjudicateSettingCommands(JSON.stringify({commands:[{...command,action:'set_number',field:'multiple',value:span(text,'50')}]}),facts(text)).ok).toBe(false);
  expect(adjudicateSettingCommands(JSON.stringify({commands:[{...command,value:span(text,'50')}]}),{...facts(text),kpis:[kpi,{...kpi,id:randomUUID()}]}).ok).toBe(false);
 });
 it('never accepts approvals, HR-owned lines, proposed scorecards or unknown actions',()=>{
  const text='Remove Delivery',command={action:'remove_kpi',id,target:span(text,'Delivery')};
  for(const line of [{...kpi,hrOwned:true},{...kpi,setting:'proposed' as const}])expect(adjudicateSettingCommands(JSON.stringify({commands:[command]}),{...facts(text),kpis:[line]}).ok).toBe(false);
  expect(adjudicateSettingCommands('{"commands":[{"action":"submit"}]}',facts(text)).ok).toBe(false);
 });
});
