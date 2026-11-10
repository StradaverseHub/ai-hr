import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { canAdminRecruitment, withEffectiveGrants } from '@/lib/authz';
import { cn } from '@/lib/utils';
import { ensureRecruitmentDefaults, recruitmentCompanies, RECRUITMENT_ERROR_CODES, type RecruitmentCompany } from '@/packs/recruitment/service';

/**
 * The second half of every Recruitment page's gate (the first is requireModule + scopedSession in the page):
 * only recruitment administrators — HR administrators and the company-scoped Recruiting Partner (ADR-0049) —
 * get in, and only for the companies in their current scope that the DATABASE says they administer. Opening a
 * company's Recruitment gives it its editable defaults once (idempotent).
 */
export async function recruitmentAccess(s: SessionContext, scopeIds: string[], seed = true): Promise<RecruitmentCompany[]> {
  if (!canAdminRecruitment(withEffectiveGrants(s))) redirect('/');
  const companies = await recruitmentCompanies(s, scopeIds);
  if (seed && companies.length) await ensureRecruitmentDefaults(s, companies.map((c) => c.id));
  return companies;
}

/** The company a single-company screen works on: the requested one if the viewer may use it, else the first. */
export function pickCompany(companies: readonly RecruitmentCompany[], requested?: string): RecruitmentCompany | undefined {
  return companies.find((c) => c.id === requested) ?? companies[0];
}

const TABS = [
  { key: 'overview', href: '/recruitment' },
  { key: 'candidates', href: '/recruitment/candidates' },
  { key: 'positions', href: '/recruitment/positions' },
  { key: 'settings', href: '/recruitment/settings' },
] as const;

/** The module's own sub-navigation: Overview, Candidates, Positions, Settings (one menu entry, F1). */
export async function RecruitmentTabs({ active }: { active: (typeof TABS)[number]['key'] }) {
  const t = await getTranslations('recruitment.tabs');
  const label = { overview: t('overview'), candidates: t('candidates'), positions: t('positions'), settings: t('settings') };
  return (
    <nav aria-label={t('label')} className="flex flex-wrap gap-1 border-b border-border">
      {TABS.map((tab) => (
        <Link key={tab.key} href={tab.href} aria-current={tab.key === active ? 'page' : undefined}
          className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            tab.key === active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
          {label[tab.key]}
        </Link>
      ))}
    </nav>
  );
}

/** A refusal code from ?error=, in the viewer's language. Unknown text is never echoed back. */
export async function recruitmentErrorText(code?: string): Promise<string | undefined> {
  if (!code) return undefined;
  const t = await getTranslations('recruitment.errors');
  return (RECRUITMENT_ERROR_CODES as readonly string[]).includes(code) ? t(code as (typeof RECRUITMENT_ERROR_CODES)[number]) : t('unexpected');
}

/** Shown when none of the viewer's companies in the current scope has Recruitment they administer. */
export async function NoRecruitmentCompany() {
  const t = await getTranslations('recruitment');
  return <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('noCompany')}</p>;
}

export function Notice({ text }: { text?: string }) {
  if (!text) return null;
  return <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-300">{text}</div>;
}

export const selectCls = 'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';
