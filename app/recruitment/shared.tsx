import Link from 'next/link';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { canAdminRecruitment, withEffectiveGrants } from '@/lib/authz';
import { cn } from '@/lib/utils';
import {
  ensureRecruitmentDefaults, recruitmentCompanies, recruitmentViewer, RECRUITMENT_ERROR_CODES, SCREENING_LIST_LIMIT, type RecruitmentCompany, type RecruitmentViewer,
} from '@/packs/recruitment/service';

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

export type RecruitmentAccess = RecruitmentViewer & {
  /** Administered companies first, then team companies: every company whose recruitment rows the viewer may see. */
  companies: RecruitmentCompany[];
  isAdmin: boolean;
};

/**
 * The gate of the pages a job-team member may open too (Candidates, Interviews, Positions, an application, feedback
 * and approvals): administrators of a company in scope, members of a job team or interviewers there, or anyone with an
 * approval step waiting for them. The DATABASE answers each part (4402); nobody else gets in.
 */
export async function recruitmentViewerAccess(s: SessionContext, scopeIds: string[], opts: { afterDecision?: boolean } = {}): Promise<RecruitmentAccess> {
  const viewer = await recruitmentViewer(s, scopeIds);
  // An approver whose last waiting step was just decided keeps the Approvals page for its confirmation; it lists
  // nothing more for them (every list there is the database's own answer for the viewer).
  if (!viewer.adminCompanies.length && !viewer.teamCompanies.length && !viewer.pendingApprovals && !opts.afterDecision) redirect('/');
  if (viewer.adminCompanies.length) await ensureRecruitmentDefaults(s, viewer.adminCompanies.map((c) => c.id));
  return { ...viewer, companies: [...viewer.adminCompanies, ...viewer.teamCompanies], isAdmin: viewer.adminCompanies.length > 0 };
}

/** The company a single-company screen works on: the requested one if the viewer may use it, else the first. */
export function pickCompany(companies: readonly RecruitmentCompany[], requested?: string): RecruitmentCompany | undefined {
  return companies.find((c) => c.id === requested) ?? companies[0];
}

const TABS = [
  { key: 'overview', href: '/recruitment', adminOnly: false },
  { key: 'candidates', href: '/recruitment/candidates', adminOnly: false },
  { key: 'screening', href: '/recruitment/screening', adminOnly: false },
  { key: 'interviews', href: '/recruitment/interviews', adminOnly: false },
  { key: 'positions', href: '/recruitment/positions', adminOnly: false },
  { key: 'talentPool', href: '/recruitment/talent-pool', adminOnly: true },
  { key: 'reports', href: '/recruitment/reports', adminOnly: false },
  { key: 'approvals', href: '/recruitment/approvals', adminOnly: false },
  { key: 'settings', href: '/recruitment/settings', adminOnly: true },
] as const;
export type RecruitmentTabKey = (typeof TABS)[number]['key'];

/**
 * The module's own sub-navigation (one menu entry, F1): Overview, Candidates, Interviews, Positions, Talent pool,
 * Reports, Approvals and Settings. A job-team member sees Candidates, Interviews and Positions (their own jobs); Reports
 * shows for administrators and for a job's recruiter, assistant or hiring manager (`reports`; never an interviewer
 * alone); Approvals shows when a step waits for the viewer; Talent pool and Settings are administrator-only. Overview
 * shows for everyone with Recruitment access since slice 9 (its Tasks panel); its tiles stay administrator-only. To screen
 * (slice 11) shows, with its count, while the viewer has open screening requests (or is on it).
 */
export async function RecruitmentTabs({ active, admin = true, approvals = 0, reports = false, screening = 0 }: {
  active: RecruitmentTabKey; admin?: boolean; approvals?: number; reports?: boolean; screening?: number;
}) {
  const t = await getTranslations('recruitment.tabs');
  const label: Record<RecruitmentTabKey, string> = {
    overview: t('overview'), candidates: t('candidates'), screening: t('screening'), interviews: t('interviews'), positions: t('positions'), talentPool: t('talentPool'),
    reports: t('reports'), approvals: t('approvals'), settings: t('settings'),
  };
  const shown = TABS.filter((tab) => (admin || !tab.adminOnly) && (tab.key !== 'approvals' || approvals > 0 || active === 'approvals')
    && (tab.key !== 'reports' || admin || reports || active === 'reports') && (tab.key !== 'screening' || screening > 0 || active === 'screening'));
  const count = (key: RecruitmentTabKey) => (key === 'approvals' ? approvals : key === 'screening' ? screening : 0);
  return (
    <nav aria-label={t('label')} className="flex flex-wrap gap-1 border-b border-border">
      {shown.map((tab) => (
        <Link key={tab.key} href={tab.href} aria-current={tab.key === active ? 'page' : undefined}
          className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            tab.key === active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
          {label[tab.key]}{count(tab.key) > 0 && <span className="ml-1 rounded-full bg-primary/15 px-1.5 text-xs tabular-nums text-foreground">
            {tab.key === 'screening' && count(tab.key) > SCREENING_LIST_LIMIT ? `${SCREENING_LIST_LIMIT}+` : count(tab.key)}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** A refusal code from ?problem= (Recruitment's own parameter: the global toast consumes ?error=), in the viewer's language.
 *  Unknown text is never echoed back. */
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

/** A small status pill with a tone. The text always states the status; colour only reinforces it. */
export function Pill({ tone = 'neutral', children }: { tone?: 'neutral' | 'info' | 'good' | 'warn' | 'bad'; children: ReactNode }) {
  const cls = {
    neutral: 'border-border bg-muted text-muted-foreground',
    info: 'border-sky-500/30 bg-sky-500/10 text-sky-800 dark:text-sky-300',
    good: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300',
    bad: 'border-destructive/30 bg-destructive/10 text-destructive',
  }[tone];
  return <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', cls)}>{children}</span>;
}

/** Sub-tabs inside a page (e.g. Positions | Job requisitions, or an application's sections). */
export function SubTabs({ label, items }: { label: string; items: { key: string; href: string; text: string; current: boolean }[] }) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1 border-b border-border">
      {items.map((i) => (
        <Link key={i.key} href={i.href} aria-current={i.current ? 'page' : undefined}
          className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium', i.current ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
          {i.text}
        </Link>
      ))}
    </nav>
  );
}

export const textareaCls = 'w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';
/** Kuala Lumpur date / date-time text for an ISO instant, in the viewer's locale. */
export const klDate = (locale: string, iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(iso));
export const klDateTime = (locale: string, iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(iso));
