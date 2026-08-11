'use client';

import { useActionState, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, ErrorBanner, Field, inputCls } from './ui';

type SubmitState = { error: string | null };
type Action = (prevState: SubmitState, fd: FormData) => SubmitState | Promise<SubmitState>;

type RateConfig =
  | { kind: 'receipt' }
  | { kind: 'mileage_flat'; ratePerKm: number }
  | { kind: 'fixed_allowance'; amount: number };

export type ClaimBalance = {
  annualLimit: number | null;
  usedThisYear: number;
  /** The reserved (submitted, not yet decided) slice of usedThisYear. Part of it, not extra. */
  reservedThisYear: number;
  remainingThisYear: number | null;
  monthlyLimit: number | null;
  remainingThisMonth: number | null;
  perClaimCap: number | null;
  claimsUsedThisYear: number;
  maxClaimsPerYear: number | null;
  /** e7eb5d83 rev 4 — the per-block pot ("RM2,000 every 2 years"). All null ⇒ no per-block rule today. */
  blockLimit: number | null;
  remainingThisBlock: number | null;
  /** Inclusive last day of the block containing today — the date "Remaining until …" names. */
  blockEndsOn: string | null;
};

/** An existing draft being edited (?draft=<id>) — every value the form should open with. */
export type ClaimDraftPrefill = {
  id: string;
  claimTypeId: string;
  claimItemId: string | null;
  amount: number;
  quantityKm: number | null;
  incurredOn: string;
  description: string | null;
};

export type ClaimFormType = {
  id: string;
  code: string;
  name: string;
  requiresReceipt: boolean;
  rateConfig: RateConfig | null;
  items: { id: string; code: string; name: string }[];
  /** Earliest receipt date allowed for THIS type (per-type receipt-age window). */
  minDate: string;
  balance: ClaimBalance;
};

