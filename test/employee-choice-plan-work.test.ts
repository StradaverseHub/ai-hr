/** Synthetic regression models supplement actual plans; they are not a native witness. */
import {expect,it} from 'vitest';
import {employeeChoicePlanLimits,employeeChoicePlanWork} from './performance/employee-choice-plan-work';
const counts=(rows:number)=>({employment:rows,person:rows,assignment:rows,company:3,department:160,businessUnit:64});
const plan=(extra:Record<string,unknown>={})=>({'Node Type':'Index Scan','Relation Name':'assignment','Actual Loops':7,'Actual Rows':1,'Shared Hit Blocks':100,'Shared Read Blocks':10,...extra});
it('permits seven efficient sparse native index probes without requiring a particular join algorithm',()=>{
 const result=employeeChoicePlanWork(plan(),counts(7));expect(result.rejectionReasons).toEqual([]);expect(result.nodes[0].work).toBe(7);expect(result.rootSharedBlocks).toBe(110);
 // Repeated singleton CTE lookups can be linear; eight loops is not a complexity boundary.
 expect(employeeChoicePlanWork(plan({'Node Type':'CTE Scan','Actual Loops':20}),counts(7)).rejectionReasons).toEqual([]);
});
it('rejects quadratic50k materialized rescans and counts every removed-row category',()=>{
 const result=employeeChoicePlanWork(plan({'Actual Loops':50000,'Actual Rows':50000}),counts(50000));expect(result.rejectionReasons).toContain('root:node-work');
 for(const field of ['Rows Removed by Filter','Rows Removed by Join Filter','Rows Removed by Index Recheck','Rows Removed by Conflict Filter']){
  expect(employeeChoicePlanWork(plan({'Actual Loops':50000,'Actual Rows':0,[field]:50000}),counts(50000)).rejectionReasons).toContain('root:node-work');
 }
 const nested=plan({Plans:[plan({'Actual Loops':50000,'Actual Rows':50000})]});expect(employeeChoicePlanWork(nested,counts(50000)).rejectionReasons).toContain('root.0:node-work');
});
it.each([404542,1190000])('rejects previously observed pathological %s shared blocks independent of join shape',blocks=>{
 expect(employeeChoicePlanWork(plan({'Shared Hit Blocks':blocks,'Shared Read Blocks':0}),counts(50000)).rejectionReasons).toContain('root:shared-blocks');
 expect(employeeChoicePlanWork(plan({'Shared Hit Blocks':0,'Shared Read Blocks':blocks}),counts(50000)).rejectionReasons).toContain('root:shared-blocks');
});
it('keeps the retained dense ceilings, scales sparse work and does not silently increase a future fixture budget',()=>{
 expect(employeeChoicePlanLimits(counts(50000))).toMatchObject({maxNodeWork:1600000,maxRootSharedBlocks:150000});
 expect(employeeChoicePlanLimits(counts(7))).toMatchObject({scaleRows:160,maxNodeWork:5120,maxRootSharedBlocks:4096});
 expect(employeeChoicePlanLimits(counts(100000))).toMatchObject({maxNodeWork:1600000,maxRootSharedBlocks:150000});
});
it('refuses missing, negative and nonfinite actual counters or estimated/invalid cardinalities',()=>{
 for(const extra of [{'Actual Loops':undefined},{'Actual Rows':NaN},{'Shared Hit Blocks':undefined},{'Shared Read Blocks':-1},{'Rows Removed by Index Recheck':Infinity}])expect(()=>employeeChoicePlanWork(plan(extra),counts(7))).toThrow(/actual plan counter/);
 expect(()=>employeeChoicePlanWork(plan(),{...counts(7),employment:1.5})).toThrow(/cardinalities/);
});
