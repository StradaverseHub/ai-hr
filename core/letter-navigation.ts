import { and, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { company } from '../db/schema';
import { isModuleEnabled } from './entitlements';
import { LETTER_NAV_ITEMS } from '../lib/letter-navigation';

type LetterNavigationFlags = {
  templates: boolean;
  generate: boolean;
  approval: boolean;
  register: boolean;
  reports: boolean;
  settings: boolean;
};

/** Navigation resolves flags under the live principal. Destination pages recheck their own authority. */
export async function letterNavigation(ctx: SessionContext, scopeIds: readonly string[]) {
  if (!scopeIds.length || !isModuleEnabled(ctx, 'employees')) return [];
  return withTenant(ctx, async tx => {
    const scope = tx.select({ id: company.id }).from(company).where(and(
      inArray(company.id, [...scopeIds]), isNull(company.archivedAt), sql`app.principal_snapshot_current()`,
    ));
    const has = (capability: 'read' | 'template' | 'generate' | 'approve' | 'report' | 'settings') =>
      sql`app.letter_permission_for_user(app.current_user_id(), scoped.id, ${capability})`;
    // A compound destination needs both permissions in the same company. Reuse
    // the readable companies so a denied scope skips all three compound checks.
    const [flags] = await tx.execute<LetterNavigationFlags>(sql`
      with scoped as materialized (${scope}),
      readable as materialized (select id from scoped where ${has('read')})
      select
        exists(select 1 from readable) or exists(select 1 from scoped where ${has('template')}) as templates,
        exists(select 1 from readable scoped where ${has('generate')}) as generate,
        exists(select 1 from readable scoped where ${has('approve')}) as approval,
        exists(select 1 from readable) as register,
        exists(select 1 from readable scoped where ${has('report')}) as reports,
        exists(select 1 from scoped where ${has('settings')} or ${has('approve')}) as settings
    `);
    if (!flags) return [];
    const visible = {
      '/letters/templates': flags.templates,
      '/letters/fields': flags.templates,
      '/letters/generate': flags.generate,
      '/letters/approval': flags.approval,
      '/letters/register': flags.register,
      '/letters/reports': flags.reports,
      '/letters/settings': flags.settings,
    } satisfies Record<(typeof LETTER_NAV_ITEMS)[number]['href'], boolean>;
    return LETTER_NAV_ITEMS.flatMap(item => visible[item.href] ? [item.href] : []);
  });
}
