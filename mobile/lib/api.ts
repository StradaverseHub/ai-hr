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
import {OfflineCapabilitiesResult,OfflineContextResult,OfflineCloseResult,OfflineClaimResult,type OfflineContextIssueRequest,type OfflineContextCloseRequest} from '../../lib/mobile-offline-contract';
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
import { SignInRequiredError, UnavailableError, RequestRejectedError,SessionChangedError,NetworkUnavailableError } from './errors';
import {createReadCoordinator,retryAfterSeconds} from './read-coordinator';
import { appLocale } from './i18n';
import { MobileRefusal, pageOf, type Page } from '../../lib/mobile-api/v2/common';
import { writeProtectedDocument, type ProtectedDocument, type ProtectedDocumentType } from './protected-document';

export type { LeaveResponse, MeResponse, NotificationsResponse, PayslipsResponse };

type Endpoints = {
  'v2/integrity/ios/clock/capabilities':z.infer<typeof IntegrityClockCapabilities>;
  'v2/integrity/android/clock/capabilities':z.infer<typeof IntegrityClockCapabilities>;
  'v2/integrity/ios/capabilities':z.infer<typeof IntegrityEnrollmentCapabilitiesV2>;
  'v2/integrity/android/capabilities':z.infer<typeof IntegrityEnrollmentCapabilitiesV2>;
  'v2/integrity/ios/offline/capabilities':z.infer<typeof OfflineCapabilitiesResult>;
  'v2/integrity/android/offline/capabilities':z.infer<typeof OfflineCapabilitiesResult>;
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
  'v2/integrity/ios/offline/capabilities':OfflineCapabilitiesResult,
  'v2/integrity/android/offline/capabilities':OfflineCapabilitiesResult,
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
 // Offline claim upload: multipart claim + retained photo (+ Android sync Play token); never a JSON body.
 'v2/integrity/ios/offline/claim':OfflineClaimResult,'v2/integrity/android/offline/claim':OfflineClaimResult,
};
const offlineCommands={
 'v2/integrity/ios/offline/context':OfflineContextResult,'v2/integrity/android/offline/context':OfflineContextResult,
 'v2/integrity/ios/offline/context/close':OfflineCloseResult,'v2/integrity/android/offline/context/close':OfflineCloseResult,
};
const commands = {...enrollmentCommands,...signedClockCommands,...offlineCommands,'v2/integrity/key-receipt':IntegrityKeyLookupResultV2,'v2/integrity/revoke':IntegrityRevocationResultV2,'integrity/key-receipt':IntegrityKeyLookupResult,'integrity/revoke':IntegrityRevocationResult,'clock-attempts':ClockAttemptReceipt,'clock-location':ClockLocationResponse, 'submission-abandon':SubmissionAbandonResponse, clock: ClockResult, 'clock-device': DeviceResponse, 'leave-requests': LeaveResult, 'leave-preview': LeavePreviewResponse };

/**
 * The v2 registry. A v2 resource is declared ONCE, as a descriptor carrying its contract schema (pages) or
 * its byte policy (downloads), so a v2 body is never decoded by a v1 schema or by a guess. `url()` already
 * routes a `v2/` path to /api/mobile/v2/. Identifiers travel as query parameters, never path segments.
 */
type V2Path=`v2/${string}`;
export type V2Page<T>={kind:'page';path:V2Path;schema:z.ZodType<Page<T>>};
export type V2Download={kind:'download';path:V2Path;maxBytes:number;types:readonly ProtectedDocumentType[]};
export function v2Page<S extends z.ZodType>(path:V2Path,item:S):V2Page<z.output<S>>{
  return {kind:'page',path,schema:pageOf(item) as unknown as z.ZodType<Page<z.output<S>>>};
}
/** A protected file. 10 MiB is the server's ceiling too (lib/mobile-api/handler.ts MOBILE_BINARY_MAX_BYTES). */
export function v2Download(path:V2Path,maxBytes=10*1024*1024,types:readonly ProtectedDocumentType[]=['application/pdf']):V2Download{
  if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>10*1024*1024)throw new Error('Invalid download bound');
  return {kind:'download',path,maxBytes,types};
}
type BinaryReply={outcome:'file';bytes:Uint8Array;mimeType:ProtectedDocumentType}|MobileRefusal;
type RequestMode={schema?:z.ZodType;binary?:{maxBytes:number;types:readonly string[]}};

