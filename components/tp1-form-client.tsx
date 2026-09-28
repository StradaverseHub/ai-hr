'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ErrorBanner, inputCls } from '@/components/ui';
import type { Tp1FormAction, Tp1FormState } from '@/lib/tp1-form-state';

/**
 * ══ THE CLIENT ISLANDS OF THE TP1 DECLARATION FORM (r352, item 0df7dd44) ════════════════════════════
 *
 * `components/tp1-declaration-form.tsx` stays a SERVER component and stays the shell. These are the only
 * pieces that have to run in the browser, and they are here rather than there because one file cannot be
 * both sides of the boundary.
 *
 * ── WHAT WAS REPORTED, AND WHAT WAS ACTUALLY WRONG ──────────────────────────────────────────────────
 * The report reads "the system directly redirects the user back to the TP1 Relief screen … the user does
 * not receive a clear explanation of why the entry was rejected". The message was not missing: the
 * services have named the limit, the accumulated figure and the shortfall since r209. The REFUSAL WAS
 * BEING RENDERED ON A DIFFERENT SCREEN. Every write action redirected to the TP1 Relief LIST with
 * `?error=`, the list drew the banner, and the form — seventeen numbered items, forty-odd uncontrolled
 * amount boxes — was unmounted with everything in it. The form page's own ErrorBanner existed and no
 * action ever targeted it.
 *
 * So the fix is three things, in this order of importance:
 *   1. the refusal comes back to the form being filled in (`Tp1EditableForm`, `useActionState`);
 *   2. nothing keyed is lost when it does — which is why every field a reader can type into is
 *      CONTROLLED here. React resets an uncontrolled field once a form action resolves even without a
 *      redirect (components/claim-form.tsx records the same finding), so an uncontrolled box would be
 *      blanked by the very round trip that reports the error;
 *   3. the over-claim is shown and corrected BEFORE submit, next to the box that caused it
 *      (`Tp1ItemBoxes`).
 *
 * ── ⚠️ THE CLAMP TARGET IS `limit − already`, NEVER `limit` ──────────────────────────────────────────
 * An employee with an RM 8,000 line and RM 5,000 already approved for the assessment year may still
 * claim RM 3,000. Clamping to the LIMIT would quietly hand them 8,000 — a real reduction in a real
 * person's tax, on a statutory form, with the screen showing a number the server would have refused.
 * Every figure below is `Math.max(0, limit − already)` and every one of them comes from the accumulation
 * `core/tax-relief.ts` already computes (`getTp1Accumulated*` → `tp1CountForYear`) and already refuses
 * against (`assertWithinRemaining`). There is no second accumulation rule here, and there must not be.
 *
 * ── AND THE LIMIT THAT BITES IS NOT ALWAYS THE BOX'S OWN ────────────────────────────────────────────
 * The catalogue has four shapes and the server checks all of them, so the screen has to as well:
 *   · an item with one box and an annual limit (C2, C7…C10, C12…C15, C17) — the box's ceiling is the
 *     item's own remaining;
 *   · an item with lettered boxes under a GROUP limit, some boxes also carrying their own printed cap
 *     (C1, C3, C4, C11) — a box may go no higher than the SMALLER of its own remaining and what the
 *     group has left after the other boxes on the item. That is why this island is per ITEM and not per
 *     box: the ceiling of C5(b) depends on what is sitting in C5(a), which no server render can know;
 *   · `perSubLimit` (C16) — two independent claims with their own limits and no group at all;
 *   · `limit: null` (Section D, and the un-capped lettered lines) — NOT CLAMPED AND NOT BLOCKED. ADR-0008:
 *     the agency's form prints no figure there, so neither do we, and nothing may invent one.
 *
 * ── NO `max` ATTRIBUTE, ON PURPOSE ──────────────────────────────────────────────────────────────────
 * `max` looks like the obvious belt to go with these braces. It is not: HTML constraint validation
 * BLOCKS submission of an out-of-range number box and explains itself with a browser bubble, in the
 * browser's language, over a form whose whole complaint was an unclear refusal. And a draft saved before
 * this round can legitimately hold a figure above today's remaining, which `max` would make unsubmittable
 * with no way for the reader to see why. The clamp is visible, explained and in the reader's locale; the
 * server refusal behind it is the backstop.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const rm = (n: number) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A keyed box as a number. Blank, NaN and negatives all read as nothing claimed — the server agrees. */
