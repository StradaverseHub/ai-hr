/** Full-unit snapshots are measured producer facts, never inferred from Vitest success. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {assessHealth} from './host-health.mjs';
export function validateCompleteUnitHealth({report,standaloneHealth,producer}){
 const snapshots=[report?.healthBefore,report?.healthAfter],times=[];
 for(const snapshot of snapshots){
  assert(snapshot?.platform==='linux'&&snapshot.ok===true&&Number.isSafeInteger(snapshot.availableDiskBytes),'Complete Linux runner health measurement required');
  const measured=assessHealth(snapshot);assert(measured.ok&&isDeepStrictEqual(snapshot.reasons,measured.reasons)&&isDeepStrictEqual(snapshot.warnings,measured.warnings),'Unhealthy or forged runner health');
  const at=Date.parse(snapshot.at);assert(Number.isFinite(at)&&at>=Date.parse(producer.started_at)&&at<=Date.parse(producer.completed_at),'Runner health outside authenticated producing job');times.push(at);
 }
 assert(times[0]<=times[1],'Reversed runner health snapshots');
 assert(isDeepStrictEqual(standaloneHealth,snapshots[0]),'Standalone runner health differs from embedded measurement');
 return true;
}
