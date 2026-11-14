'use client';
/**
 * d1e26f81 — the "Set for all items" header, panel and item summary line shared by onboarding "Equipment and
 * access" and offboarding "Return and revoke". Extracted from components/onboarding-equipment.tsx without a
 * visual change; every string goes through the onboarding copy catalogue.
 */
import { useState } from 'react';
import { ActionButton } from '@/components/ui/action-button';
import { useOnboardingCopy } from '@/lib/onboarding-copy';

export type BulkChange = { group?: string; method?: 'rr' | 'manual'; due?: number };

export function ItemsSectionHeader({ title, count, canBulk, open, onToggle }: { title: string; count: string; canBulk: boolean; open: boolean; onToggle: () => void }) {
  const copy = useOnboardingCopy();
  return <div className="flex flex-wrap items-center justify-between gap-3"><div><h2>{title}</h2><p className="onb-muted">{count}</p></div>{canBulk && <button type="button" className="v9-button" aria-expanded={open} onClick={onToggle}>{copy('Set for all items')}</button>}</div>;
}

/** Same fields, defaults, help text and buttons on both surfaces; only the meaning of Day differs (start date or last working day). */
export function SetForAllPanel({ count, draft, groups, busy, apply, cancel }: { count: number; draft: boolean; groups: { id: string; name: string }[]; busy: boolean; apply: (change: BulkChange) => void; cancel: () => void }) {
  const copy = useOnboardingCopy();
  const [group, setGroup] = useState(''), [method, setMethod] = useState(''), [due, setDue] = useState('');
  const validDue = due === '' || /^(?:-\d{1,3}|\d{1,4})$/.test(due) && Number(due) >= -999 && Number(due) <= 9999;
  return <div className="v9-panel v9-stack"><strong>{copy(draft ? '{count} items' : '{count} items not yet done', { count })}</strong><div className="v9-fields"><label className="v9-field"><span>{copy('Team')}</span><select aria-label={copy('Team for all items')} value={group} disabled={busy} onChange={event => setGroup(event.target.value)}><option value="">{copy('No change')}</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label><label className="v9-field"><span>{copy('Assignment')}</span><select aria-label={copy('Assignment for all items')} value={method} disabled={busy} onChange={event => setMethod(event.target.value)}><option value="">{copy('No change')}</option><option value="rr">{copy('Round robin')}</option><option value="manual">{copy('Manual')}</option></select></label><label className="v9-field"><span>{copy('Due by Day')}</span><input className="v9-input" inputMode="numeric" aria-label={copy('Due by Day for all items')} value={due} disabled={busy} maxLength={4} onChange={event => setDue(event.target.value)}/></label></div>{!validDue && <p role="alert" className="v9-error">{copy('Enter a whole day from -999 to 9999.')}</p>}<p className="v9-muted">{copy("Changing the team reassigns round-robin items to someone in the new team. Items already done aren't changed.")}</p><div className="v9-actions"><ActionButton guardNavigation aria-busy={busy} className="v9-button v9-button-primary" type="button" disabled={busy || !validDue || !group && !method && due === ''} onClick={() => apply({ ...(group ? { group } : {}), ...(method ? { method: method as 'rr' | 'manual' } : {}), ...(due !== '' ? { due: Number(due) } : {}) })}>{copy('Apply to all items')}</ActionButton><ActionButton guardNavigation={false} aria-busy={busy} type="button" className="v9-button" disabled={busy} onClick={cancel}>{copy('Cancel')}</ActionButton></div></div>;
}

/** "{team} · Round robin · due Day n" — or the fixed date when the item has no Day offset. */
export function ItemSummaryLine({ team, method, dueDay, fixedDate }: { team: string; method: 'rr' | 'manual' | undefined; dueDay: number | null | undefined; fixedDate?: string }) {
  const copy = useOnboardingCopy();
  return <p className="onb-muted">{team} · {copy(method === 'manual' ? 'Manual' : 'Round robin')} · {typeof dueDay === 'number' ? copy('due Day {day}', { day: dueDay }) : copy('due {date}', { date: fixedDate ?? '—' })}</p>;
}
