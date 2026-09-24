'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Field, btnPrimary, inputCls } from '../ui';
import { eligibleExtendedMinutes, extendedHoursCreditDays, type ExtendedHoursTiers } from '@/lib/extended-hours';

type Action = (fd: FormData) => void | Promise<void>;

/**
 * 2a237f5f — ONE type, not a list, and the singular is the fix.
 *
 * This used to be `ReplacementLeaveTypeOption[]`, mapped from every leave type the employee was eligible
 * for and rendered as a `<select>`. There is no list to offer: a Leave Credit is always Replacement Leave
 * (see the leave-type field below). Taking the plural away is what makes "no other type can be offered" a
 * property of the component rather than a promise about its caller — with no array in hand it has nothing
 * else it could draw.
 *
 * `name`, not `label`: it is the TENANT's own name for their replacement type, resolved from their
 * catalogue and localized by the page's `listLeaveTypes(locale)` read — not a translated constant, so a
 * customer whose type is called "Off in Lieu" reads "Off in Lieu".
 */
export type ReplacementLeaveTypeView = { id: string; name: string };

type DayKind = 'workday' | 'rest_day' | 'off_day' | 'holiday';

/** r336 — the four read-only facts Section B needs for one date, as the server action returns them. */
export type ExtendedHoursDayView = {
  kind: DayKind;
  shiftEnd: string | null;
  actualClockOut: string | null;
  measuredExtendedMinutes: number;
};

type ARow = { key: number; workedDate: string; days: '1' | '0.5' };
type BRow = { key: number; workedDate: string; start: string; end: string };

const round2 = (n: number) => Math.round(n * 100) / 100;
/** `18:30:00` → `18:30`. A time column comes back with seconds; nobody claims a shift end to the second. */
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);

/**
 * "+ Leave Credit request" — the employee's own claim for time already worked.
 *
 * ── r336 cbfa8b0b · ONE MODAL, TWO KINDS OF CLAIM, AND THEY ARE NOT TWO FLAVOURS OF ONE THING ───────────
 *
 * SECTION A — NON-WORKING-DAY WORK. A rest day, an off day or a public holiday that was worked. The day
 * type is READ-ONLY, resolved from the employee's own roster through `dayKindAction`, and the credit is 1
 * day or half a day. A date the roster calls an ordinary working day is refused here and pointed at
 * Section B, by name, because "this cannot earn a credit" is useless advice inside a modal that contains
 * the place it CAN be claimed.
 *
 * SECTION B — EXTENDED ORDINARY-DAY WORK. Hours past the scheduled shift end of a WORKING day. Four of the
 * row's seven fields are read-only and three of those are facts the system already owns: the scheduled
 * shift end (the roster), the actual clock-out (Attendance) and, once the employee types their window, the
 * eligible minutes and the credit those minutes earn. The employee types only the window.
 *
 * ── THE UNIT IS NOT A CHOICE ANY MORE, AND THAT IS r333's PRECEDENT APPLIED ─────────────────────────────
 * This form used to carry a Day/Hour `<select>` and totalled whichever was chosen. Both sections now
 * produce a credit in DAYS — Section A because a non-working day is claimed as a day, Section B because
 * r334's ladder converts minutes to 0.5 or 1.0 and never to a proportion — so an Hour request has nothing
 * left to mean. 2a237f5f made the leave TYPE a fixed read-only field for exactly this reason (the form was
 * accepting an answer the engine discarded); the unit is the same shape and is the same fix. The service
 * refuses a mixed request server-side, so the removed control is not the control.
 *
 * ── EVERY FIGURE HERE IS FOR THE EMPLOYEE TO CHECK, NOT FOR THE SERVER TO TRUST ─────────────────────────
 * The per-section totals, the grand total, the eligible minutes and the credit are all recomputed by
 * `core/replacement-request.ts` from the posted dates and windows before anything is stored, and Section
 * B's figures are recomputed AGAIN at approval from the live attendance row. A client that lied about any
 * of them would change nothing. What the arithmetic here must be is the SAME arithmetic, which is why the
 * tier ladder and the eligible-minutes derivation are imported from `lib/extended-hours.ts` rather than
 * written twice — a copy would agree until a company moved a threshold, and then the screen would promise
 * a credit the approval refuses.
 *
 * ── THE FORM SHAPE: TWO SETS OF FIELD NAMES, NOT ONE ZIPPED LIST ────────────────────────────────────────
 * Section A posts `aWorkedDate` + `aDays`; Section B posts `bWorkedDate` + `bStart` + `bEnd`. They are
 * separate names because the action zips repeated fields BY INDEX, and one shared `workedDate` list would
 * be longer than either section's own value list the moment both sections had rows — silently shifting
 * every row after the first. Each name's array is the same length as its section's rows by construction.
 *
 * All copy comes from `useTranslations` INSIDE this client component — the house pattern for client
 * widgets, and the one that structurally cannot hit the server→client function-prop hazard, because no
 * translator ever crosses the boundary.
 */
