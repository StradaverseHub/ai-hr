/** ADR 0181 J2: the reprocess job's group sizing and refused-pass narrowing (core/payroll-reprocess-job.ts), pure. The
 * figures are the hosted runner's measured passes: about 2.6 s fixed per engine pass and about 53 ms per employee. */
import {afterEach,expect,it} from 'vitest';
import {narrowRefusedGroup,nextReprocessGroupSize} from '../core/payroll-reprocess-job';

const keys=['PAYROLL_REPROCESS_GROUP_MAX','PAYROLL_REPROCESS_CHUNK_TARGET_MS','PAYROLL_REPROCESS_CHUNK_FIXED_MULTIPLE'] as const;
const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
afterEach(()=>{for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}});

it('doubles until two passes of different sizes give a line, then fills twice the fixed cost',()=>{
 expect(nextReprocessGroupSize([{employees:16,wallMs:3500}],16)).toBe(32);
 // 14 employees in 3,384 ms and 28 in 4,133 ms: 53.5 ms each, 2,635 ms fixed; target 5,270 ms -> 49 employees.
 expect(nextReprocessGroupSize([{employees:14,wallMs:3384},{employees:28,wallMs:4133}],28)).toBe(49);
 // Never more than double the last group, never above the maximum, never below two.
 expect(nextReprocessGroupSize([{employees:4,wallMs:2800},{employees:8,wallMs:3000}],8)).toBe(16);
 process.env.PAYROLL_REPROCESS_GROUP_MAX='40';
 expect(nextReprocessGroupSize([{employees:14,wallMs:3384},{employees:28,wallMs:4133}],28)).toBe(40);
 delete process.env.PAYROLL_REPROCESS_GROUP_MAX;
 expect(nextReprocessGroupSize([{employees:2,wallMs:9000},{employees:3,wallMs:20000}],3)).toBe(2);
 // A falling or flat line (noise) is no estimate: the size doubles.
 expect(nextReprocessGroupSize([{employees:14,wallMs:4000},{employees:28,wallMs:3900}],28)).toBe(56);
 // The multiple and the floor are settings.
 process.env.PAYROLL_REPROCESS_CHUNK_FIXED_MULTIPLE='3';
 expect(nextReprocessGroupSize([{employees:14,wallMs:3384},{employees:28,wallMs:4133}],28)).toBe(56);
 process.env.PAYROLL_REPROCESS_CHUNK_FIXED_MULTIPLE='1';process.env.PAYROLL_REPROCESS_CHUNK_TARGET_MS='4000';
 expect(nextReprocessGroupSize([{employees:14,wallMs:3384},{employees:28,wallMs:4133}],28)).toBe(25);
});

it('narrows a refused pass to the employee it names, or halves it when it names no one',()=>{
 const g=['a','b','c','d','e','f','g','h'];
 // The refusal names d: a runs alone now, b and c are the next group, d runs alone.
 expect(narrowRefusedGroup(g,{rows:[{employmentId:'d'}]})).toEqual({cap:{at:'b',max:2},single:['d']});
 // It names the first employee itself: the rest group as usual.
 expect(narrowRefusedGroup(g,{rows:[{employmentId:'a'}]})).toEqual({cap:null,single:[]});
 // It names the second: b runs alone.
 expect(narrowRefusedGroup(g,{employmentId:'b'})).toEqual({cap:null,single:['b']});
 // c named: b alone (a group of one is the per-employee transaction), then c alone.
 expect(narrowRefusedGroup(g,{rows:[{employmentId:'c'},{employmentId:'f'}]})).toEqual({cap:{at:'b',max:1},single:['c','f']});
 // Names no one: half the group.
 expect(narrowRefusedGroup(g,new Error('refused'))).toEqual({cap:{at:'b',max:4},single:[]});
 expect(narrowRefusedGroup(['a'],new Error('refused'))).toEqual({cap:null,single:[]});
});
