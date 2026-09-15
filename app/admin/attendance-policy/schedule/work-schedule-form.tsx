import { getTranslations } from 'next-intl/server';
import type { AttendancePolicyView } from '@/core/attendance';
import { Card, Field, btnPrimary, inputCls } from '@/components/ui';
import { setAttendancePolicyAction } from '../../actions';

const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DAY_KEY: Record<number, string> = {
  1: 'dayMon',
  2: 'dayTue',
  3: 'dayWed',
  4: 'dayThu',
  5: 'dayFri',
  6: 'daySat',
  7: 'daySun',
};
const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const hm = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;

/**
 * ONE company work-schedule editor, rendered from TWO places (feedback e4471e3c, r287).
 *
 * ── WHY IT LIVES HERE AND NOT IN components/ ───────────────────────────────────────────────────────
 * It is PACK UI, not a generic control: it renders `attendance_policy`, which the attendance pack owns
 * (ADR-0080 D9). A file under `components/` importing `core/attendance` is a NEW direct consumer of the
 * pack's implementation and fails the drift ratchet — correctly, and that allowlist only ever shrinks. So
 * the form sits inside the pack's own route surface, beside the screen that has always owned it, and the
 * Schedule tab imports it from here.
 *
 * ── WHY IT IS A SHARED COMPONENT AND NOT A SECOND FORM ──────────────────────────────────────────────
 * The reporter asked for the Work Schedule sub-menu to be consolidated into Attendance › Schedule, so the
 * working week has to be editable on the Schedule screen's General tab. The obvious way to do that is to
 * draw a form on the tab with the fields the tab already displays — and it is the wrong way, twice over:
 *
 *   1. `setAttendancePolicyAction` is a FULL-ROW writer. It reads every field of `attendance_policy` off
 *      the submission, so a partial form would save `lateAfter`, `halfDayBefore`, the overtime-approval
 *      method and the registered-device switch at whatever `String(fd.get(...) ?? '')` yields for a field
 *      the browser never sent — i.e. it would quietly wipe four settings the tab does not even show.
 *   2. Two forms over one table drift. The old screen's disjoint Full/Half/Rest decoding, its time inputs
 *      and its `dayType_<d>` naming contract with the action are exactly the kind of thing a copy
 *      re-implements and then re-implements differently.
 *
 * So the editor MOVED into this component and both screens render it. A save from the Schedule tab and a
 * save from /admin/attendance-policy/schedule post the SAME field names to the SAME action, which is the
 * strongest available form of "the new tab produces the same stored row as the old screen": they are not
 * two writers that agree, they are one writer.
 *
 * ── `returnTo` IS READ AS A VALUE AGAINST A CLOSED LIST, NEVER AS A URL ────────────────────────────
 * The only thing that differs between the two mounts is where a save lands. That rides a hidden field, and
 * a hidden field is ALWAYS submitted — so the action resolves it against a two-entry allow-list rather
 * than redirecting to whatever arrived (CLAUDE.md §8: a field that is always submitted cannot be read by
 * presence; and an unchecked redirect target is an open redirect). See setAttendancePolicyAction.
 */
export async function WorkScheduleForm({
  company,
  policy,
  returnTo,
}: {
  company: { id: string; name: string };
  policy: AttendancePolicyView;
  /** Which screen this mount is on. Resolved server-side against a closed list; never a free URL. */
  returnTo: 'schedule-tab' | 'work-schedule';
}) {
  const t = await getTranslations('admin.attendancePolicy');
  const net = Math.max(0, toMin(policy.workEnd) - toMin(policy.workStart) - policy.breakMinutes);

  return (
    <Card id={`policy-${company.id}`} className="scroll-mt-6">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{company.name}</h2>
        {policy.isDefault ? (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
            {t('usingDefaults')}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{t('netScheduled', { hours: hm(net) })}</span>
        )}
      </div>
      <form action={setAttendancePolicyAction} className="space-y-4 p-4">
        <input type="hidden" name="companyId" value={company.id} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label={t('workStart')}>
            <input type="time" name="workStart" required defaultValue={policy.workStart.slice(0, 5)} className={inputCls} />
          </Field>
          <Field label={t('workEnd')}>
            <input type="time" name="workEnd" required defaultValue={policy.workEnd.slice(0, 5)} className={inputCls} />
          </Field>
          <Field label={t('breakMinutes')}>
            <input type="number" name="breakMinutes" min={0} max={480} required defaultValue={policy.breakMinutes} className={inputCls} />
          </Field>
          <Field label={t('lateAfter')}>
            <input type="time" name="lateAfter" required defaultValue={policy.lateAfter.slice(0, 5)} className={inputCls} />
          </Field>
          <Field label={t('halfDayBefore')}>
            <input type="time" name="halfDayBefore" required defaultValue={policy.halfDayBefore.slice(0, 5)} className={inputCls} />
          </Field>
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-foreground">{t('workingDays')}</legend>
          <p className="mb-2 text-xs text-muted-foreground">{t('dayTypeHint')}</p>
          <div className="flex flex-wrap gap-1.5">
            {ISO_DAYS.map((d) => {
              const dayType: 'full' | 'half' | 'rest' = policy.workingDays.includes(d)
                ? 'full'
                : policy.halfWorkingDays.includes(d)
                  ? 'half'
                  : 'rest';
              return (
                <div key={d} className="flex flex-col items-center gap-1 rounded-lg border border-border px-2 py-1.5">
                  <span className="text-xs font-medium text-foreground">{t(DAY_KEY[d])}</span>
                  {/* One <select> per weekday posts "full" | "half" | "rest" — decoded server-side in
                      setAttendancePolicyAction into the two ISO-weekday arrays the service expects. */}
                  <select
                    name={`dayType_${d}`}
                    defaultValue={dayType}
                    className="rounded border border-border bg-transparent px-1 py-0.5 text-xs"
                  >
                    <option value="full">{t('dayTypeFull')}</option>
                    <option value="half">{t('dayTypeHalf')}</option>
                    <option value="rest">{t('dayTypeRest')}</option>
                  </select>
                </div>
              );
            })}
          </div>
        </fieldset>

        {/* ADR-0069: how an approved overtime request's minutes are resolved against the engine's figure. */}
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-foreground">{t('otApprovalCalc')}</legend>
          <Field label={t('otApprovalCalcLabel')}>
            <select name="otApprovalCalculation" defaultValue={policy.otApprovalCalculation} className={inputCls}>
              <option value="requested">{t('otApprovalRequested')}</option>
              <option value="system_calculated">{t('otApprovalSystem')}</option>
              <option value="smaller_of">{t('otApprovalSmaller')}</option>
              <option value="greater_of">{t('otApprovalGreater')}</option>
            </select>
          </Field>
          <p className="mt-1.5 text-xs text-muted-foreground">{t('otApprovalCalcHint')}</p>
        </fieldset>

        {/* Feedback 5249d43f: registered-device enforcement. Ships OFF so nobody is locked out;
            flip ON per company once its teams have registered their devices. */}
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-foreground">{t('requireDeviceLegend')}</legend>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              name="requireRegisteredDevice"
              defaultChecked={policy.requireRegisteredDevice}
              className="size-4 accent-primary"
            />
            {t('requireDeviceLabel')}
          </label>
          <p className="mt-1.5 text-xs text-muted-foreground">{t('requireDeviceHint')}</p>
        </fieldset>

        <div className="flex items-center gap-3">
          <button className={btnPrimary}>{t('save')}</button>
          <span className="text-xs text-muted-foreground">{t('lateHint')}</span>
        </div>
      </form>
    </Card>
  );
}
