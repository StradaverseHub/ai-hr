import { isCalendarDate } from './calendar-date';
import { HomeError } from './home-model';
export function shiftHomeDate(date: string, days: number) { if (!isCalendarDate(date) || !Number.isInteger(days) || Math.abs(days) > 62)
    throw new HomeError('invalid'); const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); const value = d.toISOString().slice(0, 10); if (!isCalendarDate(value))
    throw new HomeError('invalid'); return value; }
export function homeCalendarWindow(anchor: string, view: 'month' | 'week' | 'list', weekStartsOn: 0 | 1) {
    if (!isCalendarDate(anchor) || ![0, 1].includes(weekStartsOn))
        throw new HomeError('invalid');
    const base = view === 'week' ? anchor : anchor.slice(0, 7) + '-01', weekday = new Date(base + 'T12:00:00Z').getUTCDay(), from = shiftHomeDate(base, -((weekday - weekStartsOn + 7) % 7));
    return { from, to: shiftHomeDate(from, view === 'week' ? 6 : 41) };
}
