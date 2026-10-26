import {and,inArray,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {company} from '../db/schema';
import {isModuleEnabled} from './entitlements';
import {visibleLetterDestinations} from '../lib/letter-navigation';
/** Navigation reads the canonical permission predicates in one statement. It takes no workflow
 * mutation locks and exposes only destinations; every destination rechecks its own authority. */
export async function letterNavigation(ctx:SessionContext,scopeIds:readonly string[]){
 if(!scopeIds.length||!isModuleEnabled(ctx,'employees'))return [];
 return withTenant(ctx,async tx=>{
  const rows=await tx.select({read:sql<boolean>`app.letter_permission_for_user(app.current_user_id(),${company.id},'read')`,template:sql<boolean>`app.letter_permission_for_user(app.current_user_id(),${company.id},'template')`,generate:sql<boolean>`app.letter_permission_for_user(app.current_user_id(),${company.id},'generate')`,approve:sql<boolean>`app.letter_permission_for_user(app.current_user_id(),${company.id},'approve')`,issue:sql<boolean>`app.letter_permission_for_user(app.current_user_id(),${company.id},'issue')`,report:sql<boolean>`app.letter_permission_for_user(app.current_user_id(),${company.id},'report')`,settings:sql<boolean>`app.letter_permission_for_user(app.current_user_id(),${company.id},'settings')`}).from(company).where(and(inArray(company.id,[...scopeIds]),isNull(company.archivedAt),sql`app.principal_snapshot_current()`));
  return visibleLetterDestinations(rows);
 });
}
