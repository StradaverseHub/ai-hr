'use client';

import { useRef, useState } from 'react';
import { DateField, inputCls } from '@/components/ui';
import { deriveDobFromIcInput, nextAutofilledDob } from '@/components/ic-dob-autofill';
import { PersonnelField } from '@/components/personnel-field';
import { childAgeYears } from '@/lib/dependent-vocabulary';
import { personnelControl, personnelDisplay, personnelInput } from '@/lib/personnel-form-contract';

const dobField = 'family.family_and_dependents.dateofbirth';
const ageField = 'family.family_and_dependents.age';

export function FamilyIdentityDates({
  child,
  initialIc,
  initialDob,
  dobLabel,
  asOf,
}: {
  child: boolean;
  initialIc: string;
  initialDob: string;
  dobLabel: string;
  asOf: Date;
}) {
  const [dob, setDob] = useState(initialDob);
  const lastAutofilled = useRef<string | null>(null);
  const manuallyEdited = useRef(false);
  const icField = child ? 'family.family_and_dependents.icorpassport_8' : 'family.family_and_dependents.icorpassport';

  function updateFromIc(raw: string) {
    if (manuallyEdited.current) return;
    const { dob: derived } = deriveDobFromIcInput(raw);
    const next = nextAutofilledDob(dob, derived ?? '', lastAutofilled.current);
    if (next === null) return;
    lastAutofilled.current = derived;
    setDob(next);
  }

  return (
    <>
      <PersonnelField fieldId={icField}>
        <input
          {...personnelInput(icField)}
          defaultValue={initialIc}
          className={inputCls}
          onChange={(event) => updateFromIc(event.currentTarget.value)}
        />
      </PersonnelField>
      <PersonnelField fieldId={dobField}>
        <DateField
          {...personnelControl(dobField)}
          value={dob}
          className={inputCls}
          label={dobLabel}
          onChange={(event) => {
            manuallyEdited.current = true;
            setDob(event.currentTarget.value);
          }}
        />
      </PersonnelField>
      <PersonnelField fieldId={ageField}>
        <input
          {...personnelDisplay(ageField)}
          readOnly
          value={childAgeYears(dob, asOf) ?? ''}
          className={`${inputCls} bg-muted/50`}
        />
      </PersonnelField>
    </>
  );
}
