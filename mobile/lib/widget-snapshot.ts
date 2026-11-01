import type {ClockResponse} from '../../lib/mobile-api/contract';

/** The only attendance information allowed into either native widget store. No identity or command fields. */
export type AttendanceWidgetSnapshot={status:'in'|'out';day:string;inTime:string;outTime:string;updated:string;expiresAt:number};
export const WIDGET_MAX_AGE=15*60_000;
// The existing clock endpoint, like ClockPanel, uses the Malaysia HR business clock (UTC+8).
function time(iso:string|null):string{
 const ms=iso?Date.parse(iso):NaN;if(!Number.isFinite(ms))return '—';
 const d=new Date(ms+8*3600_000);return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}
/** Project an authorized, contract-decoded server answer. Pending/offline commands are never an input. */
export function projectAttendanceWidget(reply:ClockResponse,selectedEmployment:string,now:number):AttendanceWidgetSnapshot|null{
 if(!reply.enabled||reply.employmentId!==selectedEmployment||!reply.state||!Number.isFinite(now))return null;
 const state=reply.state,server=Date.parse(state.serverNow);
 if(!Number.isFinite(server)||server>now+60_000||now-server>=WIDGET_MAX_AGE||!/^\d{4}-\d{2}-\d{2}$/.test(state.date))return null;
 const captures=state.captures.filter(c=>c.date===state.date&&Number.isFinite(Date.parse(c.recordedAt))&&Date.parse(c.recordedAt)<=server).sort((a,b)=>Date.parse(a.recordedAt)-Date.parse(b.recordedAt));
 const lastOut=[...captures].reverse().find(c=>c.direction==='out');
 const lastIn=state.clockedIn?state.openSince:[...captures].reverse().find(c=>c.direction==='in'&&(!lastOut||Date.parse(c.recordedAt)<=Date.parse(lastOut.recordedAt)))?.recordedAt??null;
 return {status:state.clockedIn?'in':'out',day:state.date,inTime:time(lastIn),outTime:state.clockedIn?'—':time(lastOut?.recordedAt??null),updated:time(state.serverNow),expiresAt:Math.min(now+WIDGET_MAX_AGE,server+WIDGET_MAX_AGE)};
}
