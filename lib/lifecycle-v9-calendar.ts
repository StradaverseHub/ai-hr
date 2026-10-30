import { isCalendarDate } from './calendar-date';
import type { Case, Task } from './lifecycle-v9-model';
type CalendarCase = Pick<Case, 'id' | 'module' | 'state' | 'facts' | 'tasks'> & { own: boolean };
export type LifecycleCalendarEvent = { id: string; caseId: string; date: string; text: string; kind: 'task' | 'late' | 'key' };
const DAY = 86400000;
const ms = (date: string) => Date.parse(date + 'T00:00:00Z');
const iso = (value: number) => new Date(value).toISOString().slice(0, 10);
export function lifecycleTaskLocked(task: Pick<Task, 'opensOn' | 'status'>, today: string): boolean {
  return task.status !== 'done' && task.status !== 'notNeeded' && !!task.opensOn && isCalendarDate(task.opensOn) && task.opensOn > today;
}
/** Calendar dates come only from the already-authorized work projection. No sample meetings are invented. */
export function lifecycleCalendar(cases: CalendarCase[], today: string) {
  if (!isCalendarDate(today)) throw Error('A valid HR calendar date is required.');
  const now = ms(today), weekday = new Date(now).getUTCDay(), weekStart = now - ((weekday + 6) % 7) * DAY;
  const events: LifecycleCalendarEvent[] = [];
  for (const c of cases) {
    if (c.state !== 'submitted') continue;
    for (const task of c.tasks) {
      if (['done', 'notNeeded'].includes(task.status)) continue;
      const locked = lifecycleTaskLocked(task, today), date = locked ? task.opensOn! : task.dueOn;
      if (!isCalendarDate(date)) continue;
      events.push({ id: `${c.id}:task:${task.id}`, caseId: c.id, date, text: `${locked ? 'Opens' : 'Due'}: ${task.name}${c.own ? '' : ` · ${c.facts.name}`}`, kind: !locked && date < today ? 'late' : 'task' });
    }
    if (c.own && c.module === 'off' && isCalendarDate(c.facts.lastDay)) events.push({ id: `${c.id}:last-day`, caseId: c.id, date: c.facts.lastDay, text: 'Your last day', kind: 'key' });
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return {
    days: Array.from({ length: 7 }, (_, i) => { const date = iso(weekStart + i * DAY); return { date, today: date === today, events: events.filter(event => event.date === date) }; }),
    upcoming: events.filter(event => ms(event.date) > weekStart + 6 * DAY && ms(event.date) - now <= 45 * DAY),
  };
}
