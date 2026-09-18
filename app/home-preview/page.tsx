/**
 * REVAMP PREVIEW — the action-first Home from the revamp plan, rendered against REAL data.
 *
 * WHY A SEPARATE ROUTE AND NOT `app/page.tsx`. The real Home is a per-user, per-role customizable card
 * grid (`app/dashboard-layout-actions.ts`, saved `dashboard_layout` rows). Replacing it in place would
 * either ignore or reset layouts people already saved, and the plan says that conversion is its own
 * round. This route exists so the shape can be judged on a screen before anything is migrated.
 *
 * ENGLISH STRINGS ARE DELIBERATE AND DISQUALIFY THIS FILE FROM SHIPPING. Every shipping screen takes its
 * words from `messages/*.json` in six locales (ADR-0016). A preview that invented 40 keys would have to
 * invent their five translations too, so the copy here is hard-coded and this file must not merge as it
 * stands — the layout is what is up for review, not the wording.
 *
 * WHAT IS REAL: every figure below is read live, through the same functions the existing screens use, at
 * the caller's own authorization (RLS). Nothing is stubbed, and no number is computed here.
 * WHAT IS NOT: the row actions link out rather than deciding in place — an inline Approve belongs to the
 * work-queue round, which is where the one queue the counts come from gets built.
 */
