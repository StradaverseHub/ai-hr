/**
 * r413 (item 79f3f64d, step 2) — the event-selection screen's one contract, read by the screen and by its
 * Continue handler so the two cannot disagree about it.
 *
 * A catalog entry opens this screen when it declares `event` (StatutoryFormLink). The screen names no
 * form: it resolves the entry by id from the catalog the admin's OWN company scope reaches, and an entry
 * that declares no `event` is not one of these forms (→ 404).
 */
import type { StatutoryFormLink } from '@/localization/country-pack';

export const EVENT_SCREEN = '/payroll/statutory-forms/event';
export const EVENT_CONTINUE = '/payroll/statutory-forms/event/continue';

/** Why Continue sent the operator back. Allowlisted; an unknown value shows nothing. */
export const EVENT_REFUSALS = ['none_selected'] as const;
export type EventRefusal = (typeof EVENT_REFUSALS)[number];
export const eventRefusalFrom = (raw: unknown): EventRefusal | null =>
  typeof raw === 'string' && (EVENT_REFUSALS as readonly string[]).includes(raw) ? (raw as EventRefusal) : null;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The entry, when it is a form about one person; null otherwise. */
export function eventLinkOf(
  links: readonly StatutoryFormLink[],
  formId: string,
): (StatutoryFormLink & { event: NonNullable<StatutoryFormLink['event']> }) | null {
  const l = links.find((x) => x.id === formId);
  return l?.event ? (l as StatutoryFormLink & { event: NonNullable<StatutoryFormLink['event']> }) : null;
}

/** Where the chosen person continues to. The id is validated by the caller; the path is the catalog's. */
export const eventPreviewHref = (previewPath: string, employmentId: string): string =>
  previewPath.replace('{employmentId}', encodeURIComponent(employmentId));

/** Back to the screen with the operator's company, search and the refusal kept. */
export function eventReturnHref(p: { formId: string; companyId?: string; q?: string; refusal?: EventRefusal }): string {
  const q = new URLSearchParams({ form: p.formId });
  if (p.companyId) q.set('companyId', p.companyId);
  if (p.q) q.set('q', p.q);
  if (p.refusal) q.set('refusal', p.refusal);
  return `${EVENT_SCREEN}?${q.toString()}`;
}
