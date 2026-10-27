/**
 * The mobile API client (ADR-0088 §2). Response types are imported TYPE-ONLY from the server's contract
 * (lib/mobile-api/contract.ts at the repo root). Public runtime schemas validate responses; database
 * and server authentication services are never bundled into the app.
 *
 * Failure mapping mirrors the server's: 401 ⇒ refresh once and retry, then SignInRequiredError; a network
 * failure or 5xx ⇒ UnavailableError and the session is KEPT.
 */
import type {z} from 'zod';
import {IntegrityKeysResultV2,IntegrityRevocationResultV2,IntegrityKeyLookupResultV2,IntegrityKeysResult,IntegrityRevocationResult,IntegrityKeyLookupResult} from '../../lib/mobile-integrity-contract';
import {IntegrityEnrollmentIntent,IntegrityEnrollmentProof,IntegrityEnrollmentPrepared,IntegrityEnrollmentResult,IntegrityAndroidEnrollmentProof,IntegrityAndroidEnrollmentPrepared,IntegrityAndroidEnrollmentResult} from '../../lib/mobile-integrity-contract';
import {IntegrityClockCapabilities,IntegrityClockPrepared,IntegrityAndroidClockPrepared,IntegrityClockResult} from '../../lib/mobile-integrity-contract';
import {IntegrityEnrollmentCapabilitiesV2} from '../../lib/mobile-integrity-contract';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { fetch as nativeFetch } from 'expo/fetch';
import { readBoundedBody } from '../../lib/bounded-body';
import {
  SubmissionAbandonResponse, SubmissionReceiptResponse, TasksResponse, MobileDesignResponse, ClockResponse,ClockLocationResponse,ClockAttemptReceipt,ClockAttemptsResponse,ClockPreparation,ClockResult,DeviceResponse,TeamResponse,LeaveOptionsResponse,LeaveRequestsResponse,LeavePreviewResponse,LeaveResult,LeaveCommand,
  LeaveResponse,
  MeResponse,
  NotificationsResponse,
  PayslipsResponse,
} from '../../lib/mobile-api/contract';
import { assertAuthGeneration, authGeneration, getAccessToken, refresh } from './auth';
import { apiOriginProblem, config, configProblem,identityNamespace } from './config';
import { SignInRequiredError, UnavailableError, RequestRejectedError,SessionChangedError } from './errors';
import {createReadCoordinator,retryAfterSeconds} from './read-coordinator';
import { appLocale } from './i18n';

export type { LeaveResponse, MeResponse, NotificationsResponse, PayslipsResponse };

type Endpoints = {
  'v2/integrity/ios/clock/capabilities':z.infer<typeof IntegrityClockCapabilities>;
  'v2/integrity/android/clock/capabilities':z.infer<typeof IntegrityClockCapabilities>;
  'v2/integrity/ios/capabilities':z.infer<typeof IntegrityEnrollmentCapabilitiesV2>;
  'v2/integrity/android/capabilities':z.infer<typeof IntegrityEnrollmentCapabilitiesV2>;
  'v2/integrity/keys':z.infer<typeof IntegrityKeysResultV2>;
  'integrity/keys':z.infer<typeof IntegrityKeysResult>;
  'clock-attempts':ClockAttemptsResponse;
  'submission-receipt': SubmissionReceiptResponse;
  tasks: TasksResponse;
  clock:ClockResponse; team:TeamResponse; 'leave-options':LeaveOptionsResponse; 'leave-requests':LeaveRequestsResponse;
  design: MobileDesignResponse;
  me: MeResponse;
  payslips: PayslipsResponse;
  leave: LeaveResponse;
  notifications: NotificationsResponse;
};

