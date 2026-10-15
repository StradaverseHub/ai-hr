import { config, configProblem } from './config';
import { assertAuthGeneration } from './auth';
export type InternalReply = { step: 'password' | 'enroll' | 'mfa' | 'complete'; challenge?: string; secret?: string; qr?: string; account?: string;
  access_token?: string; refresh_token?: string; expires_in?: number; recoveryCodes?: string[] };
export class InternalSignInError extends Error {
  constructor(public code: string) { super(code); }
}
/** First-party credentials travel only to the selected, approved HR origin. No OIDC endpoint is followed. */
export async function internalAuthRequest(operation: 'login' | 'password' | 'mfa', values: Record<string, string>, owner: number, fetcher: typeof fetch = fetch): Promise<InternalReply> {
  assertAuthGeneration(owner);
  if (configProblem() || config.authProvider !== 'internal') throw new InternalSignInError('unavailable');
  const endpoint = config.apiUrl + '/login/api/' + operation;
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetcher(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aihr-client': 'native' },
      body: JSON.stringify(values), credentials: 'omit', redirect: 'error', signal: controller.signal });
    assertAuthGeneration(owner);
    if (Number(response.headers.get('content-length')) > 32_768) throw new InternalSignInError('unavailable');
    const reader = response.body?.getReader();
    let text: string;
    if (!reader) text = await response.text();
    else {
      let size = 0; const parts: Uint8Array[] = [];
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        assertAuthGeneration(owner); size += chunk.value.length;
        if (size > 32_768) { await reader.cancel(); throw new InternalSignInError('unavailable'); }
        parts.push(chunk.value);
      }
      const data = new Uint8Array(size); let at = 0;
      for (const part of parts) { data.set(part, at); at += part.length; }
      text = decodeURIComponent(Array.from(data, b => '%' + b.toString(16).padStart(2, '0')).join(''));
    }
    assertAuthGeneration(owner);
    if (text.length > 32_768) throw new InternalSignInError('unavailable');
    const result = JSON.parse(text);
    if (!response.ok) throw new InternalSignInError(typeof result?.error === 'string' ? result.error : 'unavailable');
    if (!result || !['password','enroll','mfa','complete'].includes(result.step) ||
      (result.step !== 'complete' && (typeof result.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.challenge))) ||
      (result.step === 'complete' && (typeof result.access_token !== 'string' || !/^aihr_[A-Za-z0-9_-]{43}$/.test(result.access_token) ||
        typeof result.refresh_token !== 'string' || !/^aihr_refresh_[A-Za-z0-9_-]{43}$/.test(result.refresh_token) ||
        !Number.isFinite(result.expires_in) || result.expires_in <= 0 || result.expires_in > 3600)) ||
      (result.step === 'enroll' && (typeof result.secret !== 'string' || !/^[A-Z2-7]{16,64}$/.test(result.secret) ||
        typeof result.qr !== 'string' || !result.qr.startsWith('data:image/png;base64,'))) ||
      (result.recoveryCodes !== undefined && (!Array.isArray(result.recoveryCodes) || result.recoveryCodes.length !== 8 ||
        !result.recoveryCodes.every((code: unknown) => typeof code === 'string' && /^[A-F0-9-]{32,40}$/.test(code))))) throw new InternalSignInError('unavailable');
    return result;
  } finally { clearTimeout(timeout); }
}
