import {describe,expect,it} from 'vitest';
import {homeCardInteractions} from '../lib/employee-home-analytics';
const valid=()=>({version:1,events:[{card:'today',action:'view'}]});
describe('content-free Home interaction admission',()=>{
 it('admits only fixed card/action keys and at most16 observations',()=>{
  expect(homeCardInteractions(valid())).toEqual([{card:'today',action:'view'}]);
  for(const raw of [{...valid(),tenantId:'posted'},{version:1,events:[]},{version:1,events:Array.from({length:17},()=>valid().events[0])},
   {version:1,events:[{card:'today',action:'view',text:'PRIVATE'}]},{version:1,events:[{card:'person-PRIVATE',action:'view'}]},
   {version:1,events:[{card:'today',action:'submit'}]}])expect(()=>homeCardInteractions(raw)).toThrow();
 });
 it('does not invoke an accessor or accept prototype/symbol payload extensions',()=>{
  let read=false;const row=Object.defineProperty({card:'today'},'action',{enumerable:true,get:()=>{read=true;return 'view';}});
  expect(()=>homeCardInteractions({version:1,events:[row]})).toThrow();expect(read).toBe(false);
  expect(()=>homeCardInteractions({...valid(),[Symbol('PRIVATE')]:'private'})).toThrow();
  expect(()=>homeCardInteractions(Object.assign(Object.create({inherited:'PRIVATE'}),valid()))).toThrow();
 });
});
