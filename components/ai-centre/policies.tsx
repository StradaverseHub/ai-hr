import { ActionButton } from '@/components/ui/action-button';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { SessionContext } from '@/db/client';
import { Card, ErrorBanner, PageHeader, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { StatCells } from '@/components/ui/stat-cells';
import { policiesView, type PolicyDetail, type PolicyListItem, type PolicyMention, type PolicyMismatch, type PolicyValueView, type ReaderPolicy } from '@/core/handbook/policies';
import { POLICY_AREAS, type PolicySetting, type SettingBody } from '@/core/handbook/types';
import type { PolicySpan } from '@/core/handbook/extract';
import {
  applyScheduledPolicyValueAction, approvePolicyAction, createPolicyAction, decidePolicyValueAction, draftFromVersionAction,
  markTextOnlyAction, prepareFromDriftAction, readPolicyValuesAction, returnPolicyAction, saveDraftAction, submitPolicyAction,
} from '@/app/assistant/policy-actions';
import { cn } from '@/lib/utils';

/** AI v2 Phase 2, P2-5 — AI Centre › Policies, the Living Handbook (approved mock-up Handbook.dc.html).
 *
 * The list of policies with their version, draft and drift marks; a policy's page: "Your policy, in your words" (the
 * text, with the words values were read from highlighted), "What the system will enforce" (setting, now, from your
 * text, and each value's confirmation), "If this had applied" (the claims service's own figures over its last twelve
 * months of real claims), "Where the handbook and the system disagree" (both values, with "Use the handbook" and "Update
 * the handbook"), the settings the text mentions and how each is covered (a confirmed value, or "text only, not
 * enforced" with who marked it), where the text disagrees with what the system would enforce (approval waits until it
 * does not), the approval step and what each owner did. Administrators see all of it for the companies they
 * administer; a group administrator approves. Everyone else reads the approved text of their own company's policies
 * only. Every read is core/handbook/policies.ts policiesView, under the viewer's own row-level security (2009); this view
 * grants nothing. Names are AI Centre's; nothing here says Noveri. */
export type PoliciesQuery = Readonly<Record<string, string | undefined>>;
type T = Awaited<ReturnType<typeof getTranslations<'aiCentre.policies'>>>;
type F = Awaited<ReturnType<typeof getFormatter>>;
const SAVED = ['created', 'draft', 'read', 'unread', 'confirmed', 'rejected', 'sent_settings', 'sent_text', 'approved', 'approved_refused', 'returned', 'applied',
  'drift_settings', 'drift_text', 'drift_text_manual', 'draft_made', 'text_only', 'text_only_withdrawn'] as const;
const ERRORS = ['not_administrator', 'not_group_admin', 'invalid', 'not_found', 'not_draft', 'not_submitted', 'not_approved', 'undecided', 'same_administrator',
  'stale_submission', 'shared_setting', 'draft_open', 'no_drift', 'not_due', 'model_unavailable', 'no_settings', 'failed', 'unmarked', 'mismatch'] as const;
const target = 'pointer-coarse:min-h-11';
const href = (query: Readonly<Record<string, string | null | undefined>>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const search = params.toString();
  return search ? `/policies?${search}` : '/policies';
};
const Hidden = ({ name, value }: { name: string; value: string }) => <input type="hidden" name={name} value={value} />;

export async function AiCentrePolicies({ session, query }: { session: SessionContext; query: PoliciesQuery }) {
  const [t, f] = await Promise.all([getTranslations('aiCentre.policies'), getFormatter()]);
  const view = await policiesView(session, { policy: query.policy });
  const saved = SAVED.find(code => code === query.saved);
  const error = ERRORS.find(code => code === query.error);
  const count = (value: string | undefined) => (value && /^\d+$/.test(value) ? Number(value) : 0);
  const admin = view.role === 'admin';
  return (
    <div data-ai-centre-policies={view.role} className="space-y-6">
      <PageHeader title={t('title')} description={admin ? t('descriptionAdmin') : t('descriptionReader')} />
      {saved && <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">{t(`saved.${saved}`, { accepted: count(query.n), rejected: count(query.r) })}</p>}
      {error && <ErrorBanner message={t(`errors.${error}`)} />}
      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <PolicyList t={t} list={view.list} selected={view.selected?.id ?? null} admin={admin} creating={admin && query.new === '1'} />
        <div className="min-w-0 flex-1 space-y-5" data-policy-main>
          {view.role === 'admin' && query.new === '1' && !view.selected
            ? <NewPolicyForm t={t} companies={view.companies} today={view.today} />
            : view.role === 'admin' && view.selected
              ? <AdminPolicy t={t} f={f} detail={view.selected} companies={view.companies} isGroupAdmin={view.isGroupAdmin} today={view.today} editing={query.edit === '1'} />
              : view.role === 'reader' && view.selected
                ? <ReaderPolicyView t={t} f={f} policy={view.selected} />
                : <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-policies-empty>
                    {view.list.length ? t('choose') : admin ? t('emptyAdmin') : t('emptyReader')}
                  </p>}
        </div>
      </div>
    </div>
  );
}

function PolicyList({ t, list, selected, admin, creating }: { t: T; list: readonly PolicyListItem[]; selected: string | null; admin: boolean; creating: boolean }) {
  const areas = POLICY_AREAS.filter(area => list.some(item => item.area === area));
  return (
    <aside aria-labelledby="policies-list-title" className="w-full shrink-0 md:w-64 md:border-r md:border-border md:pr-4" data-policy-list>
      <h2 id="policies-list-title" className="mb-2 text-[0.8125rem] font-semibold text-muted-foreground">{t('handbook')}</h2>
      {list.length === 0 && <p className="text-sm text-muted-foreground">{t('none')}</p>}
      {areas.map(area => (
        <div key={area} className="mb-2">
          <p className="px-2 pb-1 pt-2 text-xs text-muted-foreground">{t(`areas.${area}`)}</p>
          <ul className="space-y-0.5">
            {list.filter(item => item.area === area).map(item => (
              <li key={item.id}>
                <Link href={href({ policy: item.id })} aria-current={item.id === selected ? 'page' : undefined} data-policy-item={item.id}
                  className={cn('flex min-h-9 items-center justify-between gap-2 rounded-md px-2 text-sm hover:bg-muted', target, item.id === selected && 'bg-muted font-semibold')}>
                  <span className="min-w-0 truncate">{item.title}</span>
                  <span className="flex shrink-0 gap-1">
                    {item.inForce !== null && <span className="text-xs text-muted-foreground" data-policy-badge="version">{t('versionShort', { version: item.inForce })}</span>}
                    {admin && item.open && <span className="rounded-full bg-primary/10 px-2 text-[0.6875rem] text-primary" data-policy-badge={item.open.status}>{t(`badges.${item.open.status}`)}</span>}
                    {admin && item.drift > 0 && <span className="rounded-full bg-amber-100 px-2 text-[0.6875rem] text-amber-900 dark:bg-amber-900/40 dark:text-amber-100" data-policy-badge="drift">{t('badges.drift', { count: item.drift })}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {admin && <Link href={href({ new: '1' })} aria-current={creating ? 'page' : undefined} className={cn(btnGhost, target, 'mt-3 w-full justify-center')} data-policy-new>{t('new')}</Link>}
    </aside>
  );
}

function CompanyChoices({ t, companies, chosen }: { t: T; companies: readonly { id: string; name: string }[]; chosen: readonly string[] }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-medium text-muted-foreground">{t('form.companies')}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {companies.map(company => (
          <label key={company.id} className={cn('inline-flex min-h-9 items-center gap-2 text-sm', target)}>
            <input type="checkbox" name="companies" value={company.id} defaultChecked={chosen.includes(company.id)} className="size-4" />{company.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function NewPolicyForm({ t, companies, today }: { t: T; companies: readonly { id: string; name: string }[]; today: string }) {
  return (
    <Card className="space-y-4 p-4" data-policy-form="new">
      <h3 className="text-lg font-semibold">{t('form.newTitle')}</h3>
      <form action={createPolicyAction} className="space-y-4">
        <Hidden name="returnTo" value="new" />
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5"><span className="text-xs font-medium text-muted-foreground">{t('form.titleLabel')}</span>
            <input name="title" required maxLength={160} className={cn(inputCls, target)} /></label>
          <label className="flex flex-col gap-1.5"><span className="text-xs font-medium text-muted-foreground">{t('form.area')}</span>
            <select name="area" defaultValue="claims" className={cn(inputCls, target)}>{POLICY_AREAS.map(area => <option key={area} value={area}>{t(`areas.${area}`)}</option>)}</select></label>
        </div>
        <label className="flex flex-col gap-1.5"><span className="text-xs font-medium text-muted-foreground">{t('form.effectiveFrom')}</span>
          <input type="date" name="effectiveFrom" required defaultValue={today} className={cn(inputCls, target, 'max-w-48')} /></label>
        <CompanyChoices t={t} companies={companies} chosen={companies.map(c => c.id)} />
        <label className="flex flex-col gap-1.5"><span className="text-xs font-medium text-muted-foreground">{t('form.body')}</span>
          <textarea name="body" required rows={10} maxLength={20000} className={cn(inputCls, 'h-auto min-h-48 py-2 leading-6')} /></label>
        <p className="text-xs text-muted-foreground">{t('form.bodyHint')}</p>
        <ActionButton type="submit" className={cn(btnPrimary, target)}>{t('form.create')}</ActionButton>
      </form>
    </Card>
  );
}

/** The text with each value's words highlighted. Overlapping or stale spans are skipped. */
function Highlighted({ body, spans }: { body: string; spans: readonly PolicySpan[] }) {
  const sorted = [...spans].filter(s => s.start >= 0 && s.end <= body.length && body.slice(s.start, s.end) === s.quote).sort((a, b) => a.start - b.start);
  const parts: ReactNode[] = [];
  let at = 0;
  sorted.forEach((span, i) => {
    if (span.start < at) return;
    if (span.start > at) parts.push(body.slice(at, span.start));
    parts.push(<mark key={i} data-policy-span={span.part} className="rounded-sm bg-primary/10 px-0.5 text-inherit">{span.quote}</mark>);
    at = span.end;
  });
  parts.push(body.slice(at));
  return <p className="whitespace-pre-wrap text-[0.9375rem] leading-7" data-policy-text>{parts}</p>;
}

const rm = (f: F, n: number, places = 2) => f.number(n, { minimumFractionDigits: places, maximumFractionDigits: 4 });
function settingRows(t: T, f: F, setting: PolicySetting, targetName: string | null, value: SettingBody) {
  if (setting === 'claims.submit_within_days') return [{ label: t('settings.submitWithin', { type: targetName ?? '' }), text: t('values.days', { days: (value as { days: number }).days }) }];
  if (setting === 'claims.mileage_rates') {
    const bands = (value as { bands: readonly { fromKm: number; toKm: number | null; ratePerKm: number }[] }).bands;
    return bands.map(b => ({ label: b.toKm === null ? (b.fromKm === 0 ? t('settings.mileageAny') : t('settings.mileageAfter', { from: f.number(b.fromKm) })) : t('settings.mileageBand', { from: f.number(b.fromKm), to: f.number(b.toKm) }),
      text: t('values.ratePerKm', { rate: rm(f, b.ratePerKm) }) }));
  }
  const bands = (value as { bands: readonly { fromYears: number; toYears: number | null; days: number }[] }).bands;
  return bands.map(b => ({ label: b.toYears === null ? t('settings.leaveFrom', { type: targetName ?? '', from: b.fromYears }) : t('settings.leaveBand', { type: targetName ?? '', from: b.fromYears, to: b.toYears }),
    text: t('values.daysAYear', { days: f.number(b.days) }) }));
}
/** The owner's value as one line ("None" when it holds none). */
function ownerSummary(t: T, f: F, setting: PolicySetting, value: SettingBody | null, defaulted = false) {
  if (value === null) return setting === 'claims.mileage_rates' ? t('values.noneMileage') : t('values.none');
  if (setting === 'claims.submit_within_days') return defaulted ? t('values.daysDefault', { days: (value as { days: number }).days }) : t('values.days', { days: (value as { days: number }).days });
  if (setting === 'claims.mileage_rates') return (value as { bands: readonly { fromKm: number; toKm: number | null; ratePerKm: number }[] }).bands
    .map(b => (b.toKm === null ? t('values.mileageOpen', { from: f.number(b.fromKm), rate: rm(f, b.ratePerKm) }) : t('values.mileageRange', { from: f.number(b.fromKm), to: f.number(b.toKm), rate: rm(f, b.ratePerKm) }))).join('; ');
  return (value as { bands: readonly { fromYears: number; toYears: number | null; days: number }[] }).bands
    .map(b => (b.toYears === null ? t('values.leaveOpen', { from: b.fromYears, days: f.number(b.days) }) : t('values.leaveRange', { from: b.fromYears, to: b.toYears, days: f.number(b.days) }))).join('; ');
}
const ownerOf = (setting: PolicySetting) => (setting.startsWith('claims.') ? 'claims' : 'leave');
const day = (f: F, date: string) => f.dateTime(new Date(`${date}T00:00:00+08:00`), { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' });
const month = (f: F, date: string) => f.dateTime(new Date(`${date}T00:00:00+08:00`), { month: 'short', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' });
const monthBefore = (date: string) => { const [y, m] = date.split('-').map(Number); return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`; };

function AdminPolicy({ t, f, detail, companies, isGroupAdmin, today, editing }: { t: T; f: F; detail: PolicyDetail; companies: readonly { id: string; name: string }[];
  isGroupAdmin: boolean; today: string; editing: boolean }) {
  const v = detail.current;
  const nameOf = (id: string) => companies.find(c => c.id === id)?.name ?? t('otherCompany');
  const companiesText = v.companies.length === companies.length && companies.length > 1 ? t('allCompanies', { count: companies.length }) : v.companies.map(nameOf).join(', ');
  const policy = detail.id;
  const draft = v.status === 'draft', submitted = v.status === 'submitted', approved = v.status === 'approved';
  const live = detail.values.filter(value => value.decision !== 'rejected');
  const spans = live.flatMap(value => value.spans);
  const undecided = detail.values.some(value => value.decision === null);
  const mentions = detail.mentions ?? [], mismatches = detail.mismatches ?? [];
  const uncovered = mentions.some(m => !m.confirmed && !m.textOnly);
  const openDraft = detail.versions.some(x => x.status !== 'approved');
  const latestApplication = new Map(detail.applications.map(a => [a.valueId, a]));
  return (
    <article className="space-y-5" data-policy-detail={v.status} aria-labelledby="policy-title">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 id="policy-title" className="text-[1.375rem] font-semibold tracking-tight">{detail.title}</h3>
          <p className="text-sm text-muted-foreground" data-policy-status>
            {t('statusLine', { status: t(`status.${v.status}`), version: v.version, author: v.authorName ?? t('anAdministrator'), companies: companiesText, date: day(f, v.effectiveFrom) })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2" data-policy-actions>
          {draft && detail.canEdit && !editing && <Link href={href({ policy, edit: '1' })} className={cn(btnGhost, target)}>{t('actions.edit')}</Link>}
          {draft && detail.canEdit && detail.settings.length > 0 && detail.sharedOk && (
            <form action={readPolicyValuesAction}><Hidden name="policy" value={policy} /><Hidden name="versionId" value={v.id} />
              <ActionButton type="submit" className={cn(btnGhost, target)}>{t('actions.read')}</ActionButton></form>)}
          {draft && detail.canEdit && (
            <form action={submitPolicyAction}><Hidden name="policy" value={policy} /><Hidden name="versionId" value={v.id} />
              <ActionButton type="submit" disabled={undecided || uncovered} className={cn(btnPrimary, target)}>{t('actions.send')}</ActionButton></form>)}
          {approved && detail.canEdit && !openDraft && (
            <form action={draftFromVersionAction}><Hidden name="policy" value={policy} /><Hidden name="versionId" value={v.id} />
              <ActionButton type="submit" className={cn(btnGhost, target)}>{t('actions.edit')}</ActionButton></form>)}
        </div>
      </header>

      {draft && editing && detail.canEdit && (
        <Card className="space-y-4 p-4" data-policy-form="edit">
          <form action={saveDraftAction} className="space-y-4">
            <Hidden name="policy" value={policy} /><Hidden name="versionId" value={v.id} /><Hidden name="returnTo" value="edit" />
            <label className="flex flex-col gap-1.5"><span className="text-xs font-medium text-muted-foreground">{t('form.effectiveFrom')}</span>
              <input type="date" name="effectiveFrom" required defaultValue={v.effectiveFrom} className={cn(inputCls, target, 'max-w-48')} /></label>
            <CompanyChoices t={t} companies={companies} chosen={v.companies} />
            <label className="flex flex-col gap-1.5"><span className="text-xs font-medium text-muted-foreground">{t('form.body')}</span>
              <textarea name="body" required rows={10} maxLength={20000} defaultValue={v.body} className={cn(inputCls, 'h-auto min-h-48 py-2 leading-6')} /></label>
            <p className="text-xs text-muted-foreground">{t('form.editHint')}</p>
            <div className="flex flex-wrap gap-2">
              <ActionButton type="submit" className={cn(btnPrimary, target)}>{t('form.save')}</ActionButton>
              <Link href={href({ policy })} className={cn(btnGhost, target)}>{t('form.cancel')}</Link>
            </div>
          </form>
        </Card>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
        <section aria-labelledby="policy-words" className="min-w-0 flex-1 space-y-2 rounded-xl border border-border p-4">
          <h4 id="policy-words" className="text-[0.8125rem] font-semibold text-muted-foreground">{t('words')}</h4>
          <Highlighted body={v.body} spans={spans} />
        </section>
        <section aria-labelledby="policy-enforce" className="min-w-0 flex-1 space-y-2 rounded-xl border border-border p-4" data-policy-enforce>
          <h4 id="policy-enforce" className="text-[0.8125rem] font-semibold text-muted-foreground">{t('enforce')}</h4>
          {detail.settings.length === 0
            ? <p className="text-sm" data-policy-not-enforced><span className="mr-2 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{t('notEnforced')}</span>{t('notEnforcedBody')}</p>
            : !detail.sharedOk
              ? <p className="text-sm text-muted-foreground" data-policy-shared>{t('sharedSetting')}</p>
              : detail.values.length === 0
                ? <p className="text-sm text-muted-foreground" data-policy-no-values>{draft ? t('noValuesDraft') : t('noValues')}</p>
                : <EnforceTable t={t} f={f} values={detail.values} policy={policy} decide={draft && detail.canEdit} />}
          {detail.values.length > 0 && <p className="text-xs text-muted-foreground">{t('enforceNote', { count: detail.values.length })}</p>}
          {mentions.length > 0 && <Mentions t={t} f={f} mentions={mentions} policy={policy} versionId={v.id} mark={draft && detail.canEdit} />}
        </section>
      </div>

      {mismatches.length > 0 && <Mismatches t={t} f={f} mismatches={mismatches} />}

      {detail.impact && (detail.impact.mileage || detail.impact.deadline) && (
        <section aria-labelledby="policy-impact" className="space-y-3 rounded-xl border border-border bg-muted/40 p-4" data-policy-impact>
          <h4 id="policy-impact" className="text-sm font-semibold">{t('impact.title', { from: month(f, detail.impact.from), to: month(f, monthBefore(detail.impact.to)) })}</h4>
          <StatCells cells={[
            ...(detail.impact.mileage ? [
              { label: t('impact.changedLabel', { total: detail.impact.mileage.claims }), value: f.number(detail.impact.mileage.changed) },
              { label: detail.impact.mileage.deltaSen < 0 ? t('impact.lessPaid') : detail.impact.mileage.deltaSen > 0 ? t('impact.morePaid') : t('impact.samePaid'),
                value: t('values.money', { amount: rm(f, Math.abs(detail.impact.mileage.deltaSen) / 100) }) },
            ] : []),
            ...(detail.impact.deadline ? [{ label: t('impact.lateLabel', { days: detail.impact.deadline.days, total: detail.impact.deadline.claims }), value: f.number(detail.impact.deadline.late) }] : []),
            { label: t('impact.peopleLabel'), value: f.number(detail.impact.people) },
          ]} />
          <p className="text-xs text-muted-foreground" data-policy-impact-owner>{t('impact.owner')}</p>
        </section>
      )}

      {detail.drift.length > 0 && (
        <section aria-labelledby="policy-drift" className="space-y-2" data-policy-drift>
          <h4 id="policy-drift" className="text-sm font-semibold">{t('drift.title')}</h4>
          {detail.drift.map((item, i) => (
            <div key={`${item.kind ?? 'value'}-${item.valueId ?? ''}-${item.quote ?? ''}-${i}`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-4 py-3"
              data-policy-drift-item={item.setting} data-policy-drift-kind={item.kind ?? 'value'}>
              <p className="min-w-0 text-sm">
                <b className="font-semibold">{t(`drift.setting.${item.setting.replace('.', '_')}`, { type: item.targetName ?? '' })}:</b>{' '}
                {item.kind === 'text'
                  ? t('drift.textBody', { quote: item.quote ?? '', system: ownerSummary(t, f, item.setting, item.system), owner: t(`owners.${ownerOf(item.setting)}`),
                    companies: item.companies.length === companies.length && companies.length > 1 ? t('allCompanies', { count: companies.length }) : item.companies.map(nameOf).join(', ') })
                  : t('drift.body', { handbook: item.handbook ? ownerSummary(t, f, item.setting, item.handbook) : '', system: ownerSummary(t, f, item.setting, item.system), owner: t(`owners.${ownerOf(item.setting)}`),
                    companies: item.companies.length === companies.length && companies.length > 1 ? t('allCompanies', { count: companies.length }) : item.companies.map(nameOf).join(', ') })}
              </p>
              {item.kind === 'text' && <p className="w-full text-xs text-muted-foreground" data-policy-drift-text-note>{t('drift.textNote')}</p>}
              {item.kind !== 'text' && item.valueId && detail.canEdit && !openDraft && detail.inForceId && (
                <span className="flex flex-wrap gap-2">
                  <form action={prepareFromDriftAction}><Hidden name="policy" value={policy} /><Hidden name="versionId" value={detail.inForceId} /><Hidden name="valueId" value={item.valueId} />
                    <Hidden name="resolution" value="use_handbook" /><ActionButton type="submit" className={cn(btnPrimary, target)}>{t('drift.useHandbook')}</ActionButton></form>
                  <form action={prepareFromDriftAction}><Hidden name="policy" value={policy} /><Hidden name="versionId" value={detail.inForceId} /><Hidden name="valueId" value={item.valueId} />
                    <Hidden name="resolution" value="update_handbook" /><ActionButton type="submit" className={cn(btnGhost, target)}>{t('drift.updateHandbook')}</ActionButton></form>
                </span>
              )}
            </div>
          ))}
          {openDraft && <p className="text-xs text-muted-foreground">{t('drift.draftOpen')}</p>}
        </section>
      )}

      <section aria-labelledby="policy-approval" className="space-y-2 rounded-xl border border-border p-4" data-policy-approval>
        <h4 id="policy-approval" className="text-sm font-semibold">{t('approval.title')}</h4>
        <p className="text-sm" data-policy-rule>
          {draft ? t('approval.ruleDraft') : v.changesSettings ? t('approval.ruleSettings') : t('approval.ruleText')}
        </p>
        {submitted && mismatches.length > 0 && <p className="text-sm text-muted-foreground" data-policy-blocked>{t('approval.blocked')}</p>}
        {detail.approvals.length > 0 && (
          <ul className="space-y-1 text-sm text-muted-foreground">
            {detail.approvals.map((a, i) => <li key={i}>{t(`approval.${a.decision}`, { name: a.approverName ?? t('anAdministrator'), date: f.dateTime(a.at, { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' }) })}</li>)}
          </ul>
        )}
        {submitted && mismatches.length === 0 && (isGroupAdmin
          ? (v.changesSettings && (v.authorIsViewer || v.submittedByViewer || v.contributedByViewer)
            ? <p className="text-sm text-muted-foreground" data-policy-second>{t('approval.needSecond')}</p>
            : <div className="flex flex-wrap gap-2">
                <form action={approvePolicyAction}><Hidden name="policy" value={policy} /><Hidden name="versionId" value={v.id} />
                  <ActionButton type="submit" className={cn(btnPrimary, target)}>{v.changesSettings ? t('approval.approveApply') : t('approval.approve')}</ActionButton></form>
                <form action={returnPolicyAction}><Hidden name="policy" value={policy} /><Hidden name="versionId" value={v.id} />
                  <ActionButton type="submit" className={cn(btnGhost, target)}>{t('approval.return')}</ActionButton></form>
              </div>)
          : <p className="text-sm text-muted-foreground">{t('approval.waiting')}</p>)}
        {approved && detail.applications.length > 0 && (
          <ul className="space-y-1.5 pt-1 text-sm" data-policy-applications>
            {detail.values.filter(value => latestApplication.has(value.id)).map(value => {
              const a = latestApplication.get(value.id)!;
              return (
                <li key={value.id} data-policy-application={a.status} className="flex flex-wrap items-center gap-2">
                  <span>{t(`applied.${a.status}`, { setting: t(`drift.setting.${value.setting.replace('.', '_')}`, { type: value.targetName ?? '' }), owner: t(`owners.${ownerOf(value.setting)}`),
                    date: day(f, a.applyOn), message: a.ownerMessage ?? '' })}</span>
                  {a.status === 'scheduled' && isGroupAdmin && a.applyOn <= today && (
                    <form action={applyScheduledPolicyValueAction}><Hidden name="policy" value={policy} /><Hidden name="versionId" value={v.id} /><Hidden name="valueId" value={value.id} />
                      <ActionButton type="submit" className={cn(btnGhost, target)}>{t('applied.applyNow')}</ActionButton></form>)}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="policy-versions" className="space-y-2" data-policy-versions>
        <h4 id="policy-versions" className="text-sm font-semibold">{t('versions.title')}</h4>
        <ul className="divide-y divide-border rounded-xl border border-border text-sm">
          {detail.versions.map(x => (
            <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
              <span>{t('versions.row', { version: x.version, status: t(`status.${x.status}`), date: day(f, x.effectiveFrom) })}{x.id === detail.inForceId && <span className="ml-2 text-xs text-muted-foreground">{t('versions.inForce')}</span>}</span>
              {x.status === 'approved' && x.id !== v.id && detail.canEdit && !openDraft && (
                <form action={draftFromVersionAction}><Hidden name="policy" value={policy} /><Hidden name="versionId" value={x.id} />
                  <ActionButton type="submit" className={cn(btnGhost, target)}>{t('versions.restore')}</ActionButton></form>)}
            </li>
          ))}
        </ul>
      </section>
      <p className="text-xs text-muted-foreground">{t('footer')}</p>
    </article>
  );
}

function EnforceTable({ t, f, values, policy, decide }: { t: T; f: F; values: readonly PolicyValueView[]; policy: string; decide: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[26rem] border-collapse text-[0.8125rem]">
        <thead><tr className="text-left text-muted-foreground">
          <th className="py-1.5 pr-2 font-medium">{t('table.setting')}</th><th className="px-2 py-1.5 font-medium">{t('table.now')}</th>
          <th className="py-1.5 pr-2 font-medium">{t('table.fromText')}</th><th className="py-1.5 font-medium">{t('table.decision')}</th>
        </tr></thead>
        <tbody>
          {values.map(value => {
            const rows = settingRows(t, f, value.setting, value.targetName, value.value);
            // The claims service prices each claim's own distance: a monthly limit in the text is shown as written, never as enforced.
            const note = value.setting === 'claims.mileage_rates'
              ? [<tr key={value.id + 'note'} data-policy-per-claim><td colSpan={4} className="pb-2 text-xs text-muted-foreground">{t('perClaimNote')}</td></tr>] : [];
            return [...rows.map((row, i) => (
              <tr key={value.id + i} className={cn('border-t border-border align-top', value.decision === 'rejected' && 'text-muted-foreground line-through')} data-policy-value={value.setting}>
                <td className="py-2 pr-2">{row.label}</td>
                {i === 0 && <td rowSpan={rows.length} className="px-2 py-2 text-muted-foreground" data-policy-now>{ownerSummary(t, f, value.setting, value.now, value.nowDefaulted)}</td>}
                <td className="py-2 pr-2 font-semibold">{row.text}</td>
                {i === 0 && (
                  <td rowSpan={rows.length} className="py-2" data-policy-decision={value.decision ?? 'pending'}>
                    {decide ? (
                      <span className="flex flex-wrap gap-1.5">
                        {(['confirmed', 'rejected'] as const).map(decision => (
                          <form key={decision} action={decidePolicyValueAction}><Hidden name="policy" value={policy} /><Hidden name="valueId" value={value.id} /><Hidden name="decision" value={decision} />
                            <ActionButton type="submit" aria-pressed={value.decision === decision} className={cn(decision === 'confirmed' ? btnPrimary : btnGhost, target, 'h-8 px-2.5 text-xs',
                              value.decision === decision && 'ring-2 ring-ring')}>{t(`decide.${decision}`)}</ActionButton></form>
                        ))}
                      </span>
                    ) : <span className="text-xs">{t(`decision.${value.decision ?? 'pending'}`)}</span>}
                    {!value.differs && <span className="mt-1 block text-[0.6875rem] text-muted-foreground">{t('same')}</span>}
                  </td>
                )}
              </tr>
            )), ...note];
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The enforceable settings the text mentions, each covered by a confirmed value or a person's "text only" mark. */
function Mentions({ t, f, mentions, policy, versionId, mark }: { t: T; f: F; mentions: readonly PolicyMention[]; policy: string; versionId: string; mark: boolean }) {
  return (
    <div className="space-y-1.5 border-t border-border pt-3" data-policy-mentions>
      <h5 className="text-xs font-semibold text-muted-foreground">{t('mentions.title')}</h5>
      <ul className="space-y-1.5 text-[0.8125rem]">
        {mentions.map(m => {
          const state = m.confirmed ? 'confirmed' : m.textOnly ? 'text_only' : 'needed';
          return (
            <li key={m.setting} className="flex flex-wrap items-center justify-between gap-2" data-policy-mention={m.setting} data-policy-mention-state={state}>
              <span className="min-w-0">
                <b className="font-medium">{t(`mentions.setting.${m.setting.replace('.', '_')}`)}</b>{' · '}
                {state === 'confirmed' ? t('mentions.enforced')
                  : state === 'text_only' ? t('mentions.textOnly', { name: m.textOnly!.byName ?? t('anAdministrator'), date: f.dateTime(m.textOnly!.at, { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' }) })
                    : t('mentions.needed')}
              </span>
              {mark && !m.confirmed && (
                <form action={markTextOnlyAction}><Hidden name="policy" value={policy} /><Hidden name="versionId" value={versionId} /><Hidden name="setting" value={m.setting} />
                  <Hidden name="marked" value={m.textOnly ? 'false' : 'true'} />
                  <ActionButton type="submit" className={cn(btnGhost, target, 'h-8 px-2.5 text-xs')}>{m.textOnly ? t('mentions.unmark') : t('mentions.markTextOnly')}</ActionButton></form>)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Words of the text that state a figure the system would not enforce once approved: approval waits until they agree. */
function Mismatches({ t, f, mismatches }: { t: T; f: F; mismatches: readonly PolicyMismatch[] }) {
  return (
    <section aria-labelledby="policy-mismatch" className="space-y-2 rounded-xl border border-border p-4" data-policy-mismatch>
      <h4 id="policy-mismatch" className="text-sm font-semibold">{t('mismatch.title')}</h4>
      <ul className="space-y-1 text-sm">
        {mismatches.map((m, i) => (
          <li key={i} data-policy-mismatch-item={m.setting}>
            {t('mismatch.row', { quote: m.quote, setting: t(`drift.setting.${m.setting.replace('.', '_')}`, { type: m.targetName ?? '' }), owner: t(`owners.${ownerOf(m.setting)}`),
              enforced: ownerSummary(t, f, m.setting, m.enforced) })}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t('mismatch.note')}</p>
    </section>
  );
}

function ReaderPolicyView({ t, f, policy }: { t: T; f: F; policy: ReaderPolicy }) {
  return (
    <article className="space-y-3" data-policy-reader aria-labelledby="policy-title">
      <h3 id="policy-title" className="text-[1.375rem] font-semibold tracking-tight">{policy.title}</h3>
      <p className="text-sm text-muted-foreground" data-policy-status>{t('readerLine', { version: policy.version, date: day(f, policy.effectiveFrom) })}</p>
      <section className="rounded-xl border border-border p-4"><p className="whitespace-pre-wrap text-[0.9375rem] leading-7" data-policy-text>{policy.body}</p></section>
      {(policy.settingNotes ?? []).length > 0 && (
        <ul className="space-y-1 text-sm text-muted-foreground" data-policy-setting-notes>
          {(policy.settingNotes ?? []).map((note, i) => (
            <li key={i} data-policy-setting-note={note.setting}>
              {note.unavailable
                ? t('readerSettingUnavailable', { quote: note.quote })
                : t('readerSettingNote', { quote: note.quote, setting: t(`drift.setting.${note.setting.replace('.', '_')}`, { type: note.targetName ?? '' }),
                    current: ownerSummary(t, f, note.setting, note.current) })}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t('readerNote')}</p>
    </article>
  );
}

