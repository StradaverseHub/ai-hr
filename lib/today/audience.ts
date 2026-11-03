/** Today (AI v2 Phase 1, W3): who the home screen is drawn for, and the date window it counts over.
 *
 * Pure. The audience only chooses WHICH owner reads run and how the sections are laid out; every read still
 * runs as the caller under row-level security, so a wrong audience can show less, never more. */
import type {SessionContext} from '../../db/client';
import {isAdmin,isGroupAdmin} from '../authz-model';

export type TodayAudience=Readonly<{
 /** HR administrator or super administrator: the three-column administrator layout. Everyone else (employee,
  * manager, payroll partner) gets the personal layout with the At a glance panel. */
 layout:'administrator'|'personal';
 /** Group-wide administrator: outcome records of other people in scope are visible to them (RLS, migration 0928). */
 groupAdmin:boolean;
 /** Holds the manager role: approvals arrive in Needs you, with the leave recommender where it may run. */
 manager:boolean;
}>;

export function todayAudience(s:SessionContext):TodayAudience{
 const admin=isAdmin(s);
 return Object.freeze({layout:admin?'administrator':'personal',groupAdmin:admin&&isGroupAdmin(s),manager:(s.roles??[]).includes('manager')});
}

/** Done for you counts the last seven HR days, today included. */
export const TODAY_WINDOW_DAYS=7;

const DAY_MS=86_400_000;
/** Adds whole days to an HR date (yyyy-mm-dd), as a calendar date. */
export function addHrDays(iso:string,days:number):string{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))throw Error('Not an HR date.');
 return new Date(Date.parse(`${iso}T00:00:00Z`)+days*DAY_MS).toISOString().slice(0,10);
}

/** The instant the window opens: midnight in Malaysia (UTC+8 all year, no daylight saving) on the first day. */
export function windowStart(today:string,days=TODAY_WINDOW_DAYS):Date{
 return new Date(`${addHrDays(today,-(days-1))}T00:00:00+08:00`);
}

/** The greeting for an hour of the Malaysian day (0–23). */
export function greetingFor(hour:number):'greetingMorning'|'greetingAfternoon'|'greetingEvening'{
 return hour<12?'greetingMorning':hour<18?'greetingAfternoon':'greetingEvening';
}

/** The given name a greeting uses: the first word of the recorded name, or null. */
export function greetingName(name:string|null|undefined):string|null{
 const first=name?.trim().split(/\s+/)[0];
 return first?first:null;
}
