import { expect, it } from 'vitest';
import { lifecycleCalendar, lifecycleTaskLocked } from '../lib/lifecycle-v9-calendar';
import type { LifecycleV9OwnCase } from '../packs/lifecycle/service';
function fixture(): LifecycleV9OwnCase {
  return { id: 'exit', module: 'off', state: 'submitted', own: true, facts: { name: 'Fictional employee', lastDay: '2026-11-04' }, tasks: [
    { id: 'open', name: 'Future form', status: 'todo', opensOn: '2026-11-02', dueOn: '2026-11-04' },
    { id: 'late', name: 'Return equipment', status: 'progress', opensOn: null, dueOn: '2026-10-29' },
    { id: 'done', name: 'Done task', status: 'done', opensOn: null, dueOn: '2026-10-30' },
    { id: 'waived', name: 'Waived task', status: 'notNeeded', opensOn: null, dueOn: '2026-10-30' },
    { id: 'boundary', name: '45 day boundary', status: 'todo', opensOn: null, dueOn: '2026-12-14' },
    { id: 'outside', name: 'Too far ahead', status: 'todo', opensOn: null, dueOn: '2026-12-15' },
    { id: 'bad', name: 'Invalid date', status: 'todo', opensOn: null, dueOn: '2026-11-31' },
  ] } as unknown as LifecycleV9OwnCase;
}
it('builds a Monday–Sunday week and the next 45 days from actual open tasks', () => {
  const c = fixture(), before = structuredClone(c), calendar = lifecycleCalendar([c], '2026-10-30');
  expect(calendar.days.map(day => day.date)).toEqual(['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01']);
  expect(calendar.days.filter(day => day.today).map(day => day.date)).toEqual(['2026-10-30']);
  expect(calendar.days[3].events).toEqual([expect.objectContaining({ text: 'Due: Return equipment', kind: 'late' })]);
  expect(calendar.upcoming.map(event => [event.date, event.text])).toEqual([['2026-11-02','Opens: Future form'],['2026-11-04','Your last day'],['2026-12-14','Due: 45 day boundary']]);
  expect(c).toEqual(before);
});
it('labels another person’s assigned work and omits cancelled or cleared work', () => {
  const c = fixture(); c.own = false;
  expect(lifecycleCalendar([c], '2026-10-30').upcoming.map(event => event.text)).toEqual(['Opens: Future form · Fictional employee','Due: 45 day boundary · Fictional employee']);
  c.state = 'cleared'; expect(lifecycleCalendar([c], '2026-10-30').upcoming).toEqual([]);
  c.state = 'cancelled'; expect(lifecycleCalendar([c], '2026-10-30').days.flatMap(day => day.events)).toEqual([]);
});
it('opens tasks on the HR calendar day, handles a year boundary, and rejects an invalid clock', () => {
  expect(lifecycleTaskLocked({ opensOn: '2026-11-02', status: 'todo' }, '2026-11-01')).toBe(true);
  expect(lifecycleTaskLocked({ opensOn: '2026-11-02', status: 'todo' }, '2026-11-02')).toBe(false);
  expect(lifecycleCalendar([], '2027-01-01').days.map(day => day.date)).toEqual(['2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02','2027-01-03']);
  expect(() => lifecycleCalendar([], '2026-02-30')).toThrow('valid HR calendar');
});