function url(path: string, params: Record<string, string | undefined>,origin:string): string {
  const q = Object.entries(params)
    .filter((e): e is [string, string] => e[1] != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const version=path.startsWith('v2/')?2:1,resource=version===2?path.slice(3):path;
  return `${origin}/api/mobile/v${version}/${resource}${q ? `?${q}` : ''}`;
}

const responses = {
  'v2/integrity/ios/clock/capabilities':IntegrityClockCapabilities.refine(value=>value.outcome!=='capabilities'||value.platform==='ios'),
  'v2/integrity/android/clock/capabilities':IntegrityClockCapabilities.refine(value=>value.outcome!=='capabilities'||value.platform==='android'),
  'v2/integrity/ios/capabilities':IntegrityEnrollmentCapabilitiesV2.refine(value=>value.outcome!=='capabilities'||value.platform==='ios'),
  'v2/integrity/android/capabilities':IntegrityEnrollmentCapabilitiesV2.refine(value=>value.outcome!=='capabilities'||value.platform==='android'),
  'v2/integrity/keys':IntegrityKeysResultV2,
  'integrity/keys':IntegrityKeysResult,
  'clock-attempts':ClockAttemptsResponse,
  'submission-receipt': SubmissionReceiptResponse,
  tasks: TasksResponse, clock: ClockResponse, team: TeamResponse, 'leave-options': LeaveOptionsResponse,
  'leave-requests': LeaveRequestsResponse, design: MobileDesignResponse, me: MeResponse,
  payslips: PayslipsResponse, leave: LeaveResponse, notifications: NotificationsResponse,
};
const enrollmentCommands={
  'integrity/enrollment/begin':IntegrityEnrollmentPrepared,'integrity/enrollment/complete':IntegrityEnrollmentResult,
  'v2/integrity/android/enrollment/begin':IntegrityAndroidEnrollmentPrepared,'v2/integrity/android/enrollment/complete':IntegrityAndroidEnrollmentResult,
};
const signedClockCommands={
 'v2/integrity/ios/clock/begin':IntegrityClockPrepared,'v2/integrity/ios/clock/complete':IntegrityClockResult,
 'v2/integrity/android/clock/begin':IntegrityAndroidClockPrepared,'v2/integrity/android/clock/complete':IntegrityClockResult,
};
const commands = {...enrollmentCommands,...signedClockCommands,'v2/integrity/key-receipt':IntegrityKeyLookupResultV2,'v2/integrity/revoke':IntegrityRevocationResultV2,'integrity/key-receipt':IntegrityKeyLookupResult,'integrity/revoke':IntegrityRevocationResult,'clock-attempts':ClockAttemptReceipt,'clock-location':ClockLocationResponse, 'submission-abandon':SubmissionAbandonResponse, clock: ClockResult, 'clock-device': DeviceResponse, 'leave-requests': LeaveResult, 'leave-preview': LeavePreviewResponse };

const supportReference=(value:string|null)=>value?.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)?value.toLowerCase():undefined;
async function apiRequest<T>(path:string,params:Record<string,string|undefined>,request?:{body:FormData|string;json:boolean},signal?:AbortSignal,operation?:{assertCurrent():void}):Promise<T> {
  if (!config.apiUrl || apiOriginProblem(config.apiUrl) || configProblem()) throw new UnavailableError('The company connection is not configured securely.');
  const owner = authGeneration();
  const origin=config.apiUrl,namespace=identityNamespace(),locale=appLocale();
  const assertCurrent=()=>{assertAuthGeneration(owner);if(config.apiUrl!==origin||identityNamespace()!==namespace||appLocale()!==locale)throw new SessionChangedError();};
  const schema = request ? commands[path as keyof typeof commands] : responses[path as keyof typeof responses];
  let resource=path;
  const send = async (token: string) => {
    assertCurrent();
    if(request&&AppState.currentState!=='active')throw new UnavailableError('Unlock the app to continue.');
    if(configProblem())throw new UnavailableError('The approved company connection is no longer valid.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 15_000);
    try {
      const response = await nativeFetch(url(resource, params,origin), {
        headers: { authorization: `Bearer ${token}`, 'accept-language': locale, ...(request?.json ? {'content-type':'application/json'} : {}) },
        ...(request ? {method:'POST',body:request.body} : {}),
        redirect: 'error', credentials: 'omit', signal: controller.signal,
      });
      assertCurrent();
      if (!response.ok) {
        void response.body?.cancel().catch(()=>{});
        return {status:response.status, data:undefined,retryAfter:retryAfterSeconds(response.headers.get('retry-after')),supportId:supportReference(response.headers.get('x-aihr-support-id'))};
      }
      const bytes = await readBoundedBody(response, 1024 * 1024, 15_000, controller.signal);
      assertCurrent();
      const text = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
      const responseSchema=path==='v2/integrity/keys'&&resource==='integrity/keys'?IntegrityKeysResult:schema;
      const parsed = responseSchema.safeParse(JSON.parse(text));
      if (!parsed.success) throw new UnavailableError('Invalid server response.');
      return {status:response.status, data:parsed.data};
    } catch (error) {
      controller.abort();
      assertCurrent();
      if (error instanceof UnavailableError) throw error;
      throw new UnavailableError();
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort',abort); }
  };
  try{
    const compatibleRead=async(token:string)=>{
      let response=await send(token);
      // Only missing read-only inventory has a legacy fallback; its decoder stays Apple-only.
      if(!request&&path==='v2/integrity/keys'&&resource===path&&response.status===404&&!signal?.aborted){resource='integrity/keys';response=await send(token);}
      return response;
    };
    let res = await compatibleRead(await getAccessToken());
    assertCurrent();
    if (res.status === 401 && !signal?.aborted) res = await compatibleRead(await refresh());
    assertCurrent();
    if (signal?.aborted) throw new UnavailableError();
    if (res.status === 401) throw new SignInRequiredError();
    if (res.status === 429) throw new UnavailableError(undefined,res.retryAfter);
    if (res.status >= 500) throw new UnavailableError(undefined,res.retryAfter,res.supportId);
    if (res.status < 200 || res.status >= 300) throw new RequestRejectedError(res.status);
    return res.data as T;
  }catch(error){assertCurrent();throw error;}
}

const reads=createReadCoordinator({unavailable:seconds=>new UnavailableError(undefined,seconds),obsolete:()=>new SessionChangedError(),
  backoff:error=>error instanceof UnavailableError?error.retryAfter:undefined});
const canonicalParams=(params:Record<string,string|undefined>)=>Object.fromEntries(Object.entries(params).filter((pair):pair is [string,string]=>pair[1]!==undefined).sort(([a],[b])=>a.localeCompare(b)));
export async function apiGet<P extends keyof Endpoints>(path:P,params:Record<string,string|undefined>={},signal?:AbortSignal):Promise<Endpoints[P]>{
  const owner=authGeneration(),namespace=identityNamespace(),origin=config.apiUrl,locale=appLocale(),snapshot=canonicalParams(params);
  const scope=JSON.stringify([owner,namespace,origin,locale]),key=JSON.stringify([path,snapshot]);
  return reads.read(scope,key,sharedSignal=>{
    assertAuthGeneration(owner);if(identityNamespace()!==namespace||config.apiUrl!==origin||appLocale()!==locale)throw new SessionChangedError();
    return apiRequest<Endpoints[P]>(path,snapshot,undefined,sharedSignal);
  },signal);
}
type Commands = {[P in keyof typeof commands]:z.infer<(typeof commands)[P]>};
type EnrollmentBodies={
  'integrity/enrollment/begin':z.infer<typeof IntegrityEnrollmentIntent>;
  'integrity/enrollment/complete':z.infer<typeof IntegrityEnrollmentProof>;
  'v2/integrity/android/enrollment/begin':z.infer<typeof IntegrityEnrollmentIntent>;
  'v2/integrity/android/enrollment/complete':z.infer<typeof IntegrityAndroidEnrollmentProof>;
};
type LegacyCommandBody=FormData|LeaveCommand|ClockPreparation|{originChallengeId:string}|{keyId:string}|{lat:number;lng:number;accuracy:number;sampledAt:number}|{label:string}|{kind:'clock'|'leave';requestId:string};
export async function apiPost<P extends keyof Commands>(path:P,body:P extends keyof EnrollmentBodies?EnrollmentBodies[P]:P extends keyof typeof signedClockCommands?FormData:LegacyCommandBody,params:Record<string,string|undefined>={},operation?:{assertCurrent():void}):Promise<Commands[P]>{
  const form=body instanceof FormData;
  operation?.assertCurrent();
  if(Object.hasOwn(signedClockCommands,path)&&!form)throw new UnavailableError('Signed clock requests require their saved attachment envelope.');
  return apiRequest(path,params,{body:form?body:JSON.stringify(body),json:!form},undefined,operation);
}
export type {ClockResponse,ClockResult,TeamResponse,LeaveOptionsResponse,LeaveRequestsResponse,LeavePreviewResponse,LeaveResult,LeaveCommand};

export type Loadable<T> = {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
};

/** Load one endpoint; `onSignInRequired` lets the session provider sign the user out on a 401 that survived a refresh. */
export function useApi<P extends keyof Endpoints>(
  path: P,
  params: Record<string, string | undefined>,
  onSignInRequired: () => void,
): Loadable<Endpoints[P]> {
  const [result, setResult] = useState<{ key: string; data: Endpoints[P] | null; error: Error | null; loading: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  const paramsKey = JSON.stringify(canonicalParams(params));
  const namespace=identityNamespace(),origin=config.apiUrl,locale=appLocale(),owner=authGeneration();
  const key = JSON.stringify([namespace,origin, path, paramsKey, locale, owner]);

  useEffect(() => {
    let live = true;
    const belongs=()=>live&&authGeneration()===owner&&identityNamespace()===namespace&&config.apiUrl===origin&&appLocale()===locale;
    const controller = new AbortController();
    setResult(prior => ({ key, data: prior?.key === key ? prior.data : null, error: null, loading: true }));
    apiGet(path, JSON.parse(paramsKey) as Record<string, string | undefined>, controller.signal)
      .then((d) => {
        if (!belongs()) return;
        setResult({ key, data: d, error: null, loading: false });
      })
      .catch((e: Error) => {
        if (!belongs()) return;
        if (e instanceof SignInRequiredError) onSignInRequired();
        setResult(prior => ({ key, data: e instanceof RequestRejectedError || e instanceof SignInRequiredError ? null : prior?.key === key ? prior.data : null, error: e, loading: false }));
      })
    return () => {
      live = false;
      controller.abort();
    };
  }, [path, key, paramsKey, tick, onSignInRequired]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  // Hide the previous employment's result in the render that changes context, before effects run.
  return result?.key === key ? { data: result.data, error: result.error, loading: result.loading, reload } :
    { data: null, error: null, loading: true, reload };
}
