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

/** Bound an event relative to a server instant minted during a request/response exchange.
 * The caller retains the ORIGINAL request-start snapshot across retries and binds that exchange
 * to its nonce/context before using these bounds. This helper verifies neither issuance nor time.
 * Raw snapshots remain local. Using only the response snapshot would hide network/server delay. */
export function elapsedFromServerExchange(requestStarted:unknown,responseReceived:unknown,event:unknown):LocalElapsedEvidence{
  const exchange=elapsedBetweenClockSnapshots(requestStarted,responseReceived);
  if(exchange.status==='unknown')return exchange;
  const afterResponse=elapsedBetweenClockSnapshots(responseReceived,event);
  if(afterResponse.status==='unknown')return afterResponse;
  const afterRequest=elapsedBetweenClockSnapshots(requestStarted,event);
  if(afterRequest.status==='unknown')return afterRequest;
  const minimum=BigInt(afterResponse.minimumNs),maximum=BigInt(afterRequest.maximumNs);
  if(maximum<minimum)return {status:'unknown',reason:'counter_discontinuity'};
  return {status:'elapsed',minimumNs:String(minimum),maximumNs:String(maximum),
    continuity:exchange.continuity==='same_process'&&afterResponse.continuity==='same_process'&&afterRequest.continuity==='same_process'?'same_process':'same_boot',
    verification:'not_verified'};
}
