/**
 * The mobile API client (ADR-0088 §2). Response types are imported TYPE-ONLY from the server's contract
 * (lib/mobile-api/contract.ts at the repo root). Public runtime schemas validate responses; database
 * and server authentication services are never bundled into the app.
 *
 * Failure mapping mirrors the server's: 401 ⇒ refresh once and retry, then SignInRequiredError; a network
 * failure or 5xx ⇒ UnavailableError and the session is KEPT.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { fetch as nativeFetch } from 'expo/fetch';
import { readBoundedBody } from '../../lib/bounded-body';
import {
  SubmissionReceiptResponse, TasksResponse, MobileDesignResponse, ClockResponse,ClockResult,DeviceResponse,TeamResponse,LeaveOptionsResponse,LeaveRequestsResponse,LeavePreviewResponse,LeaveResult,LeaveCommand,
  LeaveResponse,
  MeResponse,
  NotificationsResponse,
  PayslipsResponse,
} from '../../lib/mobile-api/contract';
import { assertAuthGeneration, authGeneration, getAccessToken, refresh } from './auth';
import { apiOriginProblem, config, configProblem } from './config';
import { SignInRequiredError, UnavailableError, RequestRejectedError } from './errors';
import { appLocale } from './i18n';

export type { LeaveResponse, MeResponse, NotificationsResponse, PayslipsResponse };

type Endpoints = {
  'submission-receipt': SubmissionReceiptResponse;
  tasks: TasksResponse;
  clock:ClockResponse; team:TeamResponse; 'leave-options':LeaveOptionsResponse; 'leave-requests':LeaveRequestsResponse;
  design: MobileDesignResponse;
  me: MeResponse;
  payslips: PayslipsResponse;
  leave: LeaveResponse;
  notifications: NotificationsResponse;
};

function url(path: string, params: Record<string, string | undefined>): string {
  const q = Object.entries(params)
    .filter((e): e is [string, string] => e[1] != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${config.apiUrl}/api/mobile/v1/${path}${q ? `?${q}` : ''}`;
}

const responses = {
  'submission-receipt': SubmissionReceiptResponse,
  tasks: TasksResponse, clock: ClockResponse, team: TeamResponse, 'leave-options': LeaveOptionsResponse,
  'leave-requests': LeaveRequestsResponse, design: MobileDesignResponse, me: MeResponse,
  payslips: PayslipsResponse, leave: LeaveResponse, notifications: NotificationsResponse,
};
const commands = { clock: ClockResult, 'clock-device': DeviceResponse, 'leave-requests': LeaveResult, 'leave-preview': LeavePreviewResponse };

async function apiRequest<T>(path:string,params:Record<string,string|undefined>,request?:{body:FormData|string;json:boolean},signal?:AbortSignal):Promise<T> {
  if (!config.apiUrl || apiOriginProblem(config.apiUrl) || configProblem()) throw new UnavailableError('The company connection is not configured securely.');
  const owner = authGeneration();
  const schema = request ? commands[path as keyof typeof commands] : responses[path as keyof typeof responses];
  const send = async (token: string) => {
    assertAuthGeneration(owner);
    if(request&&AppState.currentState!=='active')throw new UnavailableError('Unlock the app to continue.');
    if(configProblem())throw new UnavailableError('The approved company connection is no longer valid.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 15_000);
    try {
      const response = await nativeFetch(url(path, params), {
        headers: { authorization: `Bearer ${token}`, 'accept-language': appLocale(), ...(request?.json ? {'content-type':'application/json'} : {}) },
        ...(request ? {method:'POST',body:request.body} : {}),
        redirect: 'error', credentials: 'omit', signal: controller.signal,
      });
      assertAuthGeneration(owner);
      if (!response.ok) {
        void response.body?.cancel().catch(()=>{});
        return {status:response.status, data:undefined};
      }
      const bytes = await readBoundedBody(response, 1024 * 1024, 15_000, controller.signal);
      assertAuthGeneration(owner);
      const text = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
      const parsed = schema.safeParse(JSON.parse(text));
      if (!parsed.success) throw new UnavailableError('Invalid server response.');
      return {status:response.status, data:parsed.data};
    } catch (error) {
      controller.abort();
      assertAuthGeneration(owner);
      if (error instanceof UnavailableError) throw error;
      throw new UnavailableError();
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort',abort); }
  };
  let res = await send(await getAccessToken());
  assertAuthGeneration(owner);
  if (res.status === 401 && !signal?.aborted) res = await send(await refresh());
  assertAuthGeneration(owner);
  if (signal?.aborted) throw new UnavailableError();
  if (res.status === 401) throw new SignInRequiredError();
  if (res.status === 429 || res.status >= 500) throw new UnavailableError();
  if (res.status < 200 || res.status >= 300) throw new RequestRejectedError(res.status);
  return res.data as T;
}

export async function apiGet<P extends keyof Endpoints>(path:P,params:Record<string,string|undefined>={},signal?:AbortSignal):Promise<Endpoints[P]>{return apiRequest(path,params,undefined,signal);}
type Commands = {clock:ClockResult;'clock-device':DeviceResponse;'leave-requests':LeaveResult;'leave-preview':LeavePreviewResponse};
export async function apiPost<P extends keyof Commands>(path:P,body:FormData|LeaveCommand|{label:string},params:Record<string,string|undefined>={}):Promise<Commands[P]>{
  const form=body instanceof FormData;
  return apiRequest(path,params,{body:form?body:JSON.stringify(body),json:!form});
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
  const paramsKey = JSON.stringify(params);
  const key = JSON.stringify([config.apiUrl, path, paramsKey, appLocale(), authGeneration()]);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setResult(prior => ({ key, data: prior?.key === key ? prior.data : null, error: null, loading: true }));
    apiGet(path, JSON.parse(paramsKey) as Record<string, string | undefined>, controller.signal)
      .then((d) => {
        if (!live) return;
        setResult({ key, data: d, error: null, loading: false });
      })
      .catch((e: Error) => {
        if (!live) return;
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
