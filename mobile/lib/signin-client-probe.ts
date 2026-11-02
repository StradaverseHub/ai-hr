/** Temporary review-only diagnostic. Fixed invalid syntax never reaches account lookup. */
import { fetch as nativeFetch } from 'expo/fetch';
import { beginSignIn } from './auth';
import { configProblem, runtimeConnections } from './config';
import { verifyCompanyServer } from './connection-probe';
import { internalAuthRequest, InternalSignInError } from './internal-auth';
import { BodyReadError } from '../../lib/bounded-body';
import type { VerifiedCompanyProfile } from './company-profile';
function errorKind(error: unknown): string {
  if (error instanceof BodyReadError) return 'body-read';
  if (error instanceof ReferenceError) return 'reference';
  if (error instanceof TypeError) return 'type';
  if (error instanceof SyntaxError) return 'json-syntax';
  if (error instanceof RangeError) return 'range';
  return 'other';
}
/** This descriptor is only produced for the unauthenticated public setup GET, before any login request. */
function publicTransportFailure(error: unknown, company: VerifiedCompanyProfile | null): string {
  if (!(error instanceof Error)) return 'non-error-transport-failure';
  let text = error.message;
  if (company) {
    for (const value of [company.apiOrigin, new URL(company.apiOrigin).hostname]) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(escaped, 'gi'), '[origin]');
    }
  }
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[origin]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[address]')
    .replace(/\[[a-f\d:]+\](?::\d+)?/gi, '[address]')
    .replace(/(?:[a-f\d]{0,4}:){2,}[a-f\d]{0,4}/gi, '[address]').slice(0, 240);
}
export async function runSignInClientProbe(company: VerifiedCompanyProfile | null, publish: (value: string) => void): Promise<string> {
  const result: Record<string, unknown> = { marker: 'ONEHR_CLIENT_PROBE', realCredentialsUsed: false };
  let phase = 'runtime';
  let active = true;
  const emit = () => { if (active) publish(JSON.stringify({...result, phase})); };
  result.companyPresent = company !== null;
  result.runtimeConnections = runtimeConnections;
  emit();
  const work = async () => {
  try {
    result.configValid = configProblem() === null;
    result.decoderPresent = typeof TextDecoder === 'function';
    result.decoderWorks = new TextDecoder('utf-8', {fatal:true}).decode(new Uint8Array([79,75])) === 'OK';
    if (!company) { result.outcome = 'missing-company'; return; }
    phase = 'company-validation'; emit();
    const tracedFetch: typeof fetch = async (input, init) => {
      phase = 'company-fetch'; emit();
      const response = await nativeFetch(input, init);
      result.companyStatus = response.status;
      result.bodyPresent = response.body !== null;
      result.readerPresent = typeof response.body?.getReader === 'function';
      phase = 'company-body-or-metadata'; emit();
      return response;
    };
    await verifyCompanyServer(company, tracedFetch);
    if (!active) return;
    result.companyVerified = true;
    phase = 'invalid-login'; emit();
    const owner = beginSignIn();
    try {
      await internalAuthRequest('login', {organization: company.organization || 'aihr-test', username: '!diagnostic!', password: 'diagnostic-only'}, owner, async (input, init) => {
        phase = 'login-fetch'; emit();
        const response = await nativeFetch(input, init);
        result.loginStatus = response.status;
        phase = 'login-body-or-refusal'; emit();
        return response;
      });
      result.expectedInvalidLogin = false;
    } catch (error) {
      if (error instanceof InternalSignInError && error.code === 'invalidLogin') {
        result.expectedInvalidLogin = true;
      } else { throw error; }
    }
    result.outcome = result.expectedInvalidLogin ? 'pass' : 'unexpected';
  } catch (error) {
    result.outcome = 'fail'; result.phase = phase; result.errorKind = errorKind(error);
    if (phase === 'company-fetch') result.publicTransportFailure = publicTransportFailure(error, company);
    // No exception messages, bodies, endpoints, profiles or field values leave this function.
  }
  finally { emit(); }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work(), new Promise<void>(resolve => {
      timer = setTimeout(() => { result.outcome = 'diagnostic-timeout'; result.phase = phase; emit(); active = false; resolve(); }, 30_000);
    })]);
    const output = JSON.stringify({...result, phase});
    publish(output);
    return output;
  } finally { active = false; clearTimeout(timer); }
}
