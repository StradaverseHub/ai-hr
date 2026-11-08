/** Typed adapters over the one read-only canonical codec; no copied semantics. */
import * as native from '../../.github/ci/employee-native-log-codec.mjs';
export type AutoExplainMessage={pid:number;durationMs:number;query:string;document:Record<string,unknown>;context:string};
export type NativePageExpectation={total:number;offset:number;limit:number};
export type NativeCallExpectation={port:'page'|'ids'|'project';rows:number;matchedIds?:number;serverScopeIds?:number;pagination?:NativePageExpectation;assignmentPageRows?:number};
export type PlanMarker={label:string;begin:string;end:string;native:boolean;expectedNativeRows?:number;expectedNativeCalls?:readonly NativeCallExpectation[]};
type Invocation={expectedRows:number;nestedRows:unknown;functionRows:unknown;nestedDurationMs:number};
type Membership={kind:string;matchedIds:number;unnestRows:unknown;unnestLoops:number;membershipRows:unknown;membershipLoops:number;hashedSubplan:unknown;linearMatchedArrayRefused:boolean};
type Pagination=NativePageExpectation&{kind:string;k:number;r:number;direction:string;rowGoal:number;unusedSourceSortLimitLoops:number;sortMethod:unknown};
type Projection={kind:string;pageRows:number;boundedSources:number;probes:number;tupleWork:number;fullAssignmentSourceWork:number};
type Calls=Invocation&{port:NativeCallExpectation['port'];membership?:Membership;serverScope?:Membership&{scopeIds:unknown};pagination?:Pagination;assignmentHydration?:Projection};
export function employeeChoiceAutoExplainMessages(log:string,pid:number):AutoExplainMessage[]{return native.employeeChoiceAutoExplainMessages(log,pid);}
export const employeeChoiceSqlFingerprint=(sql:string):string=>native.employeeChoiceSqlFingerprint(sql);
export function employeeChoiceNativeBody(source:string):string{return native.employeeChoiceNativeBody(source);}
export function employeeChoiceNativeInvocation(entries:readonly AutoExplainMessage[],body:string,expectedRows:number):Invocation{return native.employeeChoiceNativeInvocation(entries,body,expectedRows);}
export function employeeChoiceNativeInvocations(entries:readonly AutoExplainMessage[],body:string,expected:readonly NativeCallExpectation[]):Calls[]{return native.employeeChoiceNativeInvocations(entries,body,expected);}
export function employeeChoiceNativeProjectMembership(plan:unknown,matchedIds:unknown):Membership{return native.employeeChoiceNativeProjectMembership(plan,matchedIds);}
export function employeeChoiceNativeServerMembership(plan:unknown,scopeIds:unknown):Membership&{scopeIds:unknown}{return native.employeeChoiceNativeServerMembership(plan,scopeIds);}
export function employeeChoiceNativePagination(plan:unknown,expected:NativePageExpectation):Pagination{return native.employeeChoiceNativePagination(plan,expected);}
export function bindEmployeeChoiceNativePlans(messages:readonly AutoExplainMessage[],markers:readonly PlanMarker[],body:string):Map<string,AutoExplainMessage[]>{return native.bindEmployeeChoiceNativePlans(messages,markers,body);}
export function employeeChoiceNativeProjectionAssignments(plan:unknown,pageRows:number):Projection{return native.employeeChoiceNativeProjectionAssignments(plan,pageRows);}
