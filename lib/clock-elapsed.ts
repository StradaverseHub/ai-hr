/** Elapsed clock display only, never a payable-duration calculation. Keep a future recorded
 * clock-in from accumulating time before it starts; closed intervals remain the owner's figure. */
export function liveClockSeconds(snapshot:{serverNow:string;clockedIn:boolean;openSince:string|null;workedSeconds:number},now:number){
 const baseline=Date.parse(snapshot.serverNow),opened=snapshot.openSince===null?baseline:Date.parse(snapshot.openSince);
 const extra=snapshot.clockedIn&&Number.isFinite(now)&&Number.isFinite(baseline)&&Number.isFinite(opened)
  ?Math.max(0,Math.floor((now-Math.max(baseline,opened))/1000)):0;
 return snapshot.workedSeconds+extra;
}