import Link from 'next/link';
import {
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  Clock,
  FileText,
  Inbox,
  Landmark,
  Lightbulb,
  Plane,
  Receipt,
  UserMinus,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { listPendingTasks, type PendingTaskItem } from '@/core/approvals-inbox';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { listCompanies, plannedAbsences, recentHires } from '@/core/read';
import { recordReadiness, type ReadinessBlocks } from '@/core/record-readiness';
import { payrollReadiness } from '@/core/payroll-readiness';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { Card } from '@/components/ui/card';

/** What a gap stops, in the words the consequence deserves — the code's own ranking, not a new one. */
const BLOCKS_LABEL: Record<ReadinessBlocks, string> = {
  payroll: 'stops the run',
  payment: 'stops payment',
  statutory_filing: 'stops statutory filing',
};

const GAP_LABEL: Record<string, string> = {
  no_compensation: 'Pay not set up',
  no_bank_account: 'Bank account missing',
  no_identity: 'No IC or passport on record',
  no_tax_number: 'Tax number missing',
  no_epf_number: 'EPF number missing',
  no_socso_number: 'SOCSO number missing',
};

const KIND_LABEL: Record<PendingTaskItem['kind'], string> = {
  leave: 'Leave request',
  leaveCancellation: 'Leave cancellation',
  attendance: 'Attendance correction',
  travel: 'Travel request',
  profile: 'Profile change',
  claim: 'Claim',
  resignation: 'Resignation',
  managerReview: 'Review to submit',
  hrReview: 'Review to confirm',
};

const KIND_ICON: Record<PendingTaskItem['kind'], typeof Plane> = {
  leave: Plane,
  leaveCancellation: Plane,
  attendance: Clock,
  travel: Plane,
  profile: Users,
  claim: Receipt,
  resignation: UserMinus,
  managerReview: FileText,
  hrReview: FileText,
};

const GAP_ICON: Record<string, typeof Landmark> = {
  no_compensation: Wallet,
  no_bank_account: Landmark,
};

function waitedLabel(createdAt: string, todayIso: string): { text: string; days: number } {
  const days = Math.max(
    0,
    Math.round((Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(createdAt)) / 86_400_000),
  );
  if (days <= 0) return { text: 'today', days };
  return { text: days === 1 ? 'waiting 1 day' : `waiting ${days} days`, days };
}

function Pill({ tone, children }: { tone: 'good' | 'warning' | 'critical' | 'info' | 'neutral'; children: React.ReactNode }) {
  const tones = {
    good: 'bg-good-bg text-good',
    warning: 'bg-warning-bg text-warning',
    critical: 'bg-critical-bg text-critical',
    info: 'bg-info-bg text-info',
    neutral: 'bg-neutral-bg text-neutral',
  } as const;
  return (
    <span className={`inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  pill,
}: {
  icon: typeof Users;
  label: string;
  value: string | number;
  sub?: string;
  pill?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 first:pl-2 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-border">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground text-background">
        <Icon className="size-4" strokeWidth={2} />
      </span>
      <div className="min-w-0">
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        <div className="mt-0.5 flex items-baseline gap-1.5 text-xl font-semibold tabular-nums">
          {value}
          {sub && <span className="text-xs font-normal text-muted-foreground">{sub}</span>}
        </div>
      </div>
      {pill && <div className="ml-auto self-end">{pill}</div>}
    </div>
  );
}

function SectionHead({ icon: Icon, title, meta, count }: { icon: typeof Users; title: string; meta?: string; count?: number }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-foreground text-background">
        <Icon className="size-3.5" strokeWidth={2} />
      </span>
      <h2 className="text-sm font-semibold">{title}</h2>
      {count !== undefined && (
        <span className="rounded-md bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground tabular-nums">{count}</span>
      )}
      {meta && <span className="truncate text-xs text-muted-foreground">{meta}</span>}
    </div>
  );
}

export default async function HomePreviewPage() {
  const { s, scopeIds } = await scopedSession();
  const admin = isAdmin(s);
  const todayIso = todayInKualaLumpur();
  const since60 = new Date(Date.parse(`${todayIso}T00:00:00Z`) - 60 * 86_400_000).toISOString().slice(0, 10);

  // Same gate the root layout and the bell use: an optional pack a tenant declined must cost its own
  // queue, not the page (r292).
  const [attendanceOn, claimsOn] = await Promise.all([
    isModuleEnabledOrFalse(s, 'attendance'),
    isModuleEnabledOrFalse(s, 'claims'),
  ]);

  const [tasks, absences, hires, companies, readiness] = await Promise.all([
    listPendingTasks(s, scopeIds, { attendance: attendanceOn, claims: claimsOn }),
    plannedAbsences(s, scopeIds, { from: todayIso, to: todayIso }, todayIso),
    recentHires(s, scopeIds, { since: since60, limit: 5 }),
    listCompanies(s),
    // Admin-only, exactly as on Control Tower: a manager cannot read the whole tenant's record gaps.
    admin ? recordReadiness(s, { peopleLimit: 5 }) : Promise.resolve(null),
  ]);

  const payroll = admin
    ? await Promise.all(
        companies.map(async (c) => ({ company: c, readiness: await payrollReadiness(s, { companyId: c.id }) })),
      )
    : [];

  const awayToday = absences.filter((p) => p.leaves.length > 0);
  const blockers = payroll.reduce((n, p) => n + p.readiness.blockers, 0);
  const warnings = payroll.reduce((n, p) => n + p.readiness.warnings, 0);
  const gaps = readiness?.gaps ?? [];
  const overdue = tasks.filter((t) => waitedLabel(t.createdAt, todayIso).days >= 3);
  const runState = blockers > 0 ? 'Not ready' : warnings > 0 ? 'Warnings' : 'Ready';
  // The one insight sentence, built from counts by a fixed rule. No model writes this.
  // Ties break on CONSEQUENCE, not alphabetically: with 3 people missing a bank account and 3 missing a
  // tax number, "stops payment" is the one to name first. recordReadiness already returns the gaps in
  // that order (BLOCK_RANK: payroll → payment → statutory_filing), so a stable sort on count alone
  // keeps it; re-deriving the rank here would be a second copy of the same ordering.
  const biggestGap = gaps.length ? gaps.reduce((best, g) => (g.count > best.count ? g : best), gaps[0]!) : undefined;

  return (
    <div className="mx-auto w-full max-w-[1400px] px-1">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-lg font-semibold tracking-tight">
          {new Date(`${todayIso}T00:00:00Z`).toLocaleDateString('en-GB', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            timeZone: 'UTC',
          })}
        </h1>
        <span className="text-xs text-muted-foreground">
          Revamp preview · real data · the live Home is still at <Link href="/" className="underline">/</Link>
        </span>
      </div>

      {overdue.length > 0 && (
        <div className="mb-2.5 flex flex-wrap items-center gap-3 rounded-xl bg-warning-bg px-3 py-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-warning text-background">
            <Clock className="size-3.5" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-warning">
              {overdue.length === 1 ? '1 request has' : `${overdue.length} requests have`} been waiting three days or more
            </div>
            <div className="text-xs text-warning/80">The oldest is {waitedLabel(overdue[overdue.length - 1]!.createdAt, todayIso).text}.</div>
          </div>
          <Link href="/approvals" className="ml-auto rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background">
            Open them
          </Link>
        </div>
      )}

      <div className="mb-2.5 grid grid-cols-2 gap-y-4 rounded-2xl bg-card py-3 shadow-card lg:grid-cols-4">
        <Kpi icon={Users} label="Away today" value={awayToday.length} pill={<Pill tone="neutral">leave</Pill>} />
        <Kpi
          icon={Inbox}
          label="Waiting for you"
          value={tasks.length}
          pill={overdue.length > 0 ? <Pill tone="critical">{overdue.length} old</Pill> : undefined}
        />
        <Kpi
          icon={AlertTriangle}
          label="Record gaps"
          value={admin ? gaps.reduce((n, g) => n + g.count, 0) : '—'}
          sub={admin ? `across ${readiness?.employees ?? 0} people` : 'admin only'}
        />
        <Kpi
          icon={Wallet}
          label="Payroll this month"
          value={admin ? runState : '—'}
          pill={admin && blockers > 0 ? <Pill tone="critical">{blockers} blocking</Pill> : admin && warnings > 0 ? <Pill tone="warning">{warnings} warnings</Pill> : undefined}
        />
      </div>

      <div className="mb-2.5 grid gap-2.5 lg:grid-cols-[1.25fr_1fr]">
        <Card className="p-3.5">
          <SectionHead icon={Inbox} title="Needs your decision" count={tasks.length} />
          {tasks.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Nothing is waiting for you.</p>}
          <ul>
            {tasks.slice(0, 7).map((t) => {
              const Icon = KIND_ICON[t.kind];
              const waited = waitedLabel(t.createdAt, todayIso);
              return (
                <li key={`${t.kind}-${t.id}`} className="flex items-center gap-3 border-t border-border/60 py-2 first:border-t-0">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                    <Icon className="size-3.5" strokeWidth={2} />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold">
                      {KIND_LABEL[t.kind]} · {t.subjectName ?? 'Unnamed'}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">{waited.text}</div>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    {waited.days >= 3 && <Pill tone="critical">old</Pill>}
                    <Link
                      href={t.linkPath}
                      className="rounded-lg px-2.5 py-1 text-[11px] font-semibold shadow-[inset_0_0_0_1px_var(--border)]"
                    >
                      View
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card className="p-3.5">
          <SectionHead icon={CalendarDays} title="Today" meta="who is not at their desk" />
          {awayToday.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Everybody in your scope is in today.</p>}
          <ul>
            {awayToday.slice(0, 7).map((p) => (
              <li key={p.id} className="flex items-center gap-3 border-t border-border/60 py-2 first:border-t-0">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground">
                  {p.name.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold">{p.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{p.role ?? '—'}</div>
                </div>
                <div className="ml-auto">
                  {p.leaves.some((l) => l.status === 'approved') ? <Pill tone="info">On leave</Pill> : <Pill tone="warning">Leave pending</Pill>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid gap-2.5 lg:grid-cols-3">
        <Card className="p-3.5">
          <SectionHead icon={Wallet} title="Before this month's payroll" />
          {!admin && <p className="py-6 text-center text-sm text-muted-foreground">Visible to HR admins.</p>}
          {admin && gaps.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No record gaps. Every active person can be paid and filed for.</p>}
          <ul>
            {gaps.map((g) => {
              const Icon = GAP_ICON[g.id] ?? AlertTriangle;
              return (
                <li key={g.id} className="flex items-center gap-3 border-t border-border/60 py-2 first:border-t-0">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                    <Icon className="size-3.5" strokeWidth={2} />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold">{GAP_LABEL[g.id] ?? g.id}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {g.count} {g.count === 1 ? 'person' : 'people'} · {BLOCKS_LABEL[g.blocks]}
                    </div>
                  </div>
                  <Link
                    href="/control-tower/readiness"
                    className="ml-auto rounded-lg px-2.5 py-1 text-[11px] font-semibold shadow-[inset_0_0_0_1px_var(--border)]"
                  >
                    Fix
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card className="p-3.5">
          <SectionHead icon={UserPlus} title="Joined recently" meta="last 60 days" />
          {hires.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Nobody joined in the last 60 days.</p>}
          <ul>
            {hires.map((h) => (
              <li key={h.employmentId} className="flex items-center gap-3 border-t border-border/60 py-2 first:border-t-0">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground">
                  {h.name.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold">{h.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{h.hiredOn}</div>
                </div>
                <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-3.5">
          <SectionHead icon={CalendarDays} title="By company" />
          {!admin && <p className="py-6 text-center text-sm text-muted-foreground">Visible to HR admins.</p>}
          <ul>
            {payroll.map(({ company, readiness: r }) => (
              <li key={company.id} className="flex items-center gap-3 border-t border-border/60 py-2 first:border-t-0">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold">{company.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {r.blockers} blocking · {r.warnings} warnings
                  </div>
                </div>
                <div className="ml-auto">
                  {r.blockers > 0 ? <Pill tone="critical">Not ready</Pill> : r.warnings > 0 ? <Pill tone="warning">Warnings</Pill> : <Pill tone="good">Ready</Pill>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {admin && biggestGap && (
        <div className="mt-2.5 flex items-start gap-2.5 rounded-xl bg-info-bg px-3 py-2.5 text-[13px] text-info">
          <Lightbulb className="mt-0.5 size-4 shrink-0" strokeWidth={2} />
          <div>
            <span className="font-semibold">
              The largest group of record gaps is “{GAP_LABEL[biggestGap.id] ?? biggestGap.id}” — {biggestGap.count}{' '}
              {biggestGap.count === 1 ? 'person' : 'people'}, which {BLOCKS_LABEL[biggestGap.blocks]}.
            </span>{' '}
            Open it to see who.
            <span className="mt-0.5 block text-[11px] opacity-80">
              Counted from your records by a fixed rule. No AI wrote this sentence.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
