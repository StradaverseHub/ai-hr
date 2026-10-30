/** Unmounted contract proposal; authored only until review/allocation permits hosted verification. */
import {expect,it} from 'vitest';
import {DayOvertimeCorrection as C} from '../lib/assistant-actions/day-overtime-correction-contract';
import {otHuman,otPrepared,otCompleted,otIds,otFirstAdjustmentReset} from './helpers/day-overtime-review-fixture';
it('accepts exact existing-row proposals and distinguishes explicit zero from null Auto',()=>{
 expect(C.Human.parse(otHuman)).toEqual(otHuman);
 expect(C.Human.parse({...otHuman,rows:[{key:'fictional-first',minutes:0}]}).rows[0].minutes).toBe(0);
 expect(C.Human.parse({...otHuman,rows:[{key:'fictional-first',minutes:null}]}).rows[0].minutes).toBeNull();
});
it('rejects actor, amount, captured clock, schedule and posted native provenance fields',()=>{
 for(const extra of [{userId:otIds.event},{companyId:otIds.event},{actor:'system'},{amountMinorUnits:'2500'},{punches:[]},{shiftId:null},{dayKind:'holiday'},{eventId:otIds.event}])expect(C.Human.safeParse({...otHuman,...extra}).success).toBe(false);
 expect(C.Human.safeParse({...otHuman,rows:[{key:'fictional-first',minutes:30,bucket:'ot15',recordedAt:'2026-10-30T12:00:00.000Z'}]}).success).toBe(false);
});
it('rejects malformed dates, missing nomination/baseline/consent and duplicate, fractional or out-of-range rows',()=>{
 for(const value of [{...otHuman,date:'2026-02-30'},{...otHuman,subjectId:otIds.event},{...otHuman,baseline:undefined},{...otHuman,confirmPayrollRecalculation:undefined},{...otHuman,rows:[]},{...otHuman,rows:[{key:'x',minutes:1},{key:'x',minutes:null}]},{...otHuman,rows:[{key:'x',minutes:1.5}]},{...otHuman,rows:[{key:'x',minutes:1441}]},{...otHuman,rows:[{key:'x',minutes:-1}]},{...otHuman,rows:[{key:'x'}]},{...otHuman,reason:' '}])expect(C.Human.safeParse(value).success).toBe(false);
});
it('bounds row transport independently in code units and UTF-8 bytes without truncating keys',()=>{
 expect(C.Human.safeParse({...otHuman,rows:Array.from({length:40},(_,n)=>({key:String(n)+'x'.repeat(498),minutes:null}))}).success).toBe(false);
 expect(C.Human.safeParse({...otHuman,rows:Array.from({length:40},(_,n)=>({key:String(n)+'ழ'.repeat(200),minutes:null}))}).success).toBe(false);
});
it('binds native displayed manual and approved Auto results, with native refusal rather than invented money',()=>{
 const v=otPrepared();expect(C.Prepared.safeParse(v).success).toBe(true);expect(v.review.after.pattern.amountMinorUnits).toBeNull();expect(v.review.after.pattern.approvalStatus).toBe('unknown');
 expect(v.review.before.legacyRows[1].calculatedMinutes).toBe(120);expect(v.review.after.legacyRows[1].effectiveMinutes).toBe(80);
 const wrong=structuredClone(v);wrong.review.after.legacyRows[1].effectiveMinutes=120;expect(C.Prepared.safeParse(wrong).success).toBe(false);
});
it('refuses substituted subject/date/reason, missing payroll consent or changed schedule overrides',()=>{
 const value=otPrepared();for(const content of [{...value.content,date:'2026-10-31'},{...value.content,reason:'Other reason'},{...value.content,confirmPayrollRecalculation:false},{...value.content,employmentId:otIds.event,subjectId:otIds.event}])expect(C.Prepared.safeParse({...value,content}).success).toBe(false);
 const changed=structuredClone(value);changed.review.after.override.shiftId=null;expect(C.Prepared.safeParse(changed).success).toBe(false);
 const changedKind=structuredClone(value);changedKind.review.after.override.dayKind='holiday';expect(C.Prepared.safeParse(changedKind).success).toBe(false);
});
it('rejects foreign selected keys or changes to an unselected manual row',()=>{
 const foreign=otPrepared();foreign.content.rows[0].key='foreign';expect(C.Prepared.safeParse(foreign).success).toBe(false);
 const collateral=otPrepared();collateral.review.after.legacyRows[2].manualMinutes=11;expect(C.Prepared.safeParse(collateral).success).toBe(false);
});
it('binds newly recorded manual calculation facts and preserves the unselected original calculation',()=>{
 const wrong=otPrepared();wrong.review.after.legacyRows[0].manualCalculatedMinutes=61;expect(C.Prepared.safeParse(wrong).success).toBe(false);
 const changed=otPrepared();changed.review.after.legacyRows[2].manualCalculatedMinutes=1;expect(C.Prepared.safeParse(changed).success).toBe(false);
});
it('allows an explicit orphan reset on an incomplete day while retaining the other native rows',()=>{
 const v=otPrepared();v.content.rows=[{key:'fictional-orphan',minutes:null}];v.review.before.complete=false;v.review.after.complete=false;v.review.before.day=null;v.review.after.day=null;
 v.review.before.legacyRows=v.review.before.legacyRows.map(row=>({...row,calculatedMinutes:0,autoEffectiveMinutes:0,effectiveMinutes:row.manualMinutes??0}));
 v.review.after.legacyRows=structuredClone(v.review.before.legacyRows);v.review.after.pattern=structuredClone(v.review.before.pattern);
 v.review.before.legacyRows.push({...v.review.before.legacyRows[2],key:'fictional-orphan',orphan:true});
 expect(C.Prepared.safeParse(v).success).toBe(true);
});
it('represents native first-adjustment creation for an explicit Auto reset without inventing a calculated day',()=>{
 const v=otFirstAdjustmentReset();expect(C.Prepared.safeParse(v).success).toBe(true);expect(v.review.before.override.version).toBe(0);expect(v.review.after.override.version).toBe(1);expect(v.review.after.day).toBeNull();
 const receipt=otCompleted();receipt.receipt.version=1;receipt.receipt.rows=v.content.rows;receipt.receipt.before=v.review.before;receipt.receipt.after=v.review.after;expect(C.Completed.safeParse(receipt).success).toBe(true);
});
it('requires an actual versioned adjustment/event receipt and rejects shape-only no-op completion',()=>{
 const v=otCompleted();expect(C.Completed.safeParse(v).success).toBe(true);
 expect(C.Completed.safeParse({...v,receipt:{...v.receipt,eventId:undefined}}).success).toBe(false);
 const sameVersion=structuredClone(v);sameVersion.receipt.after.override.version=2;sameVersion.receipt.version=2;expect(C.Completed.safeParse(sameVersion).success).toBe(false);
 const substituted=structuredClone(v);substituted.receipt.rows=[{key:'foreign',minutes:null}];expect(C.Completed.safeParse(substituted).success).toBe(false);
});
it('refuses an otherwise shaped review whose total body exceeds the public budget',()=>{
 const v=otPrepared();v.review.employeeName='x'.repeat(4000);v.review.companyName='x'.repeat(4000);
 v.review.before.pattern.cashIssues=Array.from({length:6},()=>({code:'unknown',path:'approval.minutes',severity:'error' as const,detail:'x'.repeat(4000)}));
 v.review.after.pattern.cashIssues=structuredClone(v.review.before.pattern.cashIssues);
 expect(C.Prepared.safeParse(v).success).toBe(false);
});
