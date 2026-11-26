/** ADR 0181 decision 5 (Phase 4), migrations 7320 and 7530: trigram-indexed narrowing for employee searches.
 *
 * Row security keeps a non-LEAKPROOF `ilike`/`like` from ever being an index condition in an ai_hr_app read, so a
 * search used to read every visible employment. `app.employment_search_candidates` searches as the table owner with
 * the tenant-led trigram indexes, keeps only employments in the caller's visible set (the same sets employment_rls
 * admits) and returns their ids. Adding `employment.id = any(candidates)` to a caller's own row-secured read lets
 * PostgreSQL fetch those rows by primary key, while row security and the caller's exact matching still decide
 * every row shown: the candidates are a superset of the matches (every non-ASCII name, code or e-mail is always a
 * candidate), never a substitute for them.
 *
 * 7530: narrowing pays only where the caller's own read is costly: row security asks partner and relationship
 * questions for every row outside the companies the caller administers or partners. A group-wide administrator, or a
 * caller whose grants name every company asked, is never narrowed (not asked at all). For anyone else the function
 * answers NULL (do not narrow) when at most 1,000 employments in scope lie outside those companies, and the caller then reads exactly as before 7320. When it does
 * narrow, the candidates are asked once per search, in their own statement of the caller's transaction, and passed to
 * the caller's statements as a literal list. Only a query of 3 to 200 printable ASCII characters is narrowed at all. */
import {sql,type SQL} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {uuidArrayParam} from '../db/sql-arrays';

const NARROWABLE=/^[ -~]{3,200}$/;

/** Whether a search term is narrowed by the trigram candidates. */
export function isNarrowableEmploymentSearch(query:string|undefined):query is string{
 return typeof query==='string'&&NARROWABLE.test(query);
}

/** Roles whose grant lets row security admit a company's rows by the company question alone (app.is_admin_for,
 * app.can_admin_payroll_for, app.can_admin_perfcomp_for). */
const COMPANY_READ_ROLES=new Set(['hr_admin','super_admin','payroll_partner','performance_comp_partner']);

/** Whether the caller's own grants already make their read cheap, so narrowing cannot pay: a group-wide administrator
 * (app.allowedCompanies' own rule for "group admin"), or grants naming every company asked. A performance decision
 * only: row security still decides every row either way. */
function readIsCheapByGrants(ctx:Pick<SessionContext,'grants'>,companyIds:readonly string[]|undefined):boolean{
 const grants=ctx.grants??[];
 if(grants.some(grant=>(grant.role==='hr_admin'||grant.role==='super_admin')&&!grant.companyId))return true;
 if(!companyIds?.length)return false;
 const named=new Set(grants.filter(grant=>COMPANY_READ_ROLES.has(grant.role)&&grant.companyId).map(grant=>grant.companyId));
 return companyIds.every(id=>named.has(id));
}

/** `employmentId = any(<candidate ids>)` for this search, or undefined when the search is not narrowed (the caller
 * reads as before 7320). Asks the candidates once, in `tx`, under the caller's own session claims. `companyIds`
 * undefined or empty = every company the caller may see (the callers' own company predicate still applies).
 * `email` adds primary e-mail. */
export async function employmentSearchNarrowingTx(tx:Tx,ctx:Pick<SessionContext,'grants'>,employmentId:SQL|unknown,query:string|undefined,
 companyIds:readonly string[]|undefined,opts:{email:boolean}):Promise<SQL|undefined>{
 if(!isNarrowableEmploymentSearch(query)||readIsCheapByGrants(ctx,companyIds))return undefined;
 const companies=companyIds&&companyIds.length?uuidArrayParam(companyIds):sql`null::uuid[]`;
 const [row]=await tx.execute<{ids:string[]|null}>(
  sql`select app.employment_search_candidates(${query}::text, ${companies}, ${opts.email}::boolean) as ids`);
 const ids=row?.ids;
 if(ids==null)return undefined;
 return sql`${employmentId} = any(${uuidArrayParam(ids)})`;
}
