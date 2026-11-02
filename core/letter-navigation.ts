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
  const rows=await tx.select({functionViews:sql<Record<string,boolean>>`jsonb_build_object('/letters/templates',app.letter_function_action('letterTemplates','view',${company.id}),'/letters/fields',app.letter_function_action('letterFields','view',${company.id}),'/letters/generate',app.letter_function_action('letterGenerate','view',${company.id}),'/letters/approval',app.letter_function_action('letterApproval','view',${company.id}),'/letters/register',app.letter_function_action('letterRegister','view',${company.id}),'/letters/reports',app.letter_function_action('letterReports','view',${company.id}),'/letters/settings',app.letter_function_action('letterSettings','view',${company.id}) OR app.letter_function_action('letterSettings.signature','view',${company.id}))`,read:sql<boolean>`app.letter_permission_for_user(app.current_user_id(),${company.id},'read')`,template:sql<boolean>`app.letter_permission_for_user(app.current_user_id(),${company.id},'template')`,generate:sql<boolean>`app.letter_permission_for_user(app.current_user_id(),${company.id},'generate')`,approve:sql<boolean>`app.letter_permission_for_user(app.current_user_id(),${company.id},'approve')`,issue:sql<boolean>`app.letter_permission_for_user(app.current_user_id(),${company.id},'issue')`,report:sql<boolean>`app.letter_permission_for_user(app.current_user_id(),${company.id},'report')`,settings:sql<boolean>`app.letter_permission_for_user(app.current_user_id(),${company.id},'settings')`}).from(company).where(and(inArray(company.id,[...scopeIds]),isNull(company.archivedAt),sql`app.principal_snapshot_current()`));
  return visibleLetterDestinations(rows).filter(href=>rows.some(row=>row.functionViews[href]===true&&visibleLetterDestinations([row]).includes(href)));
 });
}
