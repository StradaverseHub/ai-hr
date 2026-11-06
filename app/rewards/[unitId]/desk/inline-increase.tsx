'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from '@/components/ui';
import { saveInlineRewardIncrease } from '../../actions';

const fields = { meritBp: 'merit', promotionBp: 'promotion', specialBp: 'special' } as const;
type IncreaseField = keyof typeof fields;

export function InlineRewardIncrease({ unitId, entryId, revision, values }: {
  unitId: string; entryId: string; revision: number; values: Record<IncreaseField, number | null>;
}) {
  const t = useTranslations('rewards');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [drafts, setDrafts] = useState(() => ({
    meritBp: text(values.meritBp), promotionBp: text(values.promotionBp), specialBp: text(values.specialBp),
  }));
  useEffect(() => {
    setDrafts({ meritBp: text(values.meritBp), promotionBp: text(values.promotionBp), specialBp: text(values.specialBp) });
  }, [values.meritBp, values.promotionBp, values.specialBp]);

  async function save(field: IncreaseField, value: string) {
    if (inFlight.current || value === text(values[field])) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await saveInlineRewardIncrease(unitId, revision, entryId, field, value);
      if (result.ok) {
        setDrafts(previous => ({ ...previous, [field]: text(result.override) }));
        setMessage(t('recommendationSaved'));
      } else setError(result.error);
    } catch {
      setError(t('recommendationSaveFailed'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <details className="mt-1 text-left text-xs">
    <summary className="cursor-pointer text-primary">{t('recommendation')}</summary>
    <div className="mt-2 space-y-2">
      {(Object.keys(fields) as IncreaseField[]).map(field => <div className="flex items-end gap-1" key={field}>
        <label className="grid gap-1">{t(fields[field])} (%)
          <input className={`${inputCls} w-24 ${values[field] != null ? 'border-primary' : ''}`}
            type="number" min="0" max="999" step="0.01" placeholder={t('automatic')}
            disabled={busy} value={drafts[field]}
            onChange={event => setDrafts(previous => ({ ...previous, [field]: event.target.value }))}
            onBlur={event => { if (event.target.validity.valid) void save(field, event.target.value); }}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />
        </label>
        {values[field] != null && <button type="button" disabled={busy} className="pb-2 text-primary underline"
          onMouseDown={event => event.preventDefault()} onClick={() => void save(field, '')}>{t('resetRecommendation')}</button>}
      </div>)}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert" className="max-w-56 whitespace-normal text-destructive">{error}</p>}
    </div>
  </details>;
}

const text = (value: number | null) => value == null ? '' : String(value / 100);