const rm = (n: number) => `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;

/**
 * Claim submission form (extracted to a client component for the Type→Item dependency + the conditional
 * amount/distance field). The Receipt-Date min/max are computed from a UTC-date helper identical to the
 * server's (core/claims.ts) so the boundary the user sees matches the server check at a UTC+8 midnight.
 * ccbd0508: a live balance panel (annual limit / already claimed / remaining / balance-after) shows the
 * grade-resolved entitlement before submit, so the employee never learns of a limit only via a rejection.
 */
export function ClaimForm({
  types,
  submitAction,
  todayUtc,
  draft,
}: {
  types: ClaimFormType[];
  submitAction: Action;
  todayUtc: string;
  /** Present ⇒ the form is EDITING this draft: Save updates it in place, Submit files that same row. */
  draft?: ClaimDraftPrefill;
}) {
  const t = useTranslations('claims');
  const [typeId, setTypeId] = useState(draft?.claimTypeId ?? types[0]?.id ?? '');
  const [claimItemId, setClaimItemId] = useState(
    draft?.claimItemId ?? types.find((ct) => ct.id === draft?.claimTypeId)?.items[0]?.id ?? types[0]?.items[0]?.id ?? '',
  );
  const [km, setKm] = useState(draft?.quantityKm != null ? String(draft.quantityKm) : '');
  const [amount, setAmount] = useState(draft && draft.amount > 0 ? String(draft.amount) : '');
  const [incurredOn, setIncurredOn] = useState(draft?.incurredOn ?? todayUtc);
  const [description, setDescription] = useState(draft?.description ?? '');
  // On error, useActionState returns without navigating, so the form itself is never unmounted —
  // but React's own form-action machinery still resets any UNCONTROLLED field once the action
  // resolves (this happens even without a redirect). Every field the user can type into is
  // therefore controlled state, not a plain uncontrolled <input>, so it survives an error round
  // trip; only the file input can't be restored (the browser itself won't let JS set a file
  // input's value, so a selected receipt does need to be re-attached after fixing the error).
  // The error banner itself has no timer — it stays until the next submit, not on a fade-out.
  const [state, formAction, isPending] = useActionState<SubmitState, FormData>(submitAction, { error: null });

  const selected = useMemo(() => types.find((ct) => ct.id === typeId) ?? types[0], [types, typeId]);
  const kind = selected?.rateConfig?.kind ?? 'receipt';
  const items = selected?.items ?? [];
  const ratePerKm = selected?.rateConfig?.kind === 'mileage_flat' ? selected.rateConfig.ratePerKm : 0;
  const fixedAmount = selected?.rateConfig?.kind === 'fixed_allowance' ? selected.rateConfig.amount : 0;
  const kmNum = Number(km);
  const computedMileage = ratePerKm > 0 && kmNum > 0 ? ratePerKm * kmNum : 0;

  // The amount THIS claim will book, by rate kind — drives the "balance after" line.
  const currentAmount = kind === 'mileage_flat' ? computedMileage : kind === 'fixed_allowance' ? fixedAmount : Number(amount) || 0;
  const bal = selected?.balance;
  const minDate = selected?.minDate ?? todayUtc;
  const hasLimit =
    !!bal &&
    (bal.annualLimit != null ||
      bal.monthlyLimit != null ||
      bal.perClaimCap != null ||
      bal.maxClaimsPerYear != null ||
      bal.blockLimit != null);
  const afterYear = bal?.remainingThisYear == null ? null : bal.remainingThisYear - currentAmount;
  const afterMonth = bal?.remainingThisMonth == null ? null : bal.remainingThisMonth - currentAmount;

  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      {state.error && (
        <div className="sm:col-span-2">
          <ErrorBanner message={state.error} />
        </div>
      )}
      {/* Editing an existing draft — the id travels with the post so Save updates rather than duplicates. */}
      {draft && <input type="hidden" name="draftId" value={draft.id} />}

      {/* Claim Type (mandatory) → drives the dependent Claim Item dropdown + the amount field. */}
      <Field label={t('typeLabel')}>
        <select
          name="claimTypeId"
          required
          value={typeId}
          onChange={(e) => {
            setTypeId(e.target.value);
            // the previously-selected item almost certainly doesn't belong to the new type —
            // default to its first item (matching a plain uncontrolled <select>'s behavior)
            const next = types.find((ct) => ct.id === e.target.value);
            setClaimItemId(next?.items[0]?.id ?? '');
          }}
          className={inputCls}
        >
          {types.map((ct) => (
            <option key={ct.id} value={ct.id}>
              {ct.name} ({ct.code}){ct.requiresReceipt ? ` · ${t('receiptRequired')}` : ''}
            </option>
          ))}
        </select>
      </Field>

      {/* Balance panel (ccbd0508) — grade-resolved entitlement transparency before submit. */}
      {bal && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs sm:col-span-2">
          <div className="mb-1.5 font-semibold text-foreground">{t('balanceTitle')}</div>
          {hasLimit ? (
            <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {bal.annualLimit != null && (
                <>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('annualLimit')}</span><span className="tabular-nums">{rm(bal.annualLimit)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('alreadyClaimed')}</span><span className="tabular-nums">{rm(bal.usedThisYear)}</span></div>
                  {/* The reserved slice, shown only when there is one. Without this line an employee whose
                      balance dropped for a claim nobody has approved yet has no way to tell why. */}
                  {bal.reservedThisYear > 0 && (
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('reservedPending')}</span><span className="tabular-nums">{rm(bal.reservedThisYear)}</span></div>
                  )}
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('remainingBalance')}</span><span className="tabular-nums">{rm(bal.remainingThisYear ?? 0)}</span></div>
                  {afterYear != null && (
                    <div className="flex justify-between"><span className="text-muted-foreground">{t('balanceAfter')}</span><span className={`tabular-nums font-medium ${afterYear < 0 ? 'text-destructive' : 'text-foreground'}`}>{rm(afterYear)}</span></div>
                  )}
                </>
              )}
              {/* PER BLOCK (e7eb5d83 rev 4). The DATE is the point: "RM800 left" is unusable advice on a
                  two-year window if the employee cannot tell whether that is for this month or until
                  2027. The server's refusal names the same day, so the screen and the refusal agree. */}
              {bal.blockLimit != null && bal.blockEndsOn != null && (
                <>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('blockLimit')}</span><span className="tabular-nums">{rm(bal.blockLimit)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">{t('blockRemaining', { date: bal.blockEndsOn })}</span><span className="tabular-nums">{rm(bal.remainingThisBlock ?? 0)}</span></div>
                </>
              )}
              {bal.monthlyLimit != null && afterMonth != null && (
                <div className="flex justify-between"><span className="text-muted-foreground">{t('monthlyRemaining')}</span><span className={`tabular-nums ${afterMonth < 0 ? 'text-destructive' : 'text-foreground'}`}>{rm(bal.remainingThisMonth ?? 0)}</span></div>
              )}
              {bal.perClaimCap != null && (
                <div className="flex justify-between"><span className="text-muted-foreground">{t('perClaimCap')}</span><span className="tabular-nums">{rm(bal.perClaimCap)}</span></div>
              )}
              {bal.maxClaimsPerYear != null && (
                <div className="flex justify-between"><span className="text-muted-foreground">{t('claimsLeftThisYear')}</span><span className="tabular-nums">{Math.max(0, bal.maxClaimsPerYear - bal.claimsUsedThisYear)} / {bal.maxClaimsPerYear}</span></div>
              )}
            </div>
          ) : (
            <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">{t('unlimitedBadge')}</span>
          )}
        </div>
      )}

      {/* Claim Item (dependent, mandatory only when the selected type has items) — side-by-side, 2-column. */}
      {items.length > 0 ? (
        <Field label={t('itemLabel')}>
          <select name="claimItemId" required value={claimItemId} onChange={(e) => setClaimItemId(e.target.value)} className={inputCls}>
            {items.map((it) => (
              <option key={it.id} value={it.id}>
                {it.name} ({it.code})
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <div className="hidden sm:block" aria-hidden />
      )}

      {/* Amount field — conditional on the rate-config kind. */}
      {kind === 'mileage_flat' ? (
        <Field label={t('distanceLabel')}>
          <input
            name="quantityKm"
            type="number"
            min="0.01"
            step="0.01"
            required
            value={km}
            onChange={(e) => setKm(e.target.value)}
            className={inputCls}
          />
          <span className="mt-1 text-xs text-muted-foreground">
            {t('computedAmount')}: {rm(computedMileage)}
          </span>
          {/* amount is server-computed; send 0 so the form value never wins. */}
          <input type="hidden" name="amount" value="0" />
        </Field>
      ) : kind === 'fixed_allowance' ? (
        <Field label={t('amountLabel')}>
          <input type="text" readOnly value={rm(fixedAmount)} className={`${inputCls} bg-muted`} />
          <input type="hidden" name="amount" value="0" />
        </Field>
      ) : (
        <Field label={t('amountLabel')}>
          <input
            name="amount"
            type="number"
            min="0.01"
            step="0.01"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={inputCls}
          />
        </Field>
      )}

      <Field label={t('incurredOnLabel')}>
        <input
          name="incurredOn"
          type="date"
          required
          value={incurredOn}
          onChange={(e) => setIncurredOn(e.target.value)}
          min={minDate}
          max={todayUtc}
          className={inputCls}
        />
      </Field>

      <Field label={t('receiptLabel')}>
        <input name="receipt" type="file" accept="application/pdf,image/jpeg,image/png" className="text-sm" />
        <span className="mt-1 text-xs text-muted-foreground">{t('attachmentHint')}</span>
      </Field>

      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-xs font-medium text-muted-foreground">{t('remarksLabel')}</span>
        <textarea
          name="description"
          rows={2}
          placeholder={t('descriptionPlaceholder')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={inputCls}
        />
      </label>

      {/* Two submitters on one form. The draft button carries name/value so the server action can tell
          which was pressed; the primary button carries none, so `intent` is absent on a real submit. */}
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? t('submitting') : draft ? t('submitDraft') : t('submit')}
        </Button>
        <Button type="submit" name="intent" value="draft" variant="secondary" disabled={isPending}>
          {draft ? t('updateDraft') : t('saveDraft')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('draftHint')}</span>
      </div>
    </form>
  );
}
