/** Temporary review-only diagnostic. Fixed invalid syntax never reaches account lookup. */
import { fetch as nativeFetch } from 'expo/fetch';
import { beginSignIn } from './auth';
import { configProblem } from './config';
import { verifyCompanyServer } from './connection-probe';
import { internalAuthRequest, InternalSignInError } from './internal-auth';
import { readBoundedBody, BodyReadError } from '../../lib/bounded-body';
import type { VerifiedCompanyProfile } from './company-profile';
function errorKind(error: unknown): string {
  if (error instanceof BodyReadError) return 'body-read';
  if (error instanceof ReferenceError) return 'reference';
  if (error instanceof TypeError) return 'type';
  if (error instanceof SyntaxError) return 'json-syntax';
  if (error instanceof RangeError) return 'range';
  return 'other';
}
export async function runSignInClientProbe(company: VerifiedCompanyProfile): Promise<string> {
  const result: Record<string, unknown> = { marker: 'ONEHR_CLIENT_PROBE', realCredentialsUsed: false };
  let phase = 'runtime';
  try {
    result.configValid = configProblem() === null;
    result.decoderPresent = typeof TextDecoder === 'function';
    result.decoderWorks = new TextDecoder('utf-8', {fatal:true}).decode(new Uint8Array([79,75])) === 'OK';
    phase = 'company-validation';
    const tracedFetch: typeof fetch = async (input, init) => {
      phase = 'company-fetch';
      const response = await nativeFetch(input, init);
      result.companyStatus = response.status;
      result.bodyPresent = response.body !== null;
      result.readerPresent = typeof response.body?.getReader === 'function';
      phase = 'company-body-or-metadata';
      return response;
    };
    await verifyCompanyServer(company, tracedFetch);
    result.companyVerified = true;
    phase = 'invalid-login';
    const owner = beginSignIn();
    try {
      await internalAuthRequest('login', {organization: company.organization || 'aihr-test', username: '!diagnostic!', password: 'diagnostic-only'}, owner, async (input, init) => {
        phase = 'login-fetch';
        const response = await nativeFetch(input, init);
        result.loginStatus = response.status;
        phase = 'login-body-or-refusal';
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
    // No exception messages, bodies, endpoints, profiles or field values leave this function.
  }
  const output = JSON.stringify(result);
  console.warn('ONEHR_CLIENT_PROBE ' + output);
  return output;
}
