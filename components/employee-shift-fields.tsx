'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';

type ShiftOption = { id: string; label: string };

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
}: {
  defaultType: 'fixed' | 'roster';
  defaultShiftId: string | null;
  shifts: ShiftOption[];
  /** Today in the tenant's calendar (todayInKualaLumpur), resolved on the server. */
  defaultEffectiveFrom: string;
}) {
  const t = useTranslations('people.detail');
  const [type, setType] = useState<'fixed' | 'roster'>(defaultType);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('shiftTypeLabel')}>
          <select
            name="shiftType"
            value={type}
            onChange={(e) => setType(e.target.value as 'fixed' | 'roster')}
            className={inputCls}
          >
            <option value="fixed">{t('shiftTypeFixed')}</option>
            <option value="roster">{t('shiftTypeRoster')}</option>
          </select>
        </Field>
        <Field label={t('backupShiftLabel')}>
          <select name="shiftId" required defaultValue={defaultShiftId ?? ''} className={inputCls}>
            <option value="">{t('defaultShiftChoose')}</option>
            {shifts.map((sh) => (
              <option key={sh.id} value={sh.id}>
                {sh.label}
              </option>
            ))}
          </select>
        </Field>
        {/* 18504ca6 — pushed to the end of the row (sm:ml-auto) so it lands where the Location card's own
            Effective date lands, which is the symmetry the reporter photographed. */}
        <Field
          label={t('shiftEffectiveDateLabel')}
          required
          requiredAriaLabel={t('requiredField')}
          className="sm:ml-auto"
        >
          <input
            name="effectiveFrom"
            type="date"
            required
            defaultValue={defaultEffectiveFrom}
            className={inputCls}
          />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">
        {type === 'fixed' ? t('backupShiftHintFixed') : t('backupShiftHintRoster')}{' '}
        {t('shiftEffectiveDateHint')}
      </p>
    </div>
  );
}
