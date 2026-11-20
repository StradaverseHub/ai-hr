import {inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {company} from '../db/schema';
import {isModuleEnabled} from './entitlements';
import {visibleLetterDestinations} from '../lib/letter-navigation';

const capabilities=['read','template','generate','approve','report','settings'] as const;
type NavigationAccess=Record<(typeof capabilities)[number],boolean>;

/** Navigation reads the canonical permission predicates in one statement. It takes no workflow
 * mutation locks and exposes only destinations; every destination rechecks its own authority. */
export async function letterNavigation(ctx:SessionContext,scopeIds:readonly string[]){
 if(!scopeIds.length||!isModuleEnabled(ctx,'employees'))return [];
 return withTenant(ctx,async tx=>{
  const permissionColumns=sql.join(capabilities.map(capability=>sql`
   app.letter_permission_for_user(app.current_user_id(), candidates.id, ${capability}) as ${sql.identifier(capability)}
  `),sql`, `);
  const columns=sql.join(capabilities.map(capability=>sql.identifier(capability)),sql`, `);
  const complete=sql.join(capabilities.map(capability=>sql.identifier(capability)),sql` and `);
  // A company with all capabilities proves every menu item. Partial grants
  // still keep each company's capabilities together for the menu predicates.
  const rows=await tx.execute<NavigationAccess>(sql`
   with candidates as materialized (
    select ${company.id} as id from ${company}
    where ${inArray(company.id,[...scopeIds])} and ${company.archivedAt} is null
     and (select app.principal_snapshot_current())
   ), first_company as materialized (
    select candidates.id, ${permissionColumns} from candidates limit 1
   )
   select ${columns} from first_company
   union all
   select ${permissionColumns} from candidates
   where not exists(select 1 from first_company where ${complete})
    and candidates.id <> (select id from first_company)
  `);
  return visibleLetterDestinations(rows);
 });
}