const parse = (v: string | undefined): number => {
  const n = Number(v ?? '');
  return Number.isFinite(n) && n > 0 ? round2(n) : 0;
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// The form element, and the refusal that no longer navigates
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The ONE editable `<form>`. It owns the action, so a refusal returns a state instead of a redirect and
 * the fields — and the reader's place on the page — survive it.
 *
 * The banner is the first thing inside the form, and it is scrolled into view when it appears: the
 * buttons are at the FOOT of a form seventeen items long, so an error drawn silently at the top is an
 * error the reader never sees. `block: 'center'` rather than a jump to the top of the document, so the
 * surrounding fields stay in frame.
 */
export function Tp1EditableForm({
  action,
  formId,
  className,
  children,
}: {
  action: Tp1FormAction;
  formId: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState<Tp1FormState, FormData>(action, { error: null });
  const bannerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (state.error) bannerRef.current?.scrollIntoView({ block: 'center' });
  }, [state.error]);
  return (
    <form id={formId} action={formAction} className={className}>
      <div ref={bannerRef}>{state.error ? <ErrorBanner message={state.error} /> : null}</div>
      {children}
    </form>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Section C / D — one item's amount boxes, their four figures, and the visible clamp
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/** One amount box of one catalogue item. Plain data: numbers, strings and nulls only. */
export type Tp1AmountBox = {
  /** The form field name, exactly as `lib/tp1-form-input.ts` reads it. */
  name: string;
  /** The lettered sub-line code, or null for an item's single box. */
  sub: string | null;
  /** The "(Limited RM…)" this line prints on the form, or null (ADR-0008 ⇒ unchecked). */
  limit: number | null;
  /** What is already APPROVED this assessment year against THIS line, in the other deduction months. */
  already: number;
  /** A frequency rule the form states in words, as its catalogue key. Captured, printed, not enforced. */
  frequency: string | null;
  /** The saved figure at 2dp, or '' when nothing is keyed. */
  value: string;
};

/** Which ceiling bit, and the three figures that explain it. */
type Bite = { cap: number; kind: 'line' | 'item'; label: string; limit: number; already: number };

export function Tp1ItemBoxes({
  group,
  code,
  limit,
  already,
  perSubLimit,
  boxes,
}: {
  group: 'items' | 'rebates';
  /** The catalogue item code — `c1`…`c17`, `d1`. */
  code: string;
  /** The item's ANNUAL LIMIT column, or null when the form prints none. */
  limit: number | null;
  /** What is already approved this assessment year against the ITEM. */
  already: number;
  /** C16: each band is its own claim with its own limit, so the item has no group ceiling. */
  perSubLimit: boolean;
  boxes: Tp1AmountBox[];
}) {
  const t = useTranslations('taxRelief');
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(boxes.map((b) => [b.name, b.value])),
  );
  /** The box names whose last keystroke was clamped, with the figures that did it. */
  const [clamped, setClamped] = useState<Record<string, Bite>>({});

  const itemCode = code.toUpperCase();
  /** The item's own remaining — the number `assertWithinRemaining` would name. Null ⇒ unchecked. */
  const itemRemaining = limit == null || perSubLimit ? null : Math.max(0, round2(limit - already));

  /** What the OTHER boxes on this item currently account for. The group limit caps their SUM. */
  const othersOf = (name: string, from: Record<string, string>) =>
    boxes.reduce((sum, b) => (b.name === name ? sum : round2(sum + parse(from[b.name]))), 0);

  /**
   * The most this box may hold, and which of the two ceilings said so. The smaller wins, because the
   * server checks both: the sub-line against its printed cap (`validateAmount`) and the item's total
   * against its annual limit (`validateCatalogueCategories`, then `assertWithinRemaining` for the year).
   */
  const biteOf = (box: Tp1AmountBox, from: Record<string, string>): Bite | null => {
    const byLine = box.limit == null ? null : Math.max(0, round2(box.limit - box.already));
    const byItem = itemRemaining == null ? null : Math.max(0, round2(itemRemaining - othersOf(box.name, from)));
    const lineLabel = box.sub == null ? itemCode : `${itemCode}(${box.sub})`;
    if (byLine != null && (byItem == null || byLine <= byItem)) {
      return { cap: byLine, kind: 'line', label: lineLabel, limit: box.limit!, already: box.already };
    }
    if (byItem != null) {
      // A single-box item IS its own line: there are no sibling boxes, so the item's figures explain it
      // directly and the wordier "the other lines leave you …" sentence would be about nothing.
      return {
        cap: byItem,
        kind: boxes.length === 1 ? 'line' : 'item',
        label: boxes.length === 1 ? lineLabel : itemCode,
        limit: limit!,
        already,
      };
    }
    return null; // ADR-0008 — no sourced figure anywhere on this box, so nothing to clamp to.
  };

  /**
   * One keystroke. Read from the render's own state rather than through an updater callback: dispatching
   * a second setState from inside an updater is a side effect in a function React is allowed to call
   * twice, and it would double-report the clamp under StrictMode.
   */
  const onKey = (box: Tp1AmountBox, raw: string) => {
    const bite = biteOf(box, values);
    if (bite == null || raw.trim() === '' || parse(raw) <= bite.cap) {
      setValues({ ...values, [box.name]: raw });
      if (clamped[box.name]) {
        const { [box.name]: _cleared, ...rest } = clamped;
        setClamped(rest);
      }
      return;
    }
    // ⚠️ DOWN TO `limit − already` (less whatever the sibling boxes hold), never to the limit.
    setValues({ ...values, [box.name]: bite.cap.toFixed(2) });
    setClamped({ ...clamped, [box.name]: bite });
  };

  /** Annual limit · Accumulated · Remaining, for one line. The same three the server enforces. */
  const strip = (lineLimit: number | null, prior: number) => {
    const remaining = lineLimit == null ? null : Math.max(0, round2(lineLimit - prior));
    return (
      <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
        <div className="flex gap-1">
          <dt>{t('colAnnualLimit')}</dt>
          <dd className="tabular-nums">{lineLimit == null ? t('noLimit') : rm(lineLimit)}</dd>
        </div>
        <div className="flex gap-1">
          <dt>{t('colAccumulated')}</dt>
          <dd className="tabular-nums">{rm(prior)}</dd>
        </div>
        {remaining != null && (
          <div className="flex gap-1">
            <dt>{t('colRemaining')}</dt>
            <dd className="tabular-nums font-medium text-foreground">{rm(remaining)}</dd>
          </div>
        )}
      </dl>
    );
  };

  /**
   * The explanation, next to the box that caused it: which line, its limit, what is already approved
   * this assessment year, and what was therefore left. Every ringgit figure is interpolated — none of
   * these sentences may carry a statutory number of its own (test/tp1-2026-form.test.ts).
   */
  const note = (bite: Bite) => (
    <p
      role="status"
      className="mt-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
    >
      {t(bite.kind === 'line' ? 'limit.clampedLine' : 'limit.clampedItem', {
        label: bite.label,
        limit: rm(bite.limit),
        already: rm(bite.already),
        remaining: rm(bite.cap),
      })}
    </p>
  );

  const amountInput = (box: Tp1AmountBox) => (
    <>
      <input
        type="number"
        name={box.name}
        min="0"
        step="0.01"
        value={values[box.name] ?? ''}
        onChange={(e) => onKey(box, e.target.value)}
        placeholder="0.00"
        aria-label={`${box.sub == null ? itemCode : `${itemCode}(${box.sub})`} ${t('colCurrent')}`}
        className={`${inputCls} mt-1 max-w-[14rem]`}
      />
      {clamped[box.name] ? note(clamped[box.name]) : null}
    </>
  );

  const single = boxes.length === 1 && boxes[0].sub == null ? boxes[0] : null;
  if (single) {
    return (
      <>
        {strip(limit, already)}
        {amountInput(single)}
      </>
    );
  }

  return (
    <>
      {/* A group limit belongs to the ITEM; a `perSubLimit` item (C16) has none and each band carries its
          own — so the item-level strip is skipped there rather than printing a "—". */}
      {!perSubLimit && strip(limit, already)}
      <div className="mt-1 space-y-2">
        {boxes.map((box) => (
          <div key={box.name} className="rounded-md border border-border/60 px-3 py-2">
            <p className="text-xs">
              <span className="font-medium">({box.sub})</span> {t(`${group}.${code}.sub.${box.sub}`)}
            </p>
            {box.frequency && (
              <p className="mt-0.5 text-xs italic text-muted-foreground">{t(`frequency.${box.frequency}`)}</p>
            )}
            {(box.limit != null || perSubLimit) && strip(box.limit, box.already)}
            {amountInput(box)}
          </div>
        ))}
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Section E and the remarks note — controlled for one reason only: an error must not blank them
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * RULE 17, UNCHANGED AND STILL LOAD-BEARING: the hidden `no` is rendered FIRST and always submitted; the
 * checkbox contributes a `yes`. `lib/tp1-form-input.ts` reads every value under the name and asks whether
 * 'yes' is among them, so an unticked box submits a real, transmitted 'no' rather than nothing at all.
 * The tick is CONTROLLED so a refused submit does not silently untick a declaration the reader accepted.
 */
export function Tp1DeclarationTick({ defaultChecked }: { defaultChecked: boolean }) {
  const t = useTranslations('taxRelief');
  const [checked, setChecked] = useState(defaultChecked);
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input type="hidden" name="declarationAccepted" value="no" />
      <label className="flex items-start gap-2 text-sm">
        <input
          ref={ref}
          type="checkbox"
          name="declarationAccepted"
          value="yes"
          checked={checked}
          onChange={(e) => {
            setChecked(e.target.checked);
            /*
              ⚠️ THE DEFAULT MOVES WITH THE CHOICE, AND NOT AS A BELT-AND-BRACES GESTURE.
              React resets the form once a form action resolves, and a reset restores every control to its
              DEFAULT state — for a text box React then re-applies its own controlled `value`, which is why
              the amount boxes and the remarks note survive a refusal. It does NOT do that for a checkbox's
              `checked`, and it has no reason to: the element is referentially identical across the parent's
              re-render, so nothing re-commits it. MEASURED: without this line a refused Submit silently
              cleared a Section E declaration the reader had accepted, and the next press was refused again
              for the tick rather than for the figure. Moving the ATTRIBUTE makes the platform's own reset
              restore the reader's answer, so the DOM and React state cannot drift apart.
            */
            if (ref.current) ref.current.defaultChecked = e.target.checked;
          }}
          className="mt-0.5"
        />
        <span>{t('declarationTick')}</span>
      </label>
    </>
  );
}

/** The free-text note. Controlled for the same reason the tick is: a refusal must not erase it. */
export function Tp1RemarksField({ defaultValue }: { defaultValue: string }) {
  const t = useTranslations('taxRelief');
  const [value, setValue] = useState(defaultValue);
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{t('remarksLabel')}</span>
      <textarea
        name="remarks"
        rows={3}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('remarksPlaceholder')}
        className={inputCls}
      />
    </label>
  );
}
