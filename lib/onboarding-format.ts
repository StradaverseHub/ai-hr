import { todayInKualaLumpur, timeInKualaLumpur } from './hr-date';
/** Audit instants use the product calendar, independently of a viewer's machine timezone. */
export function onboardingTimestamp(value: string | Date): string {
    const instant = value instanceof Date ? value : new Date(value);
    return Number.isNaN(instant.getTime()) ? '—' : todayInKualaLumpur(instant).split('-').reverse().join('/') + ' ' + timeInKualaLumpur(instant);
}
