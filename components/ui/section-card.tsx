import * as React from 'react';
import { cn } from '@/lib/utils';
import { Card } from './card';

/**
 * r427 (50ed39e1 contest) — the label-and-value layout, as shared pieces a screen composes instead of
 * hand-writing its own label style. Built for the clocking import screens first; nothing else adopts them
 * in this round (the plan's promise), but they are written so another screen can.
 *
 * FOUR TEXT STYLES, AND ONLY FOUR: section heading, field label, field value, helper text. Each is a class
 * constant below, Classic first and the `monolith:` look appended (the same convention as card.tsx), so the
 * same markup paints both themes.
 *
 * LAYOUT BY THE SPACE THE SECTION HAS, NOT BY THE WINDOW. A SectionCard's body is a CSS size container
 * (`@container`), and a label/value row puts its label in a fixed 11rem column only when that body is at
 * least 36rem wide (`@xl:`); narrower, the label sits above its value. The page shell has a sidebar, so the
 * window width says little about the room a section actually gets; the container width says exactly that.
 *
 * LONG LABELS WRAP, NEVER CLIP: every label carries `overflow-wrap:anywhere` and none carries truncate or a
 * line clamp. Server-safe: no hooks, no 'use client'.
 */

/** Section heading: Classic 16px semibold; Monolith 16px/600 in ink. */
export const typeSectionCls = 'text-base font-semibold text-foreground monolith:text-[16px] monolith:font-semibold monolith:text-ink';
/** The section's number (`01`), in front of its heading: mono, quiet. */
export const typeIndexCls =
  'mr-2.5 font-mono text-xs font-normal tabular-nums text-muted-foreground monolith:text-[11px] monolith:tracking-[0.12em] monolith:text-mid';
/** Field label: Classic 13px medium muted; Monolith DM Mono 11px uppercase, tracking 0.12em, mid. */
export const typeLabelCls =
  'text-[13px] font-medium text-muted-foreground monolith:font-mono monolith:text-[11px] monolith:font-normal monolith:uppercase monolith:tracking-[0.12em] monolith:text-mid';
/** Field value: Classic 14px foreground; Monolith 15px medium ink. */
export const typeValueCls = 'text-sm text-foreground monolith:text-[15px] monolith:font-medium monolith:text-ink';
/** Helper text under the field it explains: Classic 12px muted; Monolith 13px mid. */
export const typeHelpCls = 'text-xs text-muted-foreground monolith:text-[13px] monolith:text-mid';

/** Wraps instead of clipping; used on every label. */
const WRAP = '[overflow-wrap:anywhere]';

/**
 * One section: a number and a heading, an optional note on the right and an optional line of helper text,
 * then its content. Classic paints it as a light white card (card.tsx's Card); Monolith as a 1px ink rule on
 * top with the content flush left. NEVER NEST ONE: a group inside a section is a sub-heading, not a section.
 */
export function SectionCard({
  index,
  title,
  aside,
  description,
  children,
  className,
  bodyClassName,
  id,
}: {
  index?: number;
  title: React.ReactNode;
  aside?: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <Card
      id={id}
      role="region"
      aria-label={typeof title === 'string' ? title : undefined}
      data-section-card
      className={cn('min-w-0', className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 pt-4 monolith:px-0 monolith:pt-4">
        <h2 className={cn(typeSectionCls, 'min-w-0', WRAP)}>
          {index != null && <span className={typeIndexCls}>{String(index).padStart(2, '0')}</span>}
          {title}
        </h2>
        {aside != null && <div className={typeHelpCls}>{aside}</div>}
      </div>
      {description != null && <p className={cn(typeHelpCls, 'px-5 pt-1 monolith:px-0')}>{description}</p>}
      <div className={cn('@container min-w-0 px-5 pb-5 pt-3 monolith:px-0 monolith:pb-1', bodyClassName)}>{children}</div>
    </Card>
  );
}

/** A small heading for a group inside a section (not a section of its own). */
export function SubHeading({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h3 className={cn(typeLabelCls, WRAP, 'pt-4', className)}>{children}</h3>;
}

/**
 * A read-only list of label/value pairs, as a <dl>. `columns={2}` puts two pairs side by side once the list
 * is 56rem wide — for read-only lists only (forms are always single-column).
 */
export function LabelValueList({
  columns = 1,
  children,
  className,
}: {
  columns?: 1 | 2;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('@container min-w-0', className)}>
      <dl data-label-value-list className={cn('grid grid-cols-1', columns === 2 && '@4xl:grid-cols-2 @4xl:gap-x-10')}>
        {children}
      </dl>
    </div>
  );
}

const ROW =
  'grid min-w-0 grid-cols-1 gap-1 border-b border-border py-2.5 @xl:grid-cols-[11rem_minmax(0,1fr)] @xl:gap-x-5 monolith:border-hairline';

/** The red asterisk of a mandatory field (Monolith: signal). Decorative — the field says so in words. */
export function RequiredMark() {
  return (
    <span aria-hidden="true" className="ml-0.5 text-destructive monolith:text-signal-text">
      *
    </span>
  );
}

/** One label and its value. On a wide section the label is a fixed column and every value starts at the same place. */
export function LabelValue({
  label,
  value,
  required,
  help,
  valueClassName,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  required?: boolean;
  help?: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className={ROW} data-label-value>
      <dt className={cn(typeLabelCls, WRAP, '@xl:pt-0.5')}>
        {label}
        {required && <RequiredMark />}
      </dt>
      <dd className={cn(typeValueCls, 'm-0 min-w-0', WRAP, valueClassName)}>
        {value}
        {help != null && <span className={cn(typeHelpCls, 'mt-1 block font-normal')}>{help}</span>}
      </dd>
    </div>
  );
}

/**
 * One form field: the same grid as LabelValue, so a read view and its edit form line up. The control column
 * is capped at max-w-xl. Pass `htmlFor` for a single control; a group (a radio group carries its own
 * aria-label) can omit it and the label is plain text.
 */
export function FormRow({
  label,
  htmlFor,
  required,
  help,
  children,
  className,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  required?: boolean;
  help?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const labelCls = cn(typeLabelCls, WRAP, 'block @xl:pt-2');
  return (
    <div className={cn(ROW, 'py-3', className)} data-form-row>
      {htmlFor ? (
        <label htmlFor={htmlFor} className={labelCls}>
          {label}
          {required && <RequiredMark />}
        </label>
      ) : (
        <span className={labelCls}>
          {label}
          {required && <RequiredMark />}
        </span>
      )}
      <div className="min-w-0 max-w-xl">
        {children}
        {help != null && <p className={cn(typeHelpCls, 'mt-1')}>{help}</p>}
      </div>
    </div>
  );
}

/** A left-ruled note (an explanation the screen must not lose). Classic keeps today's look; Monolith drops the tint. */
export const noteCls = 'border-l-2 border-primary bg-muted/40 px-4 py-3 text-sm monolith:border-ink monolith:bg-transparent';
