/**
 * Board d3ba1e9f (stage f) — Import History's Error Log of a Movement import attempt (registered by
 * core/import-error-log-registry.ts). Built from what the attempt already recorded: the sealed plan (file problems and
 * every refused row, as issue codes since this Error Log, as sentences before), the failed items the confirmation wrote,
 * and the confirmation's own refusal. Lines come from lib/movement-import-problems.ts, the adapter the Movement screen
 * uses, in the viewer's language.
 *
 * Bounded: one attempt read (a Movement file has at most 200 rows and 50 employees) and one set-based
 * company-visibility read; no per-row query and no Access lock.
 *
 * Visibility, as the attempt page and the other Import History sources: the attempt must be visible
 * (getImportAttempt, which also returns only the items of companies the viewer may see). The person who uploaded the
 * file sees every line (they saw them at the check); anyone else sees the employees of companies they can view.
 */
import type {SessionContext} from '../db/client';
import {getImportAttempt} from './import-history';
import {workforceCompanies} from './workforce-access';
import type {MovementImportPlan} from './movement-import-history';
import type {ImportProblemLine} from '../lib/import-problem-lines';
import {movementHistoryProblemLines,movementProblemResolver} from '../lib/movement-import-problems';

/** `t.problems` is a ROOT translator (getTranslations({locale})). */
export async function movementErrorLogFor(
 ctx:SessionContext,
 attemptId:string,
 t:{problems:(key:string,values?:Record<string,unknown>)=>string;shared:(key:string)=>string},
):Promise<{lines:ImportProblemLine[];total:number;truncated:boolean}|null>{
 const item=await getImportAttempt(ctx,attemptId);
 if(!item||item.kind!=='movement')return null;
 const plan=item.plan as unknown as Partial<MovementImportPlan>;
 const own=!!ctx.userId&&item.createdBy===ctx.userId;
 const visible=own?null:new Set(await workforceCompanies(ctx,'view'));
 const employees=(plan.employees??[]).filter(e=>!visible||(!!e.companyId&&visible.has(e.companyId)));
 const byKey=new Map(employees.map(e=>[e.key,e] as const));
 const saveFailures=item.items
  .filter(i=>i.status==='failed'&&i.itemKey.startsWith('failed|')&&byKey.has(i.itemKey.slice('failed|'.length))&&(!visible||visible.has(i.companyId)))
  .map(i=>{const e=byKey.get(i.itemKey.slice('failed|'.length))!;return{ordinal:i.ordinal,employeeCode:e.employeeCode,name:e.name,errors:i.errors??[]};});
 const failed=[...item.events].reverse().find(e=>e.kind==='failed');
 const confirmed=item.events.some(e=>e.kind==='confirmed');
 const lines=movementHistoryProblemLines({
  fileErrors:plan.fileErrors,
  fileIssues:plan.issues??[],
  employees,
  saveFailures,
  failure:!confirmed&&typeof failed?.detail.message==='string'?failed.detail.message:null,
 },movementProblemResolver(key=>t.problems(key)));
 return{lines,total:lines.length,truncated:false};
}
