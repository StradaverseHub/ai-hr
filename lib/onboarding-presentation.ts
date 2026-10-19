import { currentReq, dayDate, effectiveFacts, progress, validDate, type Case, type Config, type Task } from './onboarding-model';

type NextStep={name:string;due:string;detail:string;assignee?:string|null;by?:Task['by'];group?:string|null};

/** Presentation derives from the authoritative case; it never creates work or changes state. */
export function onboardingNextStep(config: Config, c: Case):NextStep {
  const f = effectiveFacts(c);
  if (c.state === 'cancelled') return { name: 'No further action', due: '', detail: 'Reopen the case to restart onboarding' };
  if (c.state === 'pending') return { name: 'Submit the onboarding case', due: validDate(f.joinDate) ? dayDate(f.joinDate, -7) : '', detail: 'Complete the case details and confirm a checklist' };
  const left:NextStep[] = c.tasks.filter(t => t.status !== 'done').map(t => ({ name: t.name, due: t.dueOn, assignee:t.assignee, by:t.by, group:t.group, detail: t.failure || (t.gate && !currentReq(c)?.handedAt ? 'After IT requisition' : '') }));
  const r = currentReq(c);
  if (config.countEquipment && r && !r.handedAt) left.push({ name: 'Equipment and access ready for Day 1', due: f.joinDate, detail: 'Group Tech · handover pending' });
  return left.sort((a,b) => (a.due || '9999').localeCompare(b.due || '9999'))[0] ?? { name: 'All done', due: '', detail: 'Checklist and counted equipment complete' };
}

export function onboardingDate(value: string, locale = 'en') {
  if (!validDate(value)) return 'Date needed';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value + 'T00:00:00Z'));
}

export function onboardingRelative(value: string, today: string, locale = 'en') {
  if (!validDate(value) || !validDate(today)) return '';
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round((Date.parse(value) - Date.parse(today)) / 86400000), 'day');
}

export function onboardingBreakdown(config: Config, c: Case) {
  const p = progress(config, c);
  return { ...p, next: onboardingNextStep(config, c), ticket: currentReq(c)?.number ?? 'Created on submission' };
}
