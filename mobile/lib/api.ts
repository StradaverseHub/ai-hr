/**
 * The mobile API client (ADR-0088 §2). Response types are imported TYPE-ONLY from the server's contract
 * (lib/mobile-api/contract.ts at the repo root), so the shape has one owner and nothing server-side is
 * bundled into the app.
 *
 * Failure mapping mirrors the server's: 401 ⇒ refresh once and retry, then SignInRequiredError; a network
 * failure or 5xx ⇒ UnavailableError and the session is KEPT.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  MobileDesignResponse, ClockResponse,ClockResult,DeviceResponse,TeamResponse,LeaveOptionsResponse,LeaveRequestsResponse,LeavePreviewResponse,LeaveResult,LeaveCommand,
  LeaveResponse,
  MeResponse,
  NotificationsResponse,
  PayslipsResponse,
} from '../../lib/mobile-api/contract';
import { assertAuthGeneration, authGeneration, getAccessToken, refresh } from './auth';
import { apiOriginProblem, config } from './config';
import { SignInRequiredError, UnavailableError, RequestRejectedError } from './errors';
import { appLocale } from './i18n';

export type { LeaveResponse, MeResponse, NotificationsResponse, PayslipsResponse };

type Endpoints = {
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

async function apiRequest<T>(path:string,params:Record<string,string|undefined>,request?:{body:FormData|string;json:boolean}):Promise<T> {
  if (!config.apiUrl || apiOriginProblem(config.apiUrl)) throw new UnavailableError('The API origin is not configured securely.');
  const owner = authGeneration();
  const send = async (token: string) => {
    assertAuthGeneration(owner);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url(path, params), {
        headers: { authorization: `Bearer ${token}`, 'accept-language': appLocale(), ...(request?.json ? {'content-type':'application/json'} : {}) },
        ...(request ? {method:'POST',body:request.body} : {}),
        redirect: 'error',
        signal: controller.signal,
      });
      return response;
    } catch {
      throw new UnavailableError();
    } finally { clearTimeout(timeout); }
  };
  let res = await send(await getAccessToken());
  assertAuthGeneration(owner);
  if (res.status === 401) res = await send(await refresh());
  assertAuthGeneration(owner);
  if (res.status === 401) throw new SignInRequiredError();
  if (res.status === 429 || res.status >= 500) throw new UnavailableError();
  if (!res.ok) throw new RequestRejectedError(res.status);
  const data = (await res.json()) as T;
  assertAuthGeneration(owner);
  return data;
}

export async function apiGet<P extends keyof Endpoints>(path:P,params:Record<string,string|undefined>={}):Promise<Endpoints[P]>{return apiRequest(path,params);}
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
  const key = JSON.stringify([path, paramsKey, authGeneration()]);

  useEffect(() => {
    let live = true;
    setResult({ key, data: null, error: null, loading: true });
    apiGet(path, JSON.parse(paramsKey) as Record<string, string | undefined>)
      .then((d) => {
        if (!live) return;
        setResult({ key, data: d, error: null, loading: false });
      })
      .catch((e: Error) => {
        if (!live) return;
        if (e instanceof SignInRequiredError) onSignInRequired();
        setResult({ key, data: null, error: e, loading: false });
      })
    return () => {
      live = false;
    };
  }, [path, key, paramsKey, tick, onSignInRequired]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  // Hide the previous employment's result in the render that changes context, before effects run.
  return result?.key === key ? { data: result.data, error: result.error, loading: result.loading, reload } :
    { data: null, error: null, loading: true, reload };
}
