'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from '@/components/ui';
import {PersonnelField} from '@/components/personnel-field';
import {personnelControl,personnelInput,personnelFormLabel} from '@/lib/personnel-form-contract';
import { DateField } from '@/components/ui/date-field';
import {rotationVersionOn} from '@/core/week-pattern';

type ShiftOption = { id: string; label: string; archived?:boolean };
type AllowedPool={baseShiftIds:string[];versions:{effectiveFrom:string;allowedShiftIds:string[]}[]};

/**
 * R17 3e8350db — the employee-profile "Shift Type" control (the reporter's explicit ask). A client island
 * because a React Server Component cannot own the onChange that re-words the Backup-shift hint.
 *
 * b8aa3466 — THE BACKUP SHIFT IS NO LONGER OPTIONAL, AND THAT IS THE WHOLE POINT OF THIS ITEM. R17 hid the
 * picker whenever Shift Type was "Roster", and assignEmployeeShift nulled `default_shift_id` to match — so
 * "Roster" was a way to decline the field, and 30 of the reporter's 31 employments had declined it. A
 * declined backup shift means every unrostered day falls through to the flat company work schedule, which
 * is the calculation gap the reporter reported. The picker is now shown for BOTH arrangements and is
 * `required` with an empty-valued placeholder (an empty value is what makes `required` bite — a "None"
 * OPTION would satisfy it, which is the trap this control must never re-introduce). The server action
 * re-enforces it (BackupShiftRequiredError) so bypassing this UI cannot decline either.
 *
 * Shift Type now says how the person is normally scheduled, not whether they get a shift at all:
 *   • Fixed  → they work the backup shift every working day; the roster records the exceptions.
 *   • Roster → they are scheduled from /roster, and the backup shift covers any day with no roster row.
 *
 * 18504ca6 — THE EFFECTIVE DATE. The Location card directly above this one is effective-dated and this one
 * was not, so saving here replaced the old shift with no date and no history. The date sits on the SAME row
 * as Shift type and Backup shift (matching the Location card) and is `required` with no default of its own:
 * the page passes today's date in the tenant's calendar, exactly as the Location card does.
 */
export function EmployeeShiftFields({
  defaultType,
  defaultShiftId,
  shifts,
  defaultEffectiveFrom,
  dmyDisplay = false,
  allowedPool,
}: {
  defaultType: 'fixed' | 'roster';
  defaultShiftId: string | null;
  shifts: ShiftOption[];
  allowedPool?:AllowedPool;
  /** Today in the tenant's calendar (todayInKualaLumpur), resolved on the server. */
  defaultEffectiveFrom: string;
  /** r422 — OPT-IN: draw the Effective date as DD-MMM-YYYY (components/ui/date-field.tsx), posting the same
   *  ISO value. The Personnel profile passes it; Schedule Assignment does not and is unchanged. */
  dmyDisplay?: boolean;
}) {
  const t = useTranslations('people.detail');
  const label=(id:string)=>personnelFormLabel(id,(key,fallback)=>key.startsWith('people.detail.')?t(key.slice(14)):fallback);
  const [type, setType] = useState<'fixed' | 'roster'>(defaultType);
  const [effectiveFrom,setEffectiveFrom]=useState(defaultEffectiveFrom);
  const [selectedShift,setSelectedShift]=useState(defaultShiftId??'');
  const allowed=allowedPool?new Set(rotationVersionOn(allowedPool.versions,effectiveFrom)?.allowedShiftIds??allowedPool.baseShiftIds):null;
  const options=shifts.filter(sh=>(!sh.archived&&(!allowed||allowed.has(sh.id)))||sh.id===selectedShift);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <PersonnelField fieldId="attendance.work_location_and_shift_arrangement.shifttype">
          <select
            {...personnelControl('attendance.work_location_and_shift_arrangement.shifttype')}
            value={type}
            onChange={(e) => setType(e.target.value as 'fixed' | 'roster')}
            className={inputCls}
          >
            <option value="fixed">{t('shiftTypeFixed')}</option>
            <option value="roster">{t('shiftTypeRoster')}</option>
          </select>
        </PersonnelField>
        <PersonnelField fieldId="attendance.work_location_and_shift_arrangement.backupshiftid">
          <select {...personnelControl('attendance.work_location_and_shift_arrangement.backupshiftid')} value={selectedShift} onChange={e=>setSelectedShift(e.target.value)} className={inputCls}>
            <option value="">{t('defaultShiftChoose')}</option>
            {options.map((sh) => (
              <option key={sh.id} value={sh.id} disabled={!!sh.archived||!!allowed&&!allowed.has(sh.id)}>
                {sh.label}
              </option>
            ))}
          </select>
        </PersonnelField>
        {/* 18504ca6 — pushed to the end of the row (sm:ml-auto) so it lands where the Location card's own
            Effective date lands, which is the symmetry the reporter photographed. */}
        <PersonnelField
          fieldId="attendance.work_location_and_shift_arrangement.shifteffectivefrom"
          requiredAriaLabel={t('requiredField')}
          className="sm:ml-auto"
        >
          {dmyDisplay ? (
            <DateField
              {...personnelControl('attendance.work_location_and_shift_arrangement.shifteffectivefrom')}
              value={effectiveFrom}
              onChange={e=>setEffectiveFrom(e.target.value)}
              className={inputCls}
              label={label('attendance.work_location_and_shift_arrangement.shifteffectivefrom')}
            />
          ) : (
            <input
              {...personnelInput('attendance.work_location_and_shift_arrangement.shifteffectivefrom')}
              value={effectiveFrom}
              onChange={e=>setEffectiveFrom(e.target.value)}
              className={inputCls}
            />
          )}
        </PersonnelField>
      </div>
      <p className="text-xs text-muted-foreground">
        {type === 'fixed' ? t('backupShiftHintFixed') : t('backupShiftHintRoster')}{' '}
        {t('shiftEffectiveDateHint')}
      </p>
    </div>
  );
}
