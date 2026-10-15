import { describe,it,expect } from 'vitest';
import { adjudicateCalibrationQuery,literalCalibrationQuery } from '../packs/performance/onehr/calibration-query-model';
const id='00000000-0000-4000-8000-000000000001',unit='00000000-0000-4000-8000-000000000002',scope={axis:'performance' as const,people:[{id,name:'Nadia Lim'}],units:[{id:unit,name:'Services'}]};
describe('calibration read queries',()=>{
 it('accepts only scoped literal names and the active axis',()=>{
  const text='Explain Nadia Lim',query={action:'person',reviewId:id,name:{start:8,end:17}};
  expect(adjudicateCalibrationQuery(JSON.stringify(query),text,scope)).toEqual(query);
  for(const raw of [{...query,reviewId:unit},{...query,name:{start:0,end:7}},{...query,band:'OU'},{action:'move',reviewId:id},{action:'distribution',axis:'potential'}])expect(adjudicateCalibrationQuery(JSON.stringify(raw),text,scope)).toBeNull();
  expect(adjudicateCalibrationQuery(JSON.stringify(query),text,{...scope,people:[...scope.people,{id:unit,name:'Nadia Lim'}]})).toBeNull();
  expect(adjudicateCalibrationQuery(JSON.stringify({action:'framework',unit:{id:unit,name:{start:0,end:8}}}),'Services',scope)?.action).toBe('framework');
  expect(adjudicateCalibrationQuery(JSON.stringify({action:'framework',unit:{id,name:{start:0,end:8}}}),'Services',scope)).toBeNull();
 });
 it('supports deterministic operations without giving them write capability',()=>{
  expect(literalCalibrationQuery('Show distribution',scope)).toEqual({action:'distribution'});
  expect(literalCalibrationQuery('Suggest to framework',scope)).toEqual({action:'framework'});
  expect(literalCalibrationQuery('Lock calibration',scope)).toEqual({action:'prepare_lock'});
  expect(literalCalibrationQuery('Open: Nadia Lim',scope)).toMatchObject({action:'person',reviewId:id});
  expect(()=>literalCalibrationQuery('Explain: Foreign Person',scope)).toThrow(/unambiguous/);
  expect(literalCalibrationQuery('Raise everyone to Outstanding',scope)).toBeNull();
 });
});
