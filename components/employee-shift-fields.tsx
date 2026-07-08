'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';

type ShiftOption = { id: string; label: string };

/**
 * R17 3e8350db — the employee-profile "Shift Type" control (the reporter's explicit ask). A client island
 * because a React Server Component cannot own the onChange that shows/hides the Default-shift picker:
 *   • Fixed  → the Default-shift select is shown and REQUIRED (the person follows it every working day).
 *   • Roster → the Default-shift select is hidden; the person is scheduled purely from /roster.
 * Posts `shiftType` + (for Fixed) `shiftId`; the server action (assignEmployeeShift) re-enforces the
 * invariant so the two can never contradict even if this UI is bypassed.
 */
export function EmployeeShiftFields({
  defaultType,
  defaultShiftId,
  shifts,
}: {
  defaultType: 'fixed' | 'roster';
  defaultShiftId: string | null;
  shifts: ShiftOption[];
}) {
  const t = useTranslations('people.detail');
  const [type, setType] = useState<'fixed' | 'roster'>(defaultType);

  return (
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
      {type === 'fixed' && (
        <Field label={t('defaultShiftLabel')}>
          <select name="shiftId" required defaultValue={defaultShiftId ?? ''} className={inputCls}>
            <option value="">{t('defaultShiftChoose')}</option>
            {shifts.map((sh) => (
              <option key={sh.id} value={sh.id}>
                {sh.label}
              </option>
            ))}
          </select>
        </Field>
      )}
    </div>
  );
}
