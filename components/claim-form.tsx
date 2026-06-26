'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from './ui';

type Action = (fd: FormData) => void | Promise<void>;

type RateConfig =
  | { kind: 'receipt' }
  | { kind: 'mileage_flat'; ratePerKm: number }
  | { kind: 'fixed_allowance'; amount: number };

export type ClaimFormType = {
  id: string;
  code: string;
  name: string;
  requiresReceipt: boolean;
  rateConfig: RateConfig | null;
  items: { id: string; code: string; name: string }[];
};

const rm = (n: number) => `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;

/**
 * Claim submission form (extracted to a client component for the Type→Item dependency + the conditional
 * amount/distance field). The Receipt-Date min/max are computed from a UTC-date helper identical to the
 * server's (core/claims.ts) so the boundary the user sees matches the server check at a UTC+8 midnight.
 */
export function ClaimForm({
  types,
  submitAction,
  todayUtc,
  minDate,
}: {
  types: ClaimFormType[];
  submitAction: Action;
  todayUtc: string;
  minDate: string;
}) {
  const t = useTranslations('claims');
  const [typeId, setTypeId] = useState(types[0]?.id ?? '');
  const [km, setKm] = useState('');

  const selected = useMemo(() => types.find((ct) => ct.id === typeId) ?? types[0], [types, typeId]);
  const kind = selected?.rateConfig?.kind ?? 'receipt';
  const items = selected?.items ?? [];
  const ratePerKm = selected?.rateConfig?.kind === 'mileage_flat' ? selected.rateConfig.ratePerKm : 0;
  const fixedAmount = selected?.rateConfig?.kind === 'fixed_allowance' ? selected.rateConfig.amount : 0;
  const kmNum = Number(km);
  const computedMileage = ratePerKm > 0 && kmNum > 0 ? ratePerKm * kmNum : 0;

  return (
    <form action={submitAction} className="grid gap-4 sm:grid-cols-2">
      {/* Claim Type (mandatory) → drives the dependent Claim Item dropdown + the amount field. */}
      <Field label={t('typeLabel')}>
        <select name="claimTypeId" required value={typeId} onChange={(e) => setTypeId(e.target.value)} className={inputCls}>
          {types.map((ct) => (
            <option key={ct.id} value={ct.id}>
              {ct.name} ({ct.code}){ct.requiresReceipt ? ` · ${t('receiptRequired')}` : ''}
            </option>
          ))}
        </select>
      </Field>

      {/* Claim Item (dependent, mandatory only when the selected type has items) — side-by-side, 2-column. */}
      {items.length > 0 ? (
        <Field label={t('itemLabel')}>
          <select name="claimItemId" required className={inputCls}>
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
          <input name="amount" type="number" min="0.01" step="0.01" required className={inputCls} />
        </Field>
      )}

      <Field label={t('incurredOnLabel')}>
        <input name="incurredOn" type="date" required defaultValue={todayUtc} min={minDate} max={todayUtc} className={inputCls} />
      </Field>

      <Field label={t('receiptLabel')}>
        <input name="receipt" type="file" accept="application/pdf,image/jpeg,image/png" className="text-sm" />
        <span className="mt-1 text-xs text-muted-foreground">{t('attachmentHint')}</span>
      </Field>

      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-xs font-medium text-muted-foreground">{t('remarksLabel')}</span>
        <textarea name="description" rows={2} placeholder={t('descriptionPlaceholder')} className={inputCls} />
      </label>

      <div className="sm:col-span-2">
        <Button type="submit">{t('submit')}</Button>
      </div>
    </form>
  );
}
