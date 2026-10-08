'use client';

import * as React from 'react';
import { CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDmy } from '@/lib/date-display';

/**
 * r422 (board 7e784380) — a date box that SHOWS DD-MMM-YYYY and POSTS yyyy-mm-dd.
 *
 * A native `<input type="date">` draws its value in the browser's locale (2026-01-31, 31/01/2026, 1/31/2026
 * …) and no attribute changes that. So the native input is KEPT — same `name`, same ISO `value`, same
 * `required`/`min`/`max`, so every server action that reads the field is untouched and the browser's own
 * calendar is still what picks the date — but it is laid INVISIBLY over a box that draws the value as
 * formatDmy draws it ("31-Jan-2026").
 *
 *  - The visible box carries the caller's `className` (inputCls or anything else), so it looks exactly like
 *    the input it replaces in Classic and Monolith; the focus ring is drawn on the box from the input's
 *    :focus-visible (`has-[:focus-visible]`).
 *  - CLICK anywhere on the box opens the calendar: the transparent input covers it and calls showPicker()
 *    where the browser supports it (Chrome, Edge, Firefox, Safari 16+). Without it the click still lands on
 *    the native input, which is today's behaviour.
 *  - KEYBOARD: the input is the focusable element, so Tab reaches it and the native date editing keys
 *    (digits, arrows, Backspace) still work; Space or Alt+ArrowDown opens the calendar (Enter is left
 *    alone: it keeps whatever the surrounding form does with it). Its aria-label is
 *    "<label>: 31-Jan-2026", so a screen reader hears the same format the eye sees.
 *  - The display follows the input whichever way its value changes: typing or picking (input/change), a
 *    form reset, a remount, a controlled `value`, and a script's `el.value = …` write (IcDobAutofill fills
 *    the Date of Birth that way, by DOM id).
 *
 * Display only: the component never parses, normalises or rewrites the value it posts.
 */
export type DateFieldProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue'> & {
  value?: string;
  defaultValue?: string | null;
  /** The field's name for the screen reader, prefixed to the formatted date in aria-label. */
  label?: string;
  /** Classes for the visible box — pass what the replaced `<input>` had (e.g. inputCls). */
  className?: string;
  /** What the box says when no date is chosen. Defaults to "—". */
  emptyText?: string;
};

type Native = HTMLInputElement & { showPicker?: () => void };

export const DateField = React.forwardRef<HTMLInputElement, DateFieldProps>(function DateField(
  { value, defaultValue, label, className, emptyText, onChange, onClick, onKeyDown, disabled, readOnly, 'aria-label': ariaLabelProp, ...rest },
  forwardedRef,
) {
  const controlled = value !== undefined;
  const [shown, setShown] = React.useState<string>(controlled ? value : (defaultValue ?? ''));
  const ref = React.useRef<Native | null>(null);

  // A controlled caller's value is the truth; an uncontrolled field mirrors its own input.
  const current = controlled ? value : shown;

  const setRefs = React.useCallback(
    (el: HTMLInputElement | null) => {
      ref.current = el as Native | null;
      if (typeof forwardedRef === 'function') forwardedRef(el);
      else if (forwardedRef) forwardedRef.current = el;
    },
    [forwardedRef],
  );

  // Follow writes that fire no event: a programmatic `el.value = …` and a form reset.
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => setShown(el.value);
    sync();
    // Wrap whatever `value` accessor the element has now (React's own value tracker sits on the instance),
    // so the write still reaches the element and React, and the display hears about it.
    const own = Object.getOwnPropertyDescriptor(el, 'value');
    const base = own ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (base?.get && base.set) {
      Object.defineProperty(el, 'value', {
        configurable: true,
        enumerable: base.enumerable,
        get() {
          return base.get!.call(this);
        },
        set(v: string) {
          base.set!.call(this, v);
          sync();
        },
      });
    }
    const form = el.form;
    const onReset = () => setTimeout(sync, 0);
    form?.addEventListener('reset', onReset);
    return () => {
      form?.removeEventListener('reset', onReset);
      if (own) Object.defineProperty(el, 'value', own);
      else delete (el as { value?: unknown }).value;
    };
  }, []);

  const openPicker = (el: Native) => {
    if (disabled || readOnly) return;
    try {
      el.showPicker?.();
    } catch {
      // showPicker throws when not triggered by a user gesture or in a cross-origin frame; the native
      // input is still focused and editable, which is the pre-r422 behaviour.
    }
  };

  const text = current ? formatDmy(current) : (emptyText ?? '—');
  const spoken = current ? formatDmy(current) : (emptyText ?? '');
  const ariaLabel = ariaLabelProp ?? ([label, spoken].filter(Boolean).join(': ') || undefined);

  return (
    <span
      data-date-field
      className={cn(
        className,
        'relative inline-flex min-w-36 items-center justify-between gap-2',
        'has-[:focus-visible]:border-ring has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/20',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        aria-hidden="true"
        data-date-display
        className={cn('pointer-events-none truncate tabular-nums', !current && 'text-muted-foreground')}
      >
        {text}
      </span>
      <CalendarDays aria-hidden="true" className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
      <input
        {...rest}
        ref={setRefs}
        type="date"
        disabled={disabled}
        readOnly={readOnly}
        aria-label={ariaLabel}
        {...(controlled ? { value } : { defaultValue: defaultValue ?? '' })}
        onChange={(e) => {
          if (!controlled) setShown(e.target.value);
          onChange?.(e);
        }}
        onClick={(e) => {
          openPicker(e.currentTarget);
          onClick?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === ' ' || (e.altKey && e.key === 'ArrowDown')) {
            e.preventDefault();
            openPicker(e.currentTarget);
          }
          onKeyDown?.(e);
        }}
        className={cn(
          'absolute inset-0 h-full w-full cursor-pointer opacity-0',
          '[&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:cursor-pointer',
          disabled && 'cursor-not-allowed',
        )}
      />
    </span>
  );
});
