import { z } from 'zod';
import { isoDateSchema, type RewardRole, type RewardStage } from './model';

/**
 * The reward calendar (migration 0646): when each step of a reward cycle is due, per company. Pure model;
 * the service owns persistence. Every value is optional — no date set means no due date, never a guess.
 * Annual reviews read a fixed date per step; off-cycle requests are due a number of days after they reached
 * their current step (the service level), as in the legacy Reward Desk.
 */
export const rewardCalendarStages = ['bu', 'returned', 'bg', 'gr', 'ctro', 'ec', 'payroll'] as const;
export type RewardCalendarStage = typeof rewardCalendarStages[number];
export const rewardOffcycleSlaStages = ['bg', 'gr', 'ctro', 'ec', 'returned'] as const;
export type RewardOffcycleSlaStage = typeof rewardOffcycleSlaStages[number];
export type RewardCalendarValues = {
  due: Record<RewardCalendarStage, string | null>;
  caseDue: string | null;
  offcycleDays: Record<RewardOffcycleSlaStage, number | null>;
};
const optionalDate = isoDateSchema.nullable();
const optionalDays = z.number().int().min(1).max(90).nullable();
export const rewardCalendarSchema: z.ZodType<RewardCalendarValues> = z.object({
  due: z.object({ bu: optionalDate, returned: optionalDate, bg: optionalDate, gr: optionalDate, ctro: optionalDate, ec: optionalDate, payroll: optionalDate }).strict(),
  caseDue: optionalDate,
  offcycleDays: z.object({ bg: optionalDays, gr: optionalDays, ctro: optionalDays, ec: optionalDays, returned: optionalDays }).strict(),
}).strict();
export const emptyRewardCalendar = (): RewardCalendarValues => ({
  due: { bu: null, returned: null, bg: null, gr: null, ctro: null, ec: null, payroll: null }, caseDue: null,
  offcycleDays: { bg: null, gr: null, ctro: null, ec: null, returned: null },
});

/** The seat a review waits on at its current stage; null once it has left the route. */
export function rewardStageSeat(status: RewardStage, route: readonly RewardRole[]): RewardRole | null {
  if (status === 'draft') return route[0] ?? null;
  if (status === 'approved') return 'payroll';
  return route.includes(status as RewardRole) ? status as RewardRole : null;
}
/** Step i of n along the route, payroll counted as the last step. Null once the review has left the route. */
export function rewardStageStep(status: RewardStage, route: readonly RewardRole[]): { step: number; steps: number } | null {
  const steps = route.length + 1;
  if (status === 'draft') return { step: 1, steps };
  if (status === 'approved') return { step: steps, steps };
  const i = route.indexOf(status as RewardRole);
  return i < 0 ? null : { step: i + 1, steps };
}

const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * When the review's current step is due. `returned` is the derived Returned state; `enteredOn` is the Kuala
 * Lumpur date the review reached its current step (the latest decision), used only for off-cycle service levels.
 */
export function rewardStageDue(calendar: RewardCalendarValues | null, input: { kind: 'annual' | 'adhoc' | 'midyear'; status: RewardStage; returned: boolean; enteredOn: string | null }): string | null {
  if (!calendar) return null;
  const { kind, status, returned, enteredOn } = input;
  if (kind === 'annual') {
    if (status === 'draft') return returned ? calendar.due.returned : calendar.due.bu;
    if (status === 'approved') return calendar.due.payroll;
    return (['bg', 'gr', 'ctro', 'ec'] as const).includes(status as 'bg') ? calendar.due[status as 'bg' | 'gr' | 'ctro' | 'ec'] : null;
  }
  if (!enteredOn) return null;
  const key: RewardOffcycleSlaStage | null = status === 'draft' ? (returned ? 'returned' : null) : (['bg', 'gr', 'ctro', 'ec'] as const).includes(status as 'bg') ? status as 'bg' | 'gr' | 'ctro' | 'ec' : null;
  const days = key ? calendar.offcycleDays[key] : null;
  return days == null ? null : addDays(enteredOn, days);
}

/** Whole days from `today` to `due` (both ISO dates, Kuala Lumpur): negative is overdue. */
export function rewardDaysUntil(due: string, today: string): number {
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}
/** The message (rewards.board.*) for a due date `days` away: overdue, today, tomorrow or in n days. */
export function rewardDueWording(days: number): { key: 'overdue' | 'dueToday' | 'dueTomorrow' | 'dueIn'; days: number } {
  return days < 0 ? { key: 'overdue', days: -days } : days === 0 ? { key: 'dueToday', days: 0 } : days === 1 ? { key: 'dueTomorrow', days: 1 } : { key: 'dueIn', days };
}
