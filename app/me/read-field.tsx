import { Card, Field, SectionHeader, inputCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * r401 — MONOLITH (docs/design/monolith/reference/P-MyProfile.dc.html, README §4 "Spec grids are the read-only
 * form"). Appended `monolith:` utilities only, so Classic renders exactly as before. In Monolith a read-only
 * field reads as the board's `.kv` pair: a mono label over a 500-weight value on a hairline, no box. The value
 * stays a disabled, unnamed input (the Personnel idiom above), only drawn without its box.
 */
const MONO_READ_VALUE =
  'monolith:h-auto monolith:min-h-10 monolith:rounded-none monolith:border-0 monolith:border-b monolith:border-hairline monolith:bg-transparent monolith:px-0 monolith:text-[15px] monolith:font-medium monolith:text-ink monolith:opacity-100 monolith:shadow-none monolith:disabled:cursor-default';
/** The section head on My Profile in Monolith: a mono index-style label, no rule under it, flush left. */
export const MONO_ME_SECTION_HEAD =
  'monolith:border-b-0 monolith:px-0 monolith:pt-3 monolith:pb-2 monolith:font-mono monolith:text-[11px] monolith:font-normal monolith:uppercase monolith:tracking-[0.12em] monolith:text-mid';
/** Every field label inside a card: DM Mono, uppercase, mid (`.fd > .mono`). */
const MONO_LABELS =
  'monolith:[&_label>span:first-child]:font-mono monolith:[&_label>span:first-child]:text-[11px] monolith:[&_label>span:first-child]:font-normal monolith:[&_label>span:first-child]:uppercase monolith:[&_label>span:first-child]:tracking-[0.12em] monolith:[&_label>span:first-child]:text-mid';

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

/**
 * One label + one value, rendered the way the Personnel screen renders a view-only field.
 *
 * ── r260 STAGE TWO: `pending` DRAWS A REQUESTED VALUE BESIDE THE MASTER ONE, NEVER OVER IT ──────────
 * The approved plan's wording, which this prop exists to keep: "A field with a request waiting shows
 * both values — what it is now and what was asked for — so nobody is confused about which one is real."
 *
 * So the disabled input keeps showing the MASTER value, unchanged and in the same place it was before a
 * request existed, and the requested value is a second line underneath it, labelled as awaited. The
 * alternative — swapping the displayed value for the requested one and marking it "pending" — is the
 * failure the sentence describes: an employee would read their record and see a number that is not yet
 * their number, on the same screen their payslip is generated from.
 */
export function ReadField({
  label,
  value,
  notSet,
  className,
  title,
  pending,
}: {
  label: string;
  /** Already-resolved display text. Null/undefined/'' all render `notSet`. */
  value: string | null | undefined;
  /** The caller's "not recorded" text — Personnel uses people.detail.optionNotSet; passed in so this
   *  file needs no translation namespace of its own and cannot introduce a second wording. */
  notSet: string;
  className?: string;
  title?: string;
  /**
   * A change waiting on an approver: the requested value, already resolved to display text by the
   * caller, and the caller's own "requested, awaiting approval" wording. Absent (the ordinary case)
   * renders exactly what this component rendered in stage one, byte for byte.
   */
  pending?: { value: string; label: string } | null;
}) {
  const shown = value == null || value === '' ? notSet : value;
  return (
    <Field label={label} className={className}>
      <input value={shown} disabled readOnly aria-readonly="true" title={title} className={cn(inputCls, MONO_READ_VALUE)} />
      {pending ? (
        <p className="mt-1 flex flex-wrap items-baseline gap-1 text-[11px] text-amber-700 dark:text-amber-400 monolith:text-signal-text">
          <span className="font-medium">{pending.label}</span>
          <span className="font-semibold">{pending.value}</span>
        </p>
      ) : null}
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
      <SectionHeader title={title} className={MONO_ME_SECTION_HEAD} />
      <div className={cn('grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4', 'monolith:gap-x-5 monolith:gap-y-4 monolith:px-0 monolith:pt-1', MONO_LABELS)}>
        {children}
      </div>
    </Card>
  );
}

/** A labelled band inside a ReadCard — the Personnel cards' `<fieldset><legend>` grouping. */
export function ReadGroup({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="col-span-full">
      <legend className="mb-2 w-full text-xs font-medium uppercase tracking-wide text-muted-foreground monolith:border-t monolith:border-ink monolith:pt-2.5 monolith:font-mono monolith:text-[11px] monolith:font-normal monolith:tracking-[0.12em] monolith:text-ink">
        {legend}
      </legend>
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
    </fieldset>
  );
}
