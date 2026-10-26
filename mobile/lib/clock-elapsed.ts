/** Only elapsed app-event durations may leave this boundary. No boot time/identifier is returned. */
import {NativeClockSnapshot} from './integrity-bridge';
export type LocalElapsedEvidence=
  |{status:'elapsed';minimumNs:string;maximumNs:string;continuity:'same_process'|'same_boot';verification:'not_verified'}
  |{status:'unknown';reason:'invalid_snapshot'|'source_changed'|'boot_changed'|'continuity_unknown'|'counter_discontinuity'};
export function elapsedBetweenClockSnapshots(anchor:unknown,current:unknown):LocalElapsedEvidence{
  const a=NativeClockSnapshot.safeParse(anchor),b=NativeClockSnapshot.safeParse(current);
  if(!a.success||!b.success)return {status:'unknown',reason:'invalid_snapshot'};
  const first=a.data,next=b.data;
  if(first.source!==next.source)return {status:'unknown',reason:'source_changed'};
  if(first.bootId!==null&&next.bootId!==null&&first.bootId!==next.bootId)return {status:'unknown',reason:'boot_changed'};
  const continuity=first.runtimeId===next.runtimeId?'same_process':first.bootId!==null&&first.bootId===next.bootId?'same_boot':null;
  if(!continuity)return {status:'unknown',reason:'continuity_unknown'};
  const minimum=BigInt(next.elapsedBeforeNs)-BigInt(first.elapsedAfterNs),maximum=BigInt(next.elapsedAfterNs)-BigInt(first.elapsedBeforeNs);
  if(minimum<BigInt(0)||maximum<minimum)return {status:'unknown',reason:'counter_discontinuity'};
  return {status:'elapsed',minimumNs:String(minimum),maximumNs:String(maximum),continuity,verification:'not_verified'};
}