export function ReplacementLeaveRequestDialog({
  replacementType,
  submitAction,
  today,
  requiresFirstScheduleConsent,
  dayKindAction,
  extendedHoursAction,
  extendedHoursTiers,
}: {
  /**
   * 2a237f5f — the tenant's Replacement Leave type, already resolved by the page. Required and singular:
   * the page renders no dialog at all when the tenant has none, so there is no "nothing selected" state.
   */
  replacementType: ReplacementLeaveTypeView;
  submitAction: Action;
  /** 3fb1a611 — resolves the kind of day a date is for the signed-in employee. Optional: omitted ⇒ no chip. */
  dayKindAction?: (workedDate: string) => Promise<DayKind | null>;
  /**
   * r336 — resolves Section B's four read-only facts for a date. Present ONLY when the company has switched
   * extended hours on: the page passes it conditionally, and with it absent Section B is not drawn at all.
   * That is the same shape the whole feature uses — the switch is checked in the service too, so a hidden
   * section is a courtesy and the refusal is the control.
   */
  extendedHoursAction?: (workedDate: string) => Promise<ExtendedHoursDayView | null>;
  /** r336 — the company's tier figures, so the credit shown as the employee types is the one they will get. */
  extendedHoursTiers?: ExtendedHoursTiers;
  /** Today in the tenant's zone, resolved on the server — the max selectable worked date. */
  today: string;
  /**
   * The employee is within the First Schedule and their company allows banking with consent, so the
   * agreement checkbox is required. A plain boolean: the SERVER decides this and enforces it again on
   * submit (core/replacement-request.ts). Rendering it is how the agreement gets recorded, not how it
   * gets checked.
   */
  requiresFirstScheduleConsent?: boolean;
}) {
  const t = useTranslations('replacementRequest');
  const [open, setOpen] = useState(false);
  const sectionBOffered = extendedHoursAction != null && extendedHoursTiers != null;

  const [aRows, setARows] = useState<ARow[]>([{ key: 1, workedDate: '', days: '1' }]);
  const [bRows, setBRows] = useState<BRow[]>([{ key: 1, workedDate: '', start: '', end: '' }]);

  // 3fb1a611 — the kind of each distinct Section A date, fetched once per date.
  const [kinds, setKinds] = useState<Record<string, DayKind | null>>({});
  const aDatesKey = aRows.map((r) => r.workedDate).join('|');
  useEffect(() => {
    if (!dayKindAction) return;
    for (const d of new Set(aDatesKey.split('|').filter(Boolean))) {
      if (d in kinds) continue;
      // Marked as asked (null) at once, so a re-render while the answer is in flight does not ask again.
      setKinds((prev) => (d in prev ? prev : { ...prev, [d]: null }));
      void dayKindAction(d).then((k) => setKinds((prev) => ({ ...prev, [d]: k })));
    }
  }, [aDatesKey, dayKindAction, kinds]);

  // r336 — the same one-fetch-per-date arrangement for Section B's four facts.
  const [days, setDays] = useState<Record<string, ExtendedHoursDayView | null>>({});
  const bDatesKey = bRows.map((r) => r.workedDate).join('|');
  useEffect(() => {
    if (!extendedHoursAction) return;
    for (const d of new Set(bDatesKey.split('|').filter(Boolean))) {
      if (d in days) continue;
      setDays((prev) => (d in prev ? prev : { ...prev, [d]: null }));
      void extendedHoursAction(d).then((v) => setDays((prev) => ({ ...prev, [d]: v })));
    }
  }, [bDatesKey, extendedHoursAction, days]);

  const kindLabel = (k: DayKind) =>
    k === 'rest_day' ? t('dayKind.restDay') : k === 'off_day' ? t('dayKind.offDay') : k === 'holiday' ? t('dayKind.holiday') : t('dayKind.workday');

  const addA = () => setARows((r) => [...r, { key: (r[r.length - 1]?.key ?? 0) + 1, workedDate: '', days: '1' }]);
  const addB = () => setBRows((r) => [...r, { key: (r[r.length - 1]?.key ?? 0) + 1, workedDate: '', start: '', end: '' }]);
  // Never remove the last row of a section: an empty table has no "add" affordance attached to anything and
  // reads as a broken form. The server refuses a request with no dates anyway.
  const removeA = (key: number) => setARows((r) => (r.length <= 1 ? r : r.filter((x) => x.key !== key)));
  const removeB = (key: number) => setBRows((r) => (r.length <= 1 ? r : r.filter((x) => x.key !== key)));
  const patchA = (key: number, field: keyof ARow, value: string) =>
    setARows((r) => r.map((x) => (x.key === key ? { ...x, [field]: value } : x)));
  const patchB = (key: number, field: keyof BRow, value: string) =>
    setBRows((r) => r.map((x) => (x.key === key ? { ...x, [field]: value } : x)));

  /**
   * r336 — one Section B row's derived figures, through the SAME two functions the service runs. A row
   * whose date has not answered yet, or whose window is not typed, contributes nothing and prints nothing
   * rather than a misleading zero.
   */
  const deriveB = useCallback(
    (r: BRow): { view: ExtendedHoursDayView | null; minutes: number; credit: number } => {
      const view = r.workedDate ? (days[r.workedDate] ?? null) : null;
      if (!view || !extendedHoursTiers || !r.start || !r.end) return { view, minutes: 0, credit: 0 };
      const minutes = eligibleExtendedMinutes({
        claimStart: r.start,
        claimEnd: r.end,
        shiftEnd: view.shiftEnd,
        actualClockOut: view.actualClockOut,
        measuredExtendedMinutes: view.measuredExtendedMinutes,
      });
      const { countedMinutes, days: credit } = extendedHoursCreditDays(minutes, extendedHoursTiers);
      return { view, minutes: countedMinutes, credit };
    },
    [days, extendedHoursTiers],
  );

  const bDerived = useMemo(() => new Map(bRows.map((r) => [r.key, deriveB(r)])), [bRows, deriveB]);

  // ── The three totals, and each one is the sum of figures the employee can actually see ────────────────
  const totalA = useMemo(
    () => round2(aRows.reduce((s, r) => s + (r.workedDate ? Number(r.days) : 0), 0)),
    [aRows],
  );
  const totalB = useMemo(() => round2([...bDerived.values()].reduce((s, v) => s + v.credit, 0)), [bDerived]);
  const grandTotal = round2(totalA + totalB);

  /**
   * r336 — WHAT STOPS THE SUBMIT, listed once so the button and the messages cannot disagree.
   *
   * Every one of these is refused server-side as well (core/replacement-request.ts, and again at approval),
   * so this is the courtesy half. It exists because the alternative is an employee filling in five rows and
   * being told after the round trip that the second one was a working day.
   */
  const aWorkingDayRows = aRows.filter((r) => r.workedDate && kinds[r.workedDate] === 'workday');
  const bNonWorkingRows = bRows.filter((r) => r.workedDate && days[r.workedDate] && days[r.workedDate]!.kind !== 'workday');
  const bBelowThresholdRows = bRows.filter((r) => {
    const d = bDerived.get(r.key);
    return r.workedDate && r.start && r.end && d?.view != null && d.credit === 0;
  });
  const blocked =
    grandTotal <= 0 || aWorkingDayRows.length > 0 || bNonWorkingRows.length > 0 || bBelowThresholdRows.length > 0;

  const belowThresholdText = t('sectionB.belowThreshold', { minutes: extendedHoursTiers?.extendedHalfDayMinutes ?? 240 });

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className={btnPrimary} data-tour="replacement-leave-request">
          <Plus className="size-4" />
          {t('trigger')}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          data-testid="leave-credit-request-dialog"
          className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[95vw] max-w-3xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-xl"
        >
          <Dialog.Title className="text-base font-semibold text-foreground">{t('title')}</Dialog.Title>
          <Dialog.Description className="mt-0.5 text-xs text-muted-foreground" data-testid="leave-credit-helper">
            {t('description')}
          </Dialog.Description>

          <form action={submitAction} onSubmit={() => setOpen(false)} className="mt-4 space-y-4">
            {/* r336 — the unit is DERIVED and posted as a constant. See the header: both sections credit in
                days, so there is nothing left for an Hour request to mean, and the service refuses one. */}
            <input type="hidden" name="unit" value="day" />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('leaveType')}>
                {/* 2a237f5f — FIXED ON PURPOSE: a Leave Credit is always Replacement Leave. The resolved id
                    is posted in the hidden input because `replacement_leave_request` carries a
                    `leave_type_id` and the rows already in production carry the replacement type there. The
                    visible box is `disabled`, so the BROWSER never submits it — which is why the value
                    travels in its own hidden field. */}
                <input type="hidden" name="leaveTypeId" value={replacementType.id} />
                <input
                  value={replacementType.name}
                  readOnly
                  disabled
                  data-testid="replacement-request-leave-type"
                  className={`${inputCls} bg-muted`}
                />
              </Field>
              <Field label={t('unit')}>
                {/* r336 — read-only for the reason the leave type above is: the answer is derived, so
                    offering a choice would be offering one the engine discards. r333's precedent. */}
                <input
                  value={t('unitDay')}
                  readOnly
                  disabled
                  data-testid="replacement-request-unit"
                  className={`${inputCls} bg-muted`}
                />
              </Field>
            </div>

            {/* ── SECTION A — non-working-day work ───────────────────────────────────────────────────── */}
            <section className="rounded-lg border border-border" data-testid="leave-credit-section-a">
              <div className="border-b border-border px-3 py-2">
                <div className="text-xs font-semibold text-foreground">{t('sectionA.title')}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{t('sectionA.help')}</div>
              </div>
              <div className="space-y-2 p-3">
                {aRows.map((r) => (
                  <div key={r.key} className="flex flex-wrap items-end gap-2">
                    <div className="min-w-[10rem] flex-1">
                      <label className="mb-1 block text-[11px] text-muted-foreground">{t('workedDate')}</label>
                      <input
                        type="date"
                        name="aWorkedDate"
                        max={today}
                        value={r.workedDate}
                        onChange={(e) => patchA(r.key, 'workedDate', e.target.value)}
                        className={inputCls}
                      />
                    </div>
                    <div className="min-w-[8rem]">
                      <label className="mb-1 block text-[11px] text-muted-foreground">{t('sectionA.dayType')}</label>
                      {/* READ-ONLY, from the roster. Never an input: the kind of day a date is is not the
                          employee's to assert, and the service re-resolves it at submit and at approval. */}
                      <div
                        className={`${inputCls} flex items-center bg-muted text-xs`}
                        data-testid="leave-credit-day-kind"
                      >
                        {r.workedDate && kinds[r.workedDate] ? kindLabel(kinds[r.workedDate] as DayKind) : '—'}
                      </div>
                    </div>
                    <div className="min-w-[6rem]">
                      <label className="mb-1 block text-[11px] text-muted-foreground">{t('days')}</label>
                      {/* 1 or 0.5 — the only two answers a non-working day has, so a free number field would
                          be offering arithmetic nobody wants. Enforced again in the service for tagged rows. */}
                      <select
                        name="aDays"
                        value={r.days}
                        onChange={(e) => patchA(r.key, 'days', e.target.value as '1' | '0.5')}
                        aria-label={t('days')}
                        className={inputCls}
                      >
                        <option value="1">{t('sectionA.fullDay')}</option>
                        <option value="0.5">{t('sectionA.halfDay')}</option>
                      </select>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => removeA(r.key)}
                      disabled={aRows.length <= 1}
                      aria-label={t('removeRow')}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                    {r.workedDate && kinds[r.workedDate] === 'workday' && (
                      <p className="w-full text-[11px] font-medium text-destructive" data-testid="leave-credit-section-a-refusal">
                        {t('sectionA.workingDayRefused')}
                      </p>
                    )}
                  </div>
                ))}
                <Button type="button" size="sm" variant="secondary" onClick={addA}>
                  {t('addRow')}
                </Button>
              </div>
              <div className="flex items-center justify-between border-t border-border px-3 py-2 text-sm">
                <span className="text-muted-foreground">{t('sectionA.total')}</span>
                <span className="font-semibold tabular-nums text-foreground" data-testid="leave-credit-total-a">
                  {t('totalDays', { days: totalA })}
                </span>
              </div>
            </section>

            {/* ── SECTION B — extended ordinary-day work ─────────────────────────────────────────────── */}
            {sectionBOffered && (
              <section className="rounded-lg border border-border" data-testid="leave-credit-section-b">
                <div className="border-b border-border px-3 py-2">
                  <div className="text-xs font-semibold text-foreground">{t('sectionB.title')}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{t('sectionB.help')}</div>
                </div>
                <div className="space-y-3 p-3">
                  {bRows.map((r) => {
                    const d = bDerived.get(r.key);
                    const view = d?.view ?? null;
                    const nonWorking = view != null && view.kind !== 'workday';
                    const below = !!(r.workedDate && r.start && r.end && view != null && d!.credit === 0);
                    return (
                      <div key={r.key} className="rounded-md border border-border/60 p-2">
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="min-w-[9rem] flex-1">
                            <label className="mb-1 block text-[11px] text-muted-foreground">{t('workedDate')}</label>
                            <input
                              type="date"
                              name="bWorkedDate"
                              max={today}
                              value={r.workedDate}
                              onChange={(e) => patchB(r.key, 'workedDate', e.target.value)}
                              className={inputCls}
                            />
                          </div>
                          <div className="min-w-[6.5rem]">
                            <label className="mb-1 block text-[11px] text-muted-foreground">{t('sectionB.shiftEnd')}</label>
                            <div className={`${inputCls} flex items-center bg-muted text-xs`} data-testid="leave-credit-shift-end">
                              {hhmm(view?.shiftEnd ?? null) ?? '—'}
                            </div>
                          </div>
                          <div className="min-w-[6.5rem]">
                            <label className="mb-1 block text-[11px] text-muted-foreground">{t('sectionB.actualClockOut')}</label>
                            <div className={`${inputCls} flex items-center bg-muted text-xs`} data-testid="leave-credit-clock-out">
                              {hhmm(view?.actualClockOut ?? null) ?? '—'}
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => removeB(r.key)}
                            disabled={bRows.length <= 1}
                            aria-label={t('removeRow')}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                        <div className="mt-2 flex flex-wrap items-end gap-2">
                          <div className="min-w-[6.5rem]">
                            <label className="mb-1 block text-[11px] text-muted-foreground">{t('sectionB.extendedStart')}</label>
                            <input
                              type="time"
                              name="bStart"
                              value={r.start}
                              onChange={(e) => patchB(r.key, 'start', e.target.value)}
                              className={inputCls}
                            />
                          </div>
                          <div className="min-w-[6.5rem]">
                            <label className="mb-1 block text-[11px] text-muted-foreground">{t('sectionB.extendedEnd')}</label>
                            <input
                              type="time"
                              name="bEnd"
                              value={r.end}
                              onChange={(e) => patchB(r.key, 'end', e.target.value)}
                              className={inputCls}
                            />
                          </div>
                          <div className="min-w-[7rem]">
                            <label className="mb-1 block text-[11px] text-muted-foreground">{t('sectionB.eligibleMinutes')}</label>
                            <div
                              className={`${inputCls} flex items-center bg-muted text-xs tabular-nums`}
                              data-testid="leave-credit-eligible-minutes"
                            >
                              {r.start && r.end && view ? d!.minutes : '—'}
                            </div>
                          </div>
                          <div className="min-w-[6rem]">
                            <label className="mb-1 block text-[11px] text-muted-foreground">{t('sectionB.credit')}</label>
                            <div className={`${inputCls} flex items-center bg-muted text-xs tabular-nums`} data-testid="leave-credit-row-credit">
                              {r.start && r.end && view ? t('totalDays', { days: d!.credit }) : '—'}
                            </div>
                          </div>
                        </div>
                        {nonWorking && (
                          <p className="mt-1 text-[11px] font-medium text-destructive" data-testid="leave-credit-section-b-refusal">
                            {t('sectionB.nonWorkingDayRefused')}
                          </p>
                        )}
                        {!nonWorking && below && (
                          <p className="mt-1 text-[11px] font-medium text-destructive" data-testid="leave-credit-below-threshold">
                            {belowThresholdText}
                          </p>
                        )}
                      </div>
                    );
                  })}
                  <Button type="button" size="sm" variant="secondary" onClick={addB}>
                    {t('addRow')}
                  </Button>
                </div>
                <div className="flex items-center justify-between border-t border-border px-3 py-2 text-sm">
                  <span className="text-muted-foreground">{t('sectionB.total')}</span>
                  <span className="font-semibold tabular-nums text-foreground" data-testid="leave-credit-total-b">
                    {t('totalDays', { days: totalB })}
                  </span>
                </div>
              </section>
            )}

            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
              <span className="font-medium text-foreground">{t('grandTotal')}</span>
              <span className="font-semibold tabular-nums text-foreground" data-testid="leave-credit-grand-total">
                {t('totalDays', { days: grandTotal })}
              </span>
            </div>

            <Field label={t('reason')}>
              <input name="reason" className={inputCls} />
            </Field>

            {/* The statutory-floor agreement. Rendered only when the server says this employee is within
                the First Schedule and their company allows banking — and enforced server-side regardless,
                so removing this checkbox in the browser refuses the submission rather than skipping it. */}
            {requiresFirstScheduleConsent && (
              <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-950/40">
                <input type="checkbox" name="firstScheduleConsent" required className="mt-0.5 h-4 w-4" />
                <span className="text-foreground">{t('firstScheduleConsent')}</span>
              </label>
            )}

            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button type="button" variant="secondary">
                  {t('cancel')}
                </Button>
              </Dialog.Close>
              <button className={btnPrimary} disabled={blocked} data-testid="leave-credit-submit">
                {t('submit')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
