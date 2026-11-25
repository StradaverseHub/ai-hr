/** ADR 0181 decision 5 (Phase 4), migration 7320: trigram-indexed narrowing for employee searches.
 *
 * Row security keeps a non-LEAKPROOF `ilike`/`like` from ever being an index condition in an ai_hr_app read, so a
 * search used to read every visible employment. `app.employment_search_candidates` searches as the table owner with
 * the tenant-led trigram indexes, keeps only employments in the caller's visible set (the same sets employment_rls
 * admits) and returns their ids. Adding `employment.id = any(candidates)` to a caller's own row-secured read lets
 * PostgreSQL fetch those rows by primary key, while row security and the caller's exact matching still decide
 * every row shown: the candidates are a superset of the matches (every non-ASCII name, code or e-mail is always a
 * candidate), never a substitute for them.
 *
 * Only a query of 3 to 200 printable ASCII characters is narrowed (the function's own rule). Anything else returns
 * undefined, and the caller reads exactly as before. */
import {sql,type SQL} from 'drizzle-orm';
import {uuidArrayParam} from '../db/sql-arrays';

const NARROWABLE=/^[ -~]{3,200}$/;

/** Whether a search term is narrowed by the trigram candidates. */
export function isNarrowableEmploymentSearch(query:string|undefined):query is string{
 return typeof query==='string'&&NARROWABLE.test(query);
}

/** `employmentId = any(candidates)` for this search, or undefined when the term is not narrowed. The candidate call
 * is an uncorrelated scalar subquery, so it runs once per statement. `companyIds` undefined or empty = every
 * company the caller may see (the callers' own company predicate still applies). `email` adds primary e-mail. */
export function employmentSearchNarrowing(employmentId:SQL|unknown,query:string|undefined,
 companyIds:readonly string[]|undefined,opts:{email:boolean}):SQL|undefined{
 if(!isNarrowableEmploymentSearch(query))return undefined;
 const companies=companyIds&&companyIds.length?uuidArrayParam(companyIds):sql`null::uuid[]`;
 return sql`${employmentId} = any((select app.employment_search_candidates(${query}::text, ${companies}, ${opts.email}::boolean))::uuid[])`;
}
