'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from './ui';
import { ConfirmSubmit } from './ui/confirm-submit';

export type EntitlementPolicy = {
  id: string;
  annualDays: number;
  carryForwardMax: number;
  /** Accrual cadence (ADR-0040): 'earned_monthly' | 'earned_quarterly' earn through the year; anything
   *  else is a lump grant at hire / year-open. */
  method?: string;
  validFrom: string;
  validTo: string | null;
};

const isEarned = (m?: string) => m === 'earned_monthly' || m === 'earned_quarterly';
/** Normalise to a select value: earned methods pass through, everything else is the lump option. */
const methodValue = (m?: string) => (isEarned(m) ? m! : 'grant_on_hire_prorated');

type Action = (fd: FormData) => void | Promise<void>;

const badge = {
  amber:
    'rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  emerald:
    'rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  muted:
    'rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
};

const fmt = (d: number) => (Number.isInteger(d) ? String(d) : d.toFixed(1));

/**
 * One leave type as an expandable row. The body manages that type's own effective-dated
 * entitlement policies (add / correct / remove) so there's no separate, disconnected policy
 * form — the two tables stay split underneath, but the editing surface is unified.
 */
export function LeaveTypePanel({
  id,
  name,
  code,
  archived,
  inUse,
  isAnnual,
  floorLabel,
  floor0,
  policies,
  updateTypeAction,
  archiveTypeAction,
  deleteTypeAction,
  createPolicyAction,
  updatePolicyAction,
  deletePolicyAction,
}: {
  id: string;
  name: string;
  code: string;
  archived: boolean;
  inUse: boolean;
  isAnnual: boolean;
  floorLabel: string | null;
  floor0: number;
  policies: EntitlementPolicy[];
  updateTypeAction: Action;
  archiveTypeAction: Action;
  deleteTypeAction: Action;
  createPolicyAction: Action;
  updatePolicyAction: Action;
  deletePolicyAction: Action;
}) {
  const t = useTranslations('admin.leave');
  const [expanded, setExpanded] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const active = policies.filter((p) => !p.validTo);
  const bestActive = active.reduce((m, p) => Math.max(m, p.annualDays), 0);
  const effective = Math.max(floor0, bestActive);
  const belowFloor = active.length > 0 && bestActive < floor0;
  const above = active.length > 0 && bestActive > floor0;
  const thisYear = new Date().getUTCFullYear();

  return (
    <li className={archived ? 'opacity-60' : ''}>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <svg
            viewBox="0 0 20 20"
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            aria-hidden
          >
            <path d="M7.5 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          <span className="text-xs text-muted-foreground">{code}</span>
          {archived && <span className={badge.muted}>{t('archivedBadge')}</span>}
        </button>

        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {effective > 0
              ? t.rich('daysPerYear', {
                  days: fmt(effective),
                  b: (chunks) => <span className="font-semibold text-foreground">{chunks}</span>,
                })
              : '—'}
          </span>
          {belowFloor && <span className={badge.amber}>{t('belowMinimumBadge')}</span>}
          {above && <span className={badge.emerald}>{t('policyBadge')}</span>}
        </div>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-border/60 bg-muted/20 px-4 py-3">
          {/* type-level controls */}
          {editingName ? (
            <form action={updateTypeAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="id" value={id} />
              <input name="name" defaultValue={name} aria-label={t('nameLabel')} className={`${inputCls} w-52`} />
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setEditingName(false)}>
                {t('cancel')}
              </Button>
            </form>
          ) : (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span>{t('typeLabel')}</span>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditingName(true)}>
                {t('rename')}
              </Button>
              {archived ? (
                <form action={archiveTypeAction}>
                  <input type="hidden" name="id" value={id} />
                  <input type="hidden" name="archived" value="false" />
                  <Button type="submit" size="sm" variant="ghost">
                    {t('unarchive')}
                  </Button>
                </form>
              ) : inUse ? (
                <form action={archiveTypeAction}>
                  <input type="hidden" name="id" value={id} />
                  <input type="hidden" name="archived" value="true" />
                  <Button type="submit" size="sm" variant="ghost">
                    {t('archive')}
                  </Button>
                </form>
              ) : (
                <form action={deleteTypeAction}>
                  <input type="hidden" name="id" value={id} />
                  <ConfirmSubmit
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    title={t('deleteTypeConfirmTitle')}
                    description={t('deleteTypeConfirmDescription')}
                    confirmLabel={t('deleteConfirmLabel')}
                  >
                    {t('delete')}
                  </ConfirmSubmit>
                </form>
              )}
            </div>
          )}

          {/* statutory floor (read-only) */}
          <div className="flex items-center justify-between gap-3 rounded-lg bg-background px-3 py-2 text-xs">
            <span className="text-muted-foreground">{t('statutoryMinimum')}</span>
            <span className="tabular-nums">
              {floorLabel ? t('daysValue', { days: floorLabel }) : t('none')}
            </span>
          </div>

          {/* entitlement timeline */}
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">{t('companyEntitlements')}</div>
            {policies.length === 0 && (
              <p className="rounded-lg bg-background px-3 py-2 text-xs text-muted-foreground">
                {t('noCompanyPolicy')}
              </p>
            )}
            {policies.map((p) =>
              editingPolicyId === p.id ? (
                <form
                  key={p.id}
                  action={updatePolicyAction}
                  className="flex flex-wrap items-end gap-2 rounded-lg bg-background p-3"
                >
                  <input type="hidden" name="id" value={p.id} />
                  <Field label={t('daysPerYearLabel')}>
                    <input
                      name="annualDays"
                      type="number"
                      min="0"
                      step="0.5"
                      required
                      defaultValue={p.annualDays}
                      className={`${inputCls} w-24`}
                    />
                  </Field>
                  {isAnnual ? (
                    <Field label={t('carryCapLabel')}>
                      <input
                        name="carryForwardMax"
                        type="number"
                        min="0"
                        step="0.5"
                        defaultValue={p.carryForwardMax}
                        className={`${inputCls} w-24`}
                      />
                    </Field>
                  ) : (
                    <input type="hidden" name="carryForwardMax" value="0" />
                  )}
                  <Field label={t('effectiveFromLabel')}>
                    <input name="validFrom" type="date" required defaultValue={p.validFrom} className={inputCls} />
                  </Field>
                  <Field label={t('accrualMethodLabel')}>
                    <select name="method" defaultValue={methodValue(p.method)} className={`${inputCls} w-40`}>
                      <option value="grant_on_hire_prorated">{t('methodLumpSum')}</option>
                      <option value="earned_monthly">{t('methodEarnedMonthly')}</option>
                      <option value="earned_quarterly">{t('methodEarnedQuarterly')}</option>
                    </select>
                  </Field>
                  <Button type="submit" size="sm">
                    {t('save')}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setEditingPolicyId(null)}>
                    {t('cancel')}
                  </Button>
                </form>
              ) : (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-3 rounded-lg bg-background px-3 py-2 text-xs"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-semibold tabular-nums text-foreground">
                      {t('daysPerYearText', { days: fmt(p.annualDays) })}
                    </span>
                    {isAnnual && p.carryForwardMax > 0 && (
                      <span className="text-muted-foreground">
                        {t('carryCapText', { max: fmt(p.carryForwardMax) })}
                      </span>
                    )}
                    <span className="text-muted-foreground">
                      {p.validTo
                        ? t('validFromTo', { from: p.validFrom, to: p.validTo })
                        : t('validFrom', { from: p.validFrom })}
                    </span>
                    {!p.validTo && <span className={badge.emerald}>{t('activeBadge')}</span>}
                    {isEarned(p.method) && (
                      <span className={badge.amber}>
                        {t(p.method === 'earned_quarterly' ? 'methodEarnedQuarterly' : 'methodEarnedMonthly')}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditingPolicyId(p.id)}>
                      {t('edit')}
                    </Button>
                    <form action={deletePolicyAction}>
                      <input type="hidden" name="id" value={p.id} />
                      <ConfirmSubmit
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        title={t('removePolicyConfirmTitle')}
                        description={t('removePolicyConfirmDescription')}
                        confirmLabel={t('removeConfirmLabel')}
                      >
                        {t('remove')}
                      </ConfirmSubmit>
                    </form>
                  </div>
                </div>
              ),
            )}
          </div>

          {/* add a dated entitlement */}
          {adding ? (
            <form
              action={createPolicyAction}
              className="flex flex-wrap items-end gap-2 rounded-lg bg-background p-3"
            >
              <input type="hidden" name="leaveTypeId" value={id} />
              <Field label={t('daysPerYearLabel')}>
                <input
                  name="annualDays"
                  type="number"
                  min="0"
                  step="0.5"
                  required
                  defaultValue={floor0 || 14}
                  className={`${inputCls} w-24`}
                />
              </Field>
              {isAnnual ? (
                <Field label={t('carryCapLabel')}>
                  <input
                    name="carryForwardMax"
                    type="number"
                    min="0"
                    step="0.5"
                    defaultValue="0"
                    className={`${inputCls} w-24`}
                  />
                </Field>
              ) : (
                <input type="hidden" name="carryForwardMax" value="0" />
              )}
              <Field label={t('effectiveFromLabel')}>
                <input name="validFrom" type="date" required defaultValue={`${thisYear}-01-01`} className={inputCls} />
              </Field>
              <Field label={t('accrualMethodLabel')}>
                <select name="method" defaultValue="grant_on_hire_prorated" className={`${inputCls} w-40`}>
                  <option value="grant_on_hire_prorated">{t('methodLumpSum')}</option>
                  <option value="earned_monthly">{t('methodEarnedMonthly')}</option>
                  <option value="earned_quarterly">{t('methodEarnedQuarterly')}</option>
                </select>
              </Field>
              <Button type="submit" size="sm">
                {t('add')}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setAdding(false)}>
                {t('cancel')}
              </Button>
            </form>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
              {t('addEntitlement')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
