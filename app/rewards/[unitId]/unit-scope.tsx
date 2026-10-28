import type { ReactNode } from 'react';
import { Field, inputCls } from '@/components/ui';
import { RewardSubmit } from '../submit-button';

/** 9070acae — a review is always exactly one company and one business unit, whatever the top company selector
 *  shows; the title, the scope line and every save button on the review name it. */
export const rewardReviewTitle = (cycle: string, company: string, unit: string) => `${cycle} · ${company ? `${company} / ` : ''}${unit}`;
export function UnitScopeNote({ text }: { text: string }) { return <p className="text-sm text-muted-foreground">{text}</p>; }
export function UnitLumpForm({ action, fields, defaultValue, scope, label, placeholder, submit }: { action: (f: FormData) => Promise<void>; fields: ReactNode; defaultValue: number | ''; scope: string; label: string; placeholder: string; submit: string }) {
  return <form action={action} className="space-y-2"><UnitScopeNote text={scope} /><div className="flex flex-wrap items-end gap-3">{fields}<Field label={label}><input type="number" min="0" step="0.01" name="lump" defaultValue={defaultValue} className={inputCls} placeholder={placeholder} /></Field><RewardSubmit type="submit" variant="secondary">{submit}</RewardSubmit></div></form>;
}
