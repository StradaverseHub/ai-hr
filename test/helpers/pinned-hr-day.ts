/**
 * One HR business day per test case, read once from the HR date owner (lib/hr-date.ts).
 *
 * A case that derives its dates from todayInKualaLumpur() on every use builds fixtures on one day and
 * asserts on the next when the run crosses Kuala Lumpur midnight (gate run 43456019606: a capture written
 * for "day 3" at 23:59 and read back as "day 3" at 00:00 named two different dates). pin() captures the
 * day once and runs the process clock from that day's noon, still advancing in real time, so the case's
 * dates and the services' own todayInKualaLumpur() checks (for example "Activation cannot backdate")
 * agree for the whole case. Only Date is faked; timers, performance and the database are untouched.
 */
import {vi} from 'vitest';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {addCalendarDays} from '../../lib/hr-date-calendar';

export function createPinnedHrDay(){
 let pinned:string|null=null;
 const today=()=>{if(!pinned)throw new Error('Pin the HR day in beforeEach before deriving case dates.');return pinned;};
 return {
  /** Capture the HR day once for this case and start the process clock at its Kuala Lumpur noon. */
  pin(now:Date=new Date()):string{
   pinned=todayInKualaLumpur(now);
   vi.useFakeTimers({toFake:['Date'],shouldAdvanceTime:true});
   vi.setSystemTime(new Date(`${pinned}T12:00:00+08:00`));
   return pinned;
  },
  release(){vi.useRealTimers();pinned=null;},
  today,
  /** The pinned day shifted by whole calendar days; never re-reads the clock. */
  day:(offset:number)=>addCalendarDays(today(),offset),
 };
}
