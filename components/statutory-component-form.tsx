'use client';

import { useState } from 'react';
import { Button, Field, inputCls } from '@/components/ui';
import { setStatutoryComponentAction } from '@/app/payroll/configuration/actions';

type ScalarBody = 'epf' | 'ot' | 'hrdf';

export type ComponentFormDefaults = {
  epf: { employeeRate: number; employerRateLow: number; employerRateHigh: number; employerThreshold: number };
  ot: { wageCeiling: number; restDayExcessMultiplier: number; holidayExcessMultiplier: number };
  hrdf: { mandatoryRate: number; optionalRate: number };
};

/**
 * Publish a per-body statutory override (ADR-0037, #6). Scalar bodies only — EPF rates, OT ceiling, HRDF
 * rates; the band-table bodies (SOCSO/EIS/PCB) stay pack/whole-ruleset managed. Prefilled with the
 * currently-active figures so the admin tweaks rather than retypes.
 *
 * `lockedBody` pre-locks the form to a single body (per-section Edit control): the body picker is hidden
 * and only that body's fields render. When omitted, the picker is shown (shared bottom-of-page form). The
 * EPF submit path lives in setStatutoryComponentAction, which spread-merges scalar rates onto the active
 * EPF slice so Part A / Part E / non-citizen band data survives — no change to that here.
 */
const ALL_BODIES: ScalarBody[] = ['epf', 'ot', 'hrdf'];

export function StatutoryComponentForm({
  defaults,
  labels,
  lockedBody,
  returnTo,
  bodies = ALL_BODIES,
}: {
  defaults: ComponentFormDefaults;
  labels: Record<string, string>;
  lockedBody?: ScalarBody;
  /** Optional same-origin app path the action redirects/revalidates back to after saving. Defaults to
   *  /payroll/configuration in the action. The Attendance Policy screen passes /admin/attendance so the
   *  relocated OT-rates form returns the admin to Attendance instead of Payroll (feedback e776d17d). */
  returnTo?: string;
  /** Which bodies the picker offers when not locked. The statutory page passes ['epf','hrdf'] so overtime
   *  is no longer configurable under Payroll statutory settings (feedback e776d17d); the OT editor lives on
   *  the Attendance Policy screen via lockedBody="ot". */
  bodies?: ScalarBody[];
}) {
  const [body, setBody] = useState<ScalarBody>(lockedBody ?? bodies[0] ?? 'epf');
  const num = 'number';
  const bodyLabel: Record<ScalarBody, string | undefined> = {
    epf: labels.body_epf,
    ot: labels.body_ot,
    hrdf: labels.body_hrdf,
  };
  return (
    <form action={setStatutoryComponentAction} className="mt-3 grid gap-3 md:grid-cols-2">
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      {lockedBody ? (
        <input type="hidden" name="body" value={lockedBody} />
      ) : (
        <Field label={labels.body}>
          <select name="body" value={body} onChange={(e) => setBody(e.target.value as ScalarBody)} className={inputCls}>
            {bodies.map((b) => (
              <option key={b} value={b}>
                {bodyLabel[b]}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={labels.effectiveFrom}>
        <input type="date" name="effectiveFrom" required className={inputCls} />
      </Field>
      <Field label={labels.version}>
        <input name="version" required placeholder="e.g. socso-2026.06" className={inputCls} />
      </Field>
      <Field label={labels.notes}>
        <input name="notes" className={inputCls} />
      </Field>

      {body === 'epf' && (
        <>
          <Field label={labels.epfEmployeeRate}>
            <input name="employeeRate" type={num} step="0.0001" defaultValue={defaults.epf.employeeRate} className={inputCls} />
          </Field>
          <Field label={labels.epfEmployerRateLow}>
            <input name="employerRateLow" type={num} step="0.0001" defaultValue={defaults.epf.employerRateLow} className={inputCls} />
          </Field>
          <Field label={labels.epfEmployerRateHigh}>
            <input name="employerRateHigh" type={num} step="0.0001" defaultValue={defaults.epf.employerRateHigh} className={inputCls} />
          </Field>
          <Field label={labels.epfEmployerThreshold}>
            <input name="employerThreshold" type={num} step="1" defaultValue={defaults.epf.employerThreshold} className={inputCls} />
          </Field>
        </>
      )}
      {body === 'ot' && (
        <>
          <Field label={labels.otWageCeiling}>
            <input name="wageCeiling" type={num} step="1" defaultValue={defaults.ot.wageCeiling} className={inputCls} />
          </Field>
          <Field label={labels.otRestDayExcessMultiplier}>
            <input
              name="restDayExcessMultiplier"
              type={num}
              step="0.1"
              min="0.1"
              defaultValue={defaults.ot.restDayExcessMultiplier}
              className={inputCls}
            />
          </Field>
          <Field label={labels.otHolidayExcessMultiplier}>
            <input
              name="holidayExcessMultiplier"
              type={num}
              step="0.1"
              min="0.1"
              defaultValue={defaults.ot.holidayExcessMultiplier}
              className={inputCls}
            />
          </Field>
        </>
      )}
      {body === 'hrdf' && (
        <>
          <Field label={labels.hrdfMandatory}>
            <input name="mandatoryRate" type={num} step="0.0001" defaultValue={defaults.hrdf.mandatoryRate} className={inputCls} />
          </Field>
          <Field label={labels.hrdfOptional}>
            <input name="optionalRate" type={num} step="0.0001" defaultValue={defaults.hrdf.optionalRate} className={inputCls} />
          </Field>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 md:col-span-2">
        <Button type="submit" size="sm">
          {labels.publish}
        </Button>
        {lockedBody && labels.cancelHref && (
          <a href={labels.cancelHref}>
            <Button type="button" variant="outline" size="sm">
              {labels.cancelEdit ?? labels.cancel}
            </Button>
          </a>
        )}
      </div>
    </form>
  );
}
