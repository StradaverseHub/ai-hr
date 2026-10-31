import {afterEach,it,expect,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {isLetterVerificationRoute,letterVerificationUrl} from '../lib/letter-verification';
const verify=vi.hoisted(()=>vi.fn());
vi.mock('../core/letter-verification',()=>({verifyPublicLetter:verify}));
import {GET} from '../app/(app)/letters/verify/[token]/route';
const token='A'.repeat(43);
afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks();});
it('bypasses authentication only for the exact opaque verification route',()=>{
 expect(isLetterVerificationRoute('/letters/verify/'+token)).toBe(true);for(const path of ['/letters','/letters/settings','/letters/verify','/letters/verify/'+token+'/download','/letters/verify/'+token+'x','/letters/verify/../settings'])expect(isLetterVerificationRoute(path)).toBe(false);
});
it('uses the configured HTTPS origin and rejects absent or insecure origins',()=>{
 vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NEXT_PUBLIC_WORKOS_REDIRECT_URI','https://letters.fixture.test/callback');expect(letterVerificationUrl(token,'ta')).toBe(`https://letters.fixture.test/letters/verify/${token}?lang=ta`);
 vi.stubEnv('NEXT_PUBLIC_WORKOS_REDIRECT_URI','http://unsafe.fixture.test/callback');expect(()=>letterVerificationUrl(token,'en')).toThrow('HTTPS');vi.stubEnv('NEXT_PUBLIC_WORKOS_REDIRECT_URI','');expect(()=>letterVerificationUrl(token,'en')).toThrow('configured public origin');
});
it.each(['en','ms','zh','ta','th','vi'])('returns only localized status with private non-cacheable headers for %s',async lang=>{
 verify.mockResolvedValue('valid');const response=await GET(new NextRequest(`https://letters.fixture.test/letters/verify/${token}?lang=${lang}`),{params:Promise.resolve({token})}),body=await response.text();
 expect(response.status).toBe(200);expect(body).toContain(`lang="${lang}"`);expect(body).not.toContain(token);expect(body).not.toContain('employee');expect(response.headers.get('cache-control')).toContain('no-store');expect(response.headers.get('referrer-policy')).toBe('no-referrer');expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
});
it('does not expose errors, tokens or injected language content and returns retry guidance for rate limits',async()=>{
 verify.mockResolvedValue('limited');let response=await GET(new NextRequest(`https://letters.fixture.test/letters/verify/${token}?lang=${encodeURIComponent('<script>injected</script>')}`),{params:Promise.resolve({token})});expect(response.status).toBe(429);expect(response.headers.get('retry-after')).toBe('60');expect(await response.text()).not.toContain('injected');
 verify.mockRejectedValue(new Error('SQL secret diagnostic'));response=await GET(new NextRequest('https://letters.fixture.test/letters/verify/'+token),{params:Promise.resolve({token})});expect(response.status).toBe(503);expect(await response.text()).not.toContain('SQL secret');
});
