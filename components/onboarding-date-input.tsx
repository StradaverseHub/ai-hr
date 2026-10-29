'use client';
import { useOnboardingCopy } from '@/lib/onboarding-copy';
import { useState } from 'react';
import { inputCls } from '@/components/ui';
import { validDate } from '@/lib/onboarding-model';
export function OnboardingDateInput({ value, onChange, label, disabled = false }: {
    disabled?: boolean;
    value: string;
    onChange: (value: string) => void;
    label: string;
}) {
    const copy = useOnboardingCopy();
    const [touched, setTouched] = useState(false);
    const display = validDate(value) ? value.split('-').reverse().join('/') : value;
    const valid = !value || validDate(value);
    return <><input disabled={disabled} aria-label={label} inputMode="numeric" autoComplete="off" maxLength={10} placeholder={copy("DD/MM/YYYY")} className={inputCls} value={display} aria-invalid={touched && !valid} onBlur={() => setTouched(true)} onChange={e => {
            const digits = e.target.value.replace(/\D/g, '').slice(0, 8);
            const masked = digits.slice(0, 2) + (digits.length > 2 ? '/' + digits.slice(2, 4) : '') + (digits.length > 4 ? '/' + digits.slice(4) : '');
            const parts = masked.split('/'), iso = parts.length === 3 && parts[2]?.length === 4 ? parts[2] + '-' + parts[1] + '-' + parts[0] : '';
            onChange(iso && validDate(iso) ? iso : masked);
        }}/>{touched && !valid && <span role="alert" className="text-xs text-destructive">{copy("Enter a valid date as DD/MM/YYYY.")}</span>}</>;
}
