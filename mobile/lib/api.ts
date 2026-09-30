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
  LeaveResponse,
  MeResponse,
  NotificationsResponse,
  PayslipsResponse,
} from '../../lib/mobile-api/contract';
import { getAccessToken, refresh } from './auth';
import { config } from './config';
import { SignInRequiredError, UnavailableError } from './errors';
import { appLocale } from './i18n';

export type { LeaveResponse, MeResponse, NotificationsResponse, PayslipsResponse };

type Endpoints = {
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

export async function apiGet<P extends keyof Endpoints>(
  path: P,
  params: Record<string, string | undefined> = {},
): Promise<Endpoints[P]> {
  const send = async (token: string) => {
    try {
      return await fetch(url(path, params), {
        headers: { authorization: `Bearer ${token}`, 'accept-language': appLocale() },
      });
    } catch {
      throw new UnavailableError();
    }
  };
  let res = await send(await getAccessToken());
  if (res.status === 401) res = await send(await refresh());
  if (res.status === 401) throw new SignInRequiredError();
  if (res.status >= 500) throw new UnavailableError();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Endpoints[P];
}

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
  const [data, setData] = useState<Endpoints[P] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(params);

  useEffect(() => {
    let live = true;
    setLoading(true);
    apiGet(path, JSON.parse(key) as Record<string, string | undefined>)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => {
        if (!live) return;
        if (e instanceof SignInRequiredError) onSignInRequired();
        setError(e);
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, key, tick, onSignInRequired]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}
