import { Card, Field, SectionHeader, inputCls } from '@/components/ui';
import type { ReactNode } from 'react';

/**
 * MY PROFILE — the read-only field, the read-only card, and nothing else.
 *
 * r259 stage one. Two small server components, and the reason they exist rather than being written
 * inline forty times is that "the employee sees the same shape HR sees" has to be one decision, not
 * forty.
 *
 * ── WHY A DISABLED <input> AND NOT PLAIN TEXT ───────────────────────────────────────────────────────
 * This is Personnel Management's own read-only renderer, kept identical on purpose. The Employment tab
 * has rendered its view-only fields this way since 8ebabbf2 / 89ea527b — the local `readOnlyValue`
 * helper in app/admin/personnel/[employmentId]/page.tsx — for three reasons that apply here unchanged:
 *
 *   • it keeps the card's existing look and the field's SHAPE, so an empty value still reads as a field
 *     rather than as missing markup;
 *   • it carries no `name`, so the value can never be submitted by a sibling form — which matters more
 *     on /me than it does there, because /me still has two real forms on it (the contact self-edit and
 *     the approval-gated change request) and neither may pick up a field it does not own;
 *   • `aria-readonly` alongside `disabled` keeps it announced to screen readers instead of skipped.
 *
 * The same idiom answers the anti-fork requirement one level up: the Family tab's view dialog renders
 * the EDIT fields inside `<fieldset disabled>` precisely so "the read-only view can never drift from the
 * Edit layout, and can never post". `ReadField` is that rule applied to a screen rather than a dialog.
 *
 * test/me-profile-visibility.test.ts pins the shape against the Personnel helper, so the two cannot
 * quietly become different renderings of the same idea.
 */

/** One label + one value, rendered the way the Personnel screen renders a view-only field. */
export function ReadField({
  label,
  value,
  notSet,
  className,
  title,
}: {
  label: string;
  /** Already-resolved display text. Null/undefined/'' all render `notSet`. */
  value: string | null | undefined;
  /** The caller's "not recorded" text — Personnel uses people.detail.optionNotSet; passed in so this
   *  file needs no translation namespace of its own and cannot introduce a second wording. */
  notSet: string;
  className?: string;
  title?: string;
}) {
  const shown = value == null || value === '' ? notSet : value;
  return (
    <Field label={label} className={className}>
      <input value={shown} disabled readOnly aria-readonly="true" title={title} className={inputCls} />
    </Field>
  );
}

/**
 * One card on My Profile: the Personnel section title, then a full-width responsive grid of fields.
 *
 * FULL WIDTH AND FOUR ACROSS is the plan's own wording — "full width, arranged in cards, so a section
 * reads across the screen instead of being scrolled past". Four columns matches the Personnel cards'
 * `sm:grid-cols-4`, so a section that reads as one band there reads as one band here.
 */
export function ReadCard({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <Card id={id}>
      <SectionHeader title={title} />
      <div className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
    </Card>
  );
}

/** A labelled band inside a ReadCard — the Personnel cards' `<fieldset><legend>` grouping. */
export function ReadGroup({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="col-span-full">
      <legend className="mb-2 w-full text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {legend}
      </legend>
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
    </fieldset>
  );
}
