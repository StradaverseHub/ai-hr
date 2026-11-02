import {expect,it} from 'vitest';
import {createPerformanceRequestRouter} from '../scripts/performance/request-routing.mjs';
it('keeps reads in one lane and every other method in the other, independent of arrival order',()=>{
 const route=createPerformanceRequestRouter(2,'method-split');
 for(const method of ['POST','PUT','PATCH','DELETE','OPTIONS',undefined,'UNKNOWN'])expect(route(method)).toBe(1);
 for(const method of ['GET','HEAD','get','head'])expect(route(method)).toBe(0);
 expect(['POST','GET','GET','DELETE','HEAD','PATCH'].map(route)).toEqual([1,0,0,1,0,1]);
});
it.each(['round-robin','method-split'] as const)('keeps the one-worker baseline on its only backend (%s)',mode=>{
 const route=createPerformanceRequestRouter(1,mode);
 expect(['GET','POST','DELETE','HEAD'].map(route)).toEqual([0,0,0,0]);
});
it('preserves the original round-robin control independently of methods',()=>{
 const route=createPerformanceRequestRouter(2,'round-robin');
 expect(['POST','GET','GET','POST','DELETE','HEAD'].map(route)).toEqual([0,1,0,1,0,1]);
});