const supportReference=(value:string|null)=>value?.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)?value.toLowerCase():undefined;
async function apiRequest<T>(path:string,params:Record<string,string|undefined>,request?:{body:FormData|string;json:boolean},signal?:AbortSignal,operation?:{assertCurrent():void},mode:RequestMode={}):Promise<T> {
  if (!config.apiUrl || apiOriginProblem(config.apiUrl) || configProblem()) throw new UnavailableError('The company connection is not configured securely.');
  const owner = authGeneration();
  const origin=config.apiUrl,namespace=identityNamespace(),locale=appLocale();
  const assertCurrent=()=>{operation?.assertCurrent();assertAuthGeneration(owner);if(config.apiUrl!==origin||identityNamespace()!==namespace||appLocale()!==locale)throw new SessionChangedError();};
  const schema = mode.schema ?? (request ? commands[path as keyof typeof commands] : responses[path as keyof typeof responses]);
  let resource=path;
  const send = async (token: string) => {
    let responded=false;
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
      responded=true;
      assertCurrent();
      if (!response.ok) {
        void response.body?.cancel().catch(()=>{});
        return {status:response.status, data:undefined,retryAfter:retryAfterSeconds(response.headers.get('retry-after')),supportId:supportReference(response.headers.get('x-aihr-support-id'))};
      }
      if (mode.binary) {
        // A protected file is the bytes of an allowed type sent as an attachment; a refusal is JSON at 200.
        const type=(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
        if (type==='application/json') {
          const refusal=MobileRefusal.safeParse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedBody(response,16384,15_000,controller.signal))));
          assertCurrent();
          if (!refusal.success) throw new UnavailableError('Invalid server response.');
          return {status:response.status,data:refusal.data};
        }
        if (!mode.binary.types.includes(type)||!/^attachment(;|$)/i.test(response.headers.get('content-disposition')??'')) {
          void response.body?.cancel().catch(()=>{});
          throw new UnavailableError('Invalid server response.');
        }
        const file=await readBoundedBody(response,mode.binary.maxBytes,30_000,controller.signal);
        assertCurrent();
        if (!file.byteLength) throw new UnavailableError('Invalid server response.');
        return {status:response.status,data:{outcome:'file',bytes:file,mimeType:type}};
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
      // No HTTP response at all (and not the caller's own abort): the offline connectivity test. Same class family.
      throw responded||signal?.aborted?new UnavailableError():new NetworkUnavailableError();
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
/** One page of a v2 cursor list. Shares the read coordinator with apiGet: same dedupe, backoff and scope reset. */
export async function apiGetPage<T>(resource:V2Page<T>,cursor:string|null,params:Record<string,string|undefined>={},signal?:AbortSignal):Promise<Page<T>>{
  if('cursor' in params)throw new Error('Pass the cursor separately');
  const owner=authGeneration(),namespace=identityNamespace(),origin=config.apiUrl,locale=appLocale(),snapshot=canonicalParams({...params,cursor:cursor??undefined});
  const scope=JSON.stringify([owner,namespace,origin,locale]),key=JSON.stringify(['page',resource.path,snapshot]);
  return reads.read(scope,key,sharedSignal=>{
    assertAuthGeneration(owner);if(identityNamespace()!==namespace||config.apiUrl!==origin||appLocale()!==locale)throw new SessionChangedError();
    return apiRequest<Page<T>>(resource.path,snapshot,undefined,sharedSignal,undefined,{schema:resource.schema});
  },signal);
}

/**
 * M07 — one v2 JSON read decoded by its OWN contract schema (a detail, not a page). Shares the read coordinator
 * with apiGet/apiGetPage: same dedupe, backoff and scope reset. A path segment is only ever a validated UUID
 * (the caller builds it, e.g. leave-history.tsx leaveRequestPath); identity and policy never travel in it.
 */
export async function apiGetV2<S extends z.ZodType>(path:V2Path,schema:S,params:Record<string,string|undefined>={},signal?:AbortSignal):Promise<z.output<S>>{
  const owner=authGeneration(),namespace=identityNamespace(),origin=config.apiUrl,locale=appLocale(),snapshot=canonicalParams(params);
  const scope=JSON.stringify([owner,namespace,origin,locale]),key=JSON.stringify(['v2',path,snapshot]);
  return reads.read(scope,key,sharedSignal=>{
    assertAuthGeneration(owner);if(identityNamespace()!==namespace||config.apiUrl!==origin||appLocale()!==locale)throw new SessionChangedError();
    return apiRequest<z.output<S>>(path,snapshot,undefined,sharedSignal,undefined,{schema});
  },signal);
}
/** M07 — one v2 JSON command decoded by its own result schema. Never coordinated or retried here: one call, one POST. */
export async function apiPostV2<S extends z.ZodType>(path:V2Path,schema:S,body:Record<string,unknown>,params:Record<string,string|undefined>={},operation?:{assertCurrent():void}):Promise<z.output<S>>{
  operation?.assertCurrent();
  return apiRequest<z.output<S>>(path,canonicalParams(params),{body:JSON.stringify(body),json:true},undefined,operation,{schema});
}

/**
 * Download a protected file into a random-named cache file (protected-document.ts) and hand back its
 * handle, or the server's refusal. Never shared between callers, never written while the app is not in
 * the foreground (the background sweep has already run), never written for a superseded session. The
 * caller deletes the handle when its confirmed use ends; the sweep catches everything else.
 */
export async function apiDownload(resource:V2Download,params:Record<string,string|undefined>={},signal?:AbortSignal):Promise<{outcome:'file';document:ProtectedDocument}|MobileRefusal>{
  const owner=authGeneration(),namespace=identityNamespace(),origin=config.apiUrl;
  const reply=await apiRequest<BinaryReply>(resource.path,canonicalParams(params),undefined,signal,undefined,{binary:{maxBytes:resource.maxBytes,types:resource.types}});
  if(reply.outcome==='refused')return reply;
  assertAuthGeneration(owner);
  if(identityNamespace()!==namespace||config.apiUrl!==origin)throw new SessionChangedError();
  if(signal?.aborted)throw new UnavailableError();
  if(AppState.currentState!=='active')throw new UnavailableError('Unlock the app to continue.');
  return {outcome:'file',document:writeProtectedDocument(reply.bytes,reply.mimeType)};
}
type Commands = {[P in keyof typeof commands]:z.infer<(typeof commands)[P]>};
type EnrollmentBodies={
  'integrity/enrollment/begin':z.infer<typeof IntegrityEnrollmentIntent>;
  'integrity/enrollment/complete':z.infer<typeof IntegrityEnrollmentProof>;
  'v2/integrity/android/enrollment/begin':z.infer<typeof IntegrityEnrollmentIntent>;
  'v2/integrity/android/enrollment/complete':z.infer<typeof IntegrityAndroidEnrollmentProof>;
  'v2/integrity/ios/offline/context':z.input<typeof OfflineContextIssueRequest>;
  'v2/integrity/android/offline/context':z.input<typeof OfflineContextIssueRequest>;
  'v2/integrity/ios/offline/context/close':z.input<typeof OfflineContextCloseRequest>;
  'v2/integrity/android/offline/context/close':z.input<typeof OfflineContextCloseRequest>;
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

/**
 * useApi for one v2 JSON read decoded by its OWN contract schema (apiGetV2): the same scoping (identity, connection,
 * locale, auth generation, params), the same stale-on-outage / drop-on-refusal rule. `schema` must be a module
 * constant. M14: the composed Tasks widget reads the canonical v2 task list through this.
 */
export function useApiV2<S extends z.ZodType>(
  path: V2Path,
  schema: S,
  params: Record<string, string | undefined>,
  onSignInRequired: () => void,
): Loadable<z.output<S>> {
  const [result, setResult] = useState<{ key: string; data: z.output<S> | null; error: Error | null; loading: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  const paramsKey = JSON.stringify(canonicalParams(params));
  const namespace=identityNamespace(),origin=config.apiUrl,locale=appLocale(),owner=authGeneration();
  const key = JSON.stringify([namespace,origin, path, paramsKey, locale, owner]);

  useEffect(() => {
    let live = true;
    const belongs=()=>live&&authGeneration()===owner&&identityNamespace()===namespace&&config.apiUrl===origin&&appLocale()===locale;
    const controller = new AbortController();
    setResult(prior => ({ key, data: prior?.key === key ? prior.data : null, error: null, loading: true }));
    apiGetV2(path, schema, JSON.parse(paramsKey) as Record<string, string | undefined>, controller.signal)
      .then((d) => { if (belongs()) setResult({ key, data: d, error: null, loading: false }); })
      .catch((e: Error) => {
        if (!belongs()) return;
        if (e instanceof SignInRequiredError) onSignInRequired();
        setResult(prior => ({ key, data: e instanceof RequestRejectedError || e instanceof SignInRequiredError ? null : prior?.key === key ? prior.data : null, error: e, loading: false }));
      });
    return () => { live = false; controller.abort(); };
  }, [path, key, paramsKey, tick, onSignInRequired]); // `schema` is a module constant
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return result?.key === key ? { data: result.data, error: result.error, loading: result.loading, reload } :
    { data: null, error: null, loading: true, reload };
}
