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
 * 7530: the candidates are asked once per search, in their own statement of the caller's transaction, and passed to
 * the caller's statements as a literal list, so a page and its count share one search and the planner knows the
 * list's size. The function answers NULL when narrowing would cost more than the read before 7320 (named companies
 * with few employments, or very many matches all in the caller's administered companies); the caller then reads
 * exactly as before. Only a query of 3 to 200 printable ASCII characters is narrowed at all. */
import {sql,type SQL} from 'drizzle-orm';
import type {Tx} from '../db/client';
import {uuidArrayParam} from '../db/sql-arrays';

const NARROWABLE=/^[ -~]{3,200}$/;

/** Whether a search term is narrowed by the trigram candidates. */
export function isNarrowableEmploymentSearch(query:string|undefined):query is string{
 return typeof query==='string'&&NARROWABLE.test(query);
}

/** `employmentId = any(<candidate ids>)` for this search, or undefined when the search is not narrowed (the caller
 * reads as before 7320). Asks the candidates once, in `tx`, under the caller's own session claims. `companyIds`
 * undefined or empty = every company the caller may see (the callers' own company predicate still applies).
 * `email` adds primary e-mail. */
export async function employmentSearchNarrowingTx(tx:Tx,employmentId:SQL|unknown,query:string|undefined,
 companyIds:readonly string[]|undefined,opts:{email:boolean}):Promise<SQL|undefined>{
 if(!isNarrowableEmploymentSearch(query))return undefined;
 const companies=companyIds&&companyIds.length?uuidArrayParam(companyIds):sql`null::uuid[]`;
 const [row]=await tx.execute<{ids:string[]|null}>(
  sql`select app.employment_search_candidates(${query}::text, ${companies}, ${opts.email}::boolean) as ids`);
 const ids=row?.ids;
 if(ids==null)return undefined;
 return sql`${employmentId} = any(${uuidArrayParam(ids)})`;
}
