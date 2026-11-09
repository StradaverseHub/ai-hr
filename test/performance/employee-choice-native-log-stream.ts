/** Typed adapters; canonical framing/binding/limits are shared with final verifier. */
import * as native from '../../.github/ci/employee-native-log-codec.mjs';
import type {AutoExplainMessage,PlanMarker} from './employee-choice-auto-explain-parser';
export type NativeLogRecord={pid:number;bytes:number;text:string};
export function employeeChoiceNativeLogRecords(parts:Iterable<{bytes:Buffer}>):Generator<NativeLogRecord>{return native.employeeChoiceNativeLogRecords(parts);}
export function employeeChoiceNativePlanPhases(parts:Iterable<{bytes:Buffer}>,pid:number,markers:readonly PlanMarker[],body:string):Generator<{label:string;entries:AutoExplainMessage[]}>{return native.employeeChoiceNativePlanPhases(parts,pid,markers,body);}
export function employeeChoiceNativeMarkerObserver(pid:number,onMarker:(query:string)=>void):{append(value:Buffer):void;finish():void}{return native.employeeChoiceNativeMarkerObserver(pid,onMarker);}
