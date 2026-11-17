/**
 * Recruitment slice 8 without a database: the public path matcher (including the shapes that must NOT be admitted), the
 * address and form rules, mobile normalisation, the visitor's language, HTML escaping, the client-address hash, the
 * content security policy, the bounded form body and the rendered pages. Every value is fictional.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAREERS_BODY_MAX_BYTES, careersJobPath, isCareersAddress, isCareersRoute } from '../lib/careers-route';
import { CAREERS_CSP, CAREERS_CSS, CAREERS_HEADERS, CAREERS_STYLE_HASH } from '../lib/careers-security';
import { careersApplicationsAccepted, careersClientHash, careersClientSubject, careersReadBudgetKey, CareersSourceUnavailable } from '../lib/careers-client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTICE_UPLOAD_PROXY_MAX_BYTES } from '../lib/notice-upload-policy';
import { PROFILE_ATTACHMENT_ACTION_BODY_LIMIT } from '../lib/profile-attachment';
import {
  careersPageCount, careersPageNumber, careersPublishMissing, normaliseCareersMobile, validateCareersApplication, validateCareersSettings,
  type CareersPublicJob, type CareersPublicPage,
} from '../packs/recruitment/service';
import { careersJobHtml, careersPageHtml, careersWords, chooseLocale, esc, fill, link, type CareersView } from '../app/careers/careers-html';
import { careersFileNameOk } from '../packs/recruitment/careers-model';
import { readCareersForm } from '../app/careers/careers-http';

const JOB = '0b4f5c0e-8a0c-4d3c-9a43-1f2e3d4c5b6a';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
afterEach(() => vi.unstubAllEnvs());

describe('the public path matcher admits exactly the careers page and job shapes', () => {
  it('admits the page (GET/HEAD) and the job (GET/HEAD/POST)', () => {
    for (const path of ['/careers/acme', '/careers/a1-b2', '/careers/abc', `/careers/${'a'.repeat(40)}`]) {
      expect(isCareersRoute(path, 'GET'), path).toBe(true);
      expect(isCareersRoute(path, 'HEAD'), path).toBe(true);
      expect(isCareersRoute(path, 'POST'), path).toBe(false);
    }
    for (const method of ['GET', 'HEAD', 'POST', 'post']) expect(isCareersRoute(careersJobPath('acme', JOB), method), method).toBe(true);
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) expect(isCareersRoute(careersJobPath('acme', JOB), method), method).toBe(false);
  });
  it('refuses every other shape, including dot segments, encoded characters and trailing segments', () => {
    const refused = [
      '/careers', '/careers/', '/careers/ab', `/careers/${'a'.repeat(41)}`, '/careers/-acme', '/careers/acme-', '/careers/Acme', '/careers/acme/',
      '/careers/acme/jobs', '/careers/acme/jobs/', `/careers/acme/jobs/${JOB.toUpperCase()}`, `/careers/acme/jobs/${JOB}/`, `/careers/acme/jobs/${JOB}/apply`,
      `/careers/acme/jobs/${JOB.slice(1)}`, '/careers/x/../admin', '/careers/../admin', '/careers/acme/../../admin', '/careers/acme%2Fjobs', '/careers/acme%2fadmin',
      `/careers/acme/jobs/%2e%2e`, '/careers/acme/admin', '/careers/acme.json', '/careers/acme;x', '//careers/acme', '/careersx/acme', '/careers/acme/jobs/1',
      '/admin', '/recruitment/settings', '/careers/ac_me', '/careers/acme%00', '/careers/acme\n',
    ];
    for (const path of refused) for (const method of ['GET', 'POST']) expect(isCareersRoute(path, method), `${method} ${JSON.stringify(path)}`).toBe(false);
    for (const value of ['ab', '-ab', 'ab-', 'AB', 'a b', 'a_b', 'a'.repeat(41), '', null, 3]) expect(isCareersAddress(value), String(value)).toBe(false);
    expect(isCareersAddress('a--b')).toBe(true);
  });
});

describe('HR settings rules', () => {
  it('checks the address format and the field lengths; empty fields are allowed until publishing', () => {
    expect(validateCareersSettings({ address: 'fictional-co', displayName: 'Fictional Co', headline: '', introduction: ' line 1\r\nline 2 ', notice: 'Notice' }))
      .toEqual({ ok: true, value: { address: 'fictional-co', displayName: 'Fictional Co', headline: null, introduction: 'line 1\nline 2', notice: 'Notice' } });
    expect(validateCareersSettings({})).toEqual({ ok: true, value: { address: null, displayName: null, headline: null, introduction: null, notice: null } });
    expect(validateCareersSettings({ address: 'Fictional_Co', displayName: 'x'.repeat(121), headline: 'h'.repeat(161), introduction: 'i'.repeat(4001), notice: 'n'.repeat(20001) }))
      .toEqual({ ok: false, fields: ['address', 'displayName', 'headline', 'introduction', 'notice'] });
    // Lengths count characters, not UTF-16 units.
    expect(validateCareersSettings({ displayName: '😀'.repeat(120) }).ok).toBe(true);
  });
  it('names what stops publishing', () => {
    expect(careersPublishMissing({ address: null, displayName: null, noticeVersion: null })).toEqual(['address', 'displayName', 'notice']);
    expect(careersPublishMissing({ address: 'a-b', displayName: 'X', noticeVersion: null })).toEqual(['notice']);
    expect(careersPublishMissing({ address: 'a-b', displayName: 'X', noticeVersion: 2 })).toEqual([]);
  });
});

describe('the application form rules', () => {
  const ok = { fullName: ' Fictional Applicant ', email: 'Fictional.Applicant@Example.TEST', mobile: '', message: '', consent: 'on', noticeVersion: '3', website: '' };
  it('accepts a valid form, normalises the e-mail and flags a filled honeypot', () => {
    expect(validateCareersApplication(ok)).toEqual({ ok: true, value: { fullName: 'Fictional Applicant', email: 'fictional.applicant@example.test', mobile: null, message: null, noticeVersion: 3, honeypot: false } });
    expect(validateCareersApplication({ ...ok, website: 'http://spam.example' })).toMatchObject({ ok: true, value: { honeypot: true } });
  });
  it('returns one message per field from what was typed', () => {
    expect(validateCareersApplication({ ...ok, fullName: '', email: '', consent: '' })).toEqual({ ok: false, fields: { fullName: 'required', email: 'required', consent: 'consent_required' } });
    expect(validateCareersApplication({ ...ok, fullName: 'n'.repeat(121), email: 'not-an-email', mobile: '12345', message: 'm'.repeat(1001) }))
      .toEqual({ ok: false, fields: { fullName: 'too_long', email: 'invalid', mobile: 'invalid', message: 'too_long' } });
    for (const email of ['a@b', 'a b@c.d', '@c.d', 'a@.d', 'a@b.', `${'a'.repeat(250)}@b.cd`]) expect(validateCareersApplication({ ...ok, email }).ok, email).toBe(false);
    // A missing or altered notice version is answered as "tick the box" (the page shows the current notice again).
    expect(validateCareersApplication({ ...ok, noticeVersion: 'x' })).toEqual({ ok: false, fields: { consent: 'consent_required' } });
    expect(validateCareersApplication({ ...ok, fullName: ['array'] as unknown as string })).toMatchObject({ ok: false, fields: { fullName: 'invalid' } });
  });
  it('normalises a mobile to 7–20 digits after removing spaces, "+", "-" and brackets', () => {
    expect(normaliseCareersMobile('+60 12-345 6789')).toBe('60123456789');
    expect(normaliseCareersMobile('(03) 1234 5678')).toBe('0312345678');
    expect(normaliseCareersMobile('1234567')).toBe('1234567');
    expect(normaliseCareersMobile('9'.repeat(20))).toBe('9'.repeat(20));
    for (const bad of ['123456', '9'.repeat(21), '12a4567890', '012.345.6789', '+60 12 345 6789 ext 2', '٠١٢٣٤٥٦٧٨']) expect(normaliseCareersMobile(bad), bad).toBeNull();
  });
  it('reads the page number defensively', () => {
    expect(careersPageNumber('2')).toBe(2);
    for (const v of [null, '', '0', '-1', '1.5', 'x', '01']) expect(careersPageNumber(v), String(v)).toBe(1);
    expect(careersPageNumber('99999')).toBe(10000);
    expect([careersPageCount(0), careersPageCount(30), careersPageCount(31)]).toEqual([1, 1, 2]);
  });
});

describe('language, escaping and links', () => {
  it('chooses ?lang= first, then Accept-Language by quality, else English', () => {
    expect(chooseLocale('ms', 'zh-CN')).toEqual({ locale: 'ms', explicit: true });
    expect(chooseLocale('xx', 'zh-CN,zh;q=0.9,en;q=0.8')).toEqual({ locale: 'zh', explicit: false });
    expect(chooseLocale(null, 'fr-FR, ms-MY;q=0.5, ta;q=0.7')).toEqual({ locale: 'ta', explicit: false });
    expect(chooseLocale(null, 'ta;q=0, th;q=0.4')).toEqual({ locale: 'th', explicit: false });
    expect(chooseLocale(null, 'vi-VN')).toEqual({ locale: 'vi', explicit: false });
    for (const header of [null, '', 'fr, de;q=0.9', 'en-GB', '*;q=1']) expect(chooseLocale(null, header).locale, String(header)).toBe('en');
    expect(chooseLocale('<script>', null)).toEqual({ locale: 'en', explicit: false });
  });
  it('escapes markup characters, and message values are escaped after the message', () => {
    expect(esc(`<script>alert("x")</script>&'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;');
    expect(fill('Hello {name} & {missing}', { name: '<b>Fictional</b>' })).toBe('Hello &lt;b&gt;Fictional&lt;/b&gt; &amp; {missing}');
  });
  it('keeps an explicitly chosen language in links and nothing else', () => {
    expect(link({ locale: 'th', explicit: true }, '/careers/acme', { q: 'data analyst', page: 2, location: null })).toBe('/careers/acme?q=data+analyst&page=2&lang=th');
    expect(link({ locale: 'th', explicit: false }, '/careers/acme')).toBe('/careers/acme');
  });
});

describe('the client address is only ever a keyed hash', () => {
  it('counts an IPv4 address whole, an IPv6 address by its /64, and an IPv4-mapped address as IPv4', () => {
    expect(careersClientSubject('203.0.113.7')).toBe('v4:203.0.113.7');
    expect(careersClientSubject('2001:db8:1:2:aaaa::1')).toBe('v6:2001:0db8:0001:0002');
    expect(careersClientSubject('2001:DB8:1:2:ffff:ffff:ffff:ffff')).toBe('v6:2001:0db8:0001:0002');
    expect(careersClientSubject('::ffff:203.0.113.7')).toBe('v4:203.0.113.7');
    expect(() => careersClientSubject('not an address')).toThrow();
  });
  it('refuses without a verified source in a production server, uses a development-only bucket under next dev, and an HMAC per verified source', () => {
    vi.stubEnv('AUTH_SESSION_KEY', 'b'.repeat(64));
    vi.stubEnv('AIHR_TRUST_REQUEST_SOURCE', '');
    vi.stubEnv('NODE_ENV', 'production');
    const req = (source?: string) => new Request('https://careers.fixture.test/', { headers: source ? { 'x-aihr-request-source': source, 'x-forwarded-for': '198.51.100.1' } : { 'x-forwarded-for': '198.51.100.2' } });
    // No shared installation-wide bucket: no verified source, no submissions (and no per-source read budget).
    expect(() => careersClientHash(req('203.0.113.7'))).toThrow(CareersSourceUnavailable);
    expect(() => careersClientHash(req())).toThrow(CareersSourceUnavailable);
    expect(careersApplicationsAccepted()).toBe(false);
    expect(careersReadBudgetKey(req('203.0.113.7'))).toBeNull();
    for (const mode of ['test', '']) {
      vi.stubEnv('NODE_ENV', mode);
      expect(() => careersClientHash(req()), mode).toThrow(CareersSourceUnavailable);
    }
    // next dev only: one development bucket, forwarding headers still ignored.
    vi.stubEnv('NODE_ENV', 'development');
    const dev = careersClientHash(req('203.0.113.7'));
    expect(dev.verified).toBe(false);
    expect(careersClientHash(req()).hash).toBe(dev.hash);
    expect(careersApplicationsAccepted()).toBe(true);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AIHR_TRUST_REQUEST_SOURCE', '1');
    expect(careersApplicationsAccepted()).toBe(true);
    const a = careersClientHash(req('203.0.113.7'));
    const b = careersClientHash(req('203.0.113.8'));
    expect(a.verified).toBe(true);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toBe(b.hash);
    expect(a.hash).not.toBe(dev.hash);
    expect(careersClientHash(req('203.0.113.7')).hash).toBe(a.hash);
    expect(careersReadBudgetKey(req('203.0.113.7'))).toMatch(/^[0-9a-f]{64}$/);
    expect(careersReadBudgetKey(req('203.0.113.7'))).not.toBe(a.hash);
    // Not a plain digest of the address: a key is needed to link a hash to an address.
    expect(a.hash).not.toBe(createHash('sha256').update('v4:203.0.113.7').digest('hex'));
    expect(JSON.stringify(a)).not.toContain('203.0.113.7');
    // A different server secret gives different hashes; trust without a source header, or a malformed one, refuses.
    vi.stubEnv('AUTH_SESSION_KEY', 'c'.repeat(64));
    expect(careersClientHash(req('203.0.113.7')).hash).not.toBe(a.hash);
    expect(() => careersClientHash(req())).toThrow(CareersSourceUnavailable);
    expect(() => careersClientHash(req('203.0.113.7, 203.0.113.8'))).toThrow(CareersSourceUnavailable);
  });
  it('the development exception is written so a production build removes it', () => {
    // Next replaces the literal process.env.NODE_ENV with "production" when it builds the server; a value read through a
    // variable would survive. The exception must therefore be this exact literal comparison.
    const source = readFileSync(join(ROOT, 'lib/careers-client.ts'), 'utf8');
    expect(source).toContain("const developmentServer = () => process.env.NODE_ENV === 'development';");
    expect(source.match(/NODE_ENV/g)).toHaveLength(2);
  });
});

describe('control characters', () => {
  const ok = { fullName: 'Fictional Applicant', email: 'a@example.test', mobile: '', message: '', consent: 'on', noticeVersion: '1', website: '' };
  it('are refused in every form field with a field message; line breaks stay allowed in the message', () => {
    for (const [field, value] of [['fullName', 'Fictional\u0000Name'], ['fullName', 'Fictional\u007fName'], ['email', 'a\u0000@example.test'],
      ['mobile', '0123\u0000456789'], ['message', 'nul\u0000'], ['message', 'tab\there'], ['message', 'c1\u0085']] as const) {
      const r = validateCareersApplication({ ...ok, [field]: value });
      expect(r, `${field} ${JSON.stringify(value)}`).toEqual({ ok: false, fields: { [field]: 'invalid' } });
    }
    expect(validateCareersApplication({ ...ok, message: 'one\r\ntwo\nthree' })).toMatchObject({ ok: true, value: { message: 'one\ntwo\nthree' } });
    for (const name of ['cv\u0000.pdf', 'cv\u202efdp.exe', 'cv\u2066.pdf', '../cv.pdf', 'a\\cv.pdf', ' ', 'cv\n.pdf']) expect(careersFileNameOk(name), JSON.stringify(name)).toBe(false);
    expect(careersFileNameOk('Fictional résumé (2026).pdf')).toBe(true);
  });
  it('are refused in the HR settings text (line breaks allowed in the introduction and notice)', () => {
    expect(validateCareersSettings({ displayName: 'X\u0000', headline: 'H\u0007', introduction: 'a\u0000', notice: 'n\u001b' }))
      .toEqual({ ok: false, fields: ['displayName', 'headline', 'introduction', 'notice'] });
    expect(validateCareersSettings({ introduction: 'one\ntwo', notice: 'one\r\ntwo' }).ok).toBe(true);
  });
});

describe('the careers web server step (deploy/internal-auth)', () => {
  const read = (name: string) => readFileSync(join(ROOT, 'deploy/internal-auth', name), 'utf8');
  const directives = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  it('overwrites the request source from the connection, like the other source snippets, and bounds the careers location', () => {
    const careers = directives(read('abuse-careers-location.conf'));
    for (const name of ['abuse-auth-location.conf', 'abuse-mobile-location.conf', 'abuse-careers-location.conf']) {
      const lines = directives(read(name));
      // Exactly one source header, set (overwritten) from $remote_addr — never appended to or taken from the client.
      expect(lines.filter((l) => /x-aihr-request-source/i.test(l)), name).toEqual(['proxy_set_header X-Aihr-Request-Source $remote_addr;']);
      expect(lines.some((l) => /x-forwarded-for|\$http_x_aihr|\$proxy_add_x_forwarded_for/i.test(l)), name).toBe(false);
    }
    expect(careers).toEqual(expect.arrayContaining([
      'limit_req zone=aihr_careers_source burst=20 nodelay;', 'limit_req zone=aihr_careers_post burst=5 nodelay;', 'limit_req_status 429;',
      'limit_conn aihr_careers_connections 10;', 'limit_conn_status 429;', 'client_max_body_size 11m;', 'client_body_timeout 30s;',
    ]));
    // Careers never uses the sign-in/mobile connection allowance, and the snippet names no regex location.
    expect(careers.some((l) => l.includes('aihr_source_connections'))).toBe(false);
    expect(read('abuse-careers-location.conf')).toContain('location ^~ /careers/');
    expect(read('abuse-careers-location.conf')).not.toContain('location ~');
    // The zones it uses are defined once in the http-level file; the POST zone is keyed only for POST requests.
    const http = directives(read('abuse-http.conf'));
    expect(http).toEqual(expect.arrayContaining([
      'limit_req_zone $binary_remote_addr zone=aihr_careers_source:10m rate=5r/s;', 'map $request_method $aihr_careers_post_source {',
      'POST    $binary_remote_addr;', 'default "";', 'limit_req_zone $aihr_careers_post_source zone=aihr_careers_post:10m rate=1r/m;',
      'limit_conn_zone $binary_remote_addr zone=aihr_careers_connections:10m;',
    ]));
    for (const zone of ['zone=aihr_source_connections', 'zone=aihr_careers_connections', 'zone=aihr_careers_post:', 'zone=aihr_careers_source:']) {
      expect(http.filter((l) => l.includes(zone)), zone).toHaveLength(1);
    }
    // 11 MB at the proxy equals the application's own limit.
    expect(11 * 1024 * 1024).toBe(CAREERS_BODY_MAX_BYTES);
  });
  it('ships the hourly owner-side prune in the same form as the authentication prune, and documents the step', () => {
    const unit = read('aihr-recruitment-careers-prune.service');
    expect(unit).toContain('ExecStart=/usr/bin/psql service=aihr_auth_maintenance -v ON_ERROR_STOP=1 -c "select app.recruitment_careers_prune()"');
    expect(unit).toContain('ConditionPathExists=/etc/aihr/auth-maintenance.pg_service.conf');
    for (const hardening of ['NoNewPrivileges=true', 'ProtectSystem=strict', 'PrivateTmp=true', 'UMask=0077']) expect(unit).toContain(hardening);
    expect(read('aihr-recruitment-careers-prune.timer')).toContain('Unit=aihr-recruitment-careers-prune.service');
    const readme = read('README.md');
    for (const text of ['abuse-careers-location.conf', 'aihr-recruitment-careers-prune', 'AIHR_TRUST_REQUEST_SOURCE=1', 'CF-Connecting-IP', 'ALL THREE location snippets',
      'This one switch also changes sign-in and the\n   mobile API']) expect(readme).toContain(text);
  });
});
describe('response policy and the bounded body', () => {
  it('allows only the one hashed stylesheet, same-origin form posts and no framing; nothing from any origin', () => {
    expect(CAREERS_STYLE_HASH).toBe(`sha256-${createHash('sha256').update(CAREERS_CSS).digest('base64')}`);
    expect(CAREERS_CSP).toBe(`default-src 'none'; style-src '${CAREERS_STYLE_HASH}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    expect(CAREERS_CSP).not.toMatch(/unsafe|https?:|\*/);
    expect(CAREERS_CSS).not.toMatch(/url\(|@import|https?:/);
    expect(CAREERS_HEADERS).toEqual({
      'content-security-policy': CAREERS_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow',
      'cache-control': 'private, no-store', 'x-frame-options': 'DENY',
    });
  });
  it('keeps the framework body buffer above the careers limit, so an allowed form is never truncated', () => {
    expect(Math.max(NOTICE_UPLOAD_PROXY_MAX_BYTES, PROFILE_ATTACHMENT_ACTION_BODY_LIMIT + 1, CAREERS_BODY_MAX_BYTES + 1)).toBeGreaterThan(CAREERS_BODY_MAX_BYTES);
    expect(CAREERS_BODY_MAX_BYTES).toBe(11 * 1024 * 1024);
  });
  it('refuses an over-limit body by its declared length or by counting the stream, before parsing', async () => {
    const declared = new Request('https://careers.fixture.test/', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(CAREERS_BODY_MAX_BYTES + 1) }, body: 'x' });
    expect(await readCareersForm(declared)).toBe('too_large');
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; if (pulled > 20) c.close(); else c.enqueue(chunk); } });
    const streamed = new Request('https://careers.fixture.test/', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: stream, duplex: 'half' } as RequestInit);
    expect(await readCareersForm(streamed)).toBe('too_large');
    expect(pulled).toBeLessThanOrEqual(13);
    expect(await readCareersForm(new Request('https://careers.fixture.test/', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'a=b' }))).toBe('malformed');
    const form = new FormData();
    form.set('fullName', 'Fictional Applicant');
    const parsed = await readCareersForm(new Request('https://careers.fixture.test/', { method: 'POST', body: form }));
    expect(parsed instanceof FormData && parsed.get('fullName')).toBe('Fictional Applicant');
  });
});

describe('rendering escapes every company and job string and loads nothing', () => {
  const hostile = '<script>alert(1)</script>"onmouseover="x';
  const view = async (locale: 'en' | 'zh' = 'en', explicit = false): Promise<CareersView> => ({ locale, explicit, origin: 'https://careers.fixture.test', ...(await careersWords(locale)) });
  const page: CareersPublicPage = {
    displayName: hostile, headline: hostile, introduction: `${hostile}\nline two`, locations: [hostile], employmentTypes: ['full_time'], total: 31, page: 1, pageSize: 30,
    jobs: [{ id: JOB, title: hostile, jobNumber: 'MJ000001', employmentType: 'full_time', workLocation: hostile, postedAt: '2026-11-10T16:30:00.000Z' }],
  };
  const job: CareersPublicJob = { displayName: hostile, job: { ...page.jobs[0], description: hostile }, notice: { version: 2, body: hostile } };
  it('the careers page: no raw markup from data, no script, the exact stylesheet, Kuala Lumpur posted date', async () => {
    const html = careersPageHtml(await view(), 'acme', page, { query: hostile, location: hostile, employmentType: '', page: 1 });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('"onmouseover="');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;onmouseover=&quot;x');
    expect(html).toContain(`<style>${CAREERS_CSS}</style>`);
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).not.toMatch(/\bsrc=|<link|<img|<iframe|https?:\/\/(?!careers\.fixture\.test)/);
    // 16:30 UTC on 10 November is 00:30 on 11 November in Kuala Lumpur.
    expect(html).toContain('Posted on Nov 11, 2026');
    expect(html).toContain('Page 1 of 2');
    // Paging keeps the filters (escaped in the attribute) and adds no language the visitor did not choose.
    expect(html).toMatch(/href="\/careers\/acme\?q=[^"]+&amp;location=[^"]+&amp;page=2">Next</);
  });
  it('the job page: the form posts back to the same path, carries the notice version, hides the honeypot and offers a read-only link', async () => {
    const html = careersJobHtml(await view('zh', true), 'acme', job, { values: { fullName: hostile, email: '', mobile: '', message: hostile, consent: true }, errors: { email: 'required' } });
    expect(html).not.toContain('<script');
    expect(html).toContain(`action="/careers/acme/jobs/${JOB}?lang=zh"`);
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('<input type="hidden" name="noticeVersion" value="2">');
    expect(html).toMatch(/<div class="trap" aria-hidden="true">[\s\S]*name="website" tabindex="-1"/);
    expect(html).toContain(`<input type="url" id="share" readonly value="https://careers.fixture.test/careers/acme/jobs/${JOB}"`);
    expect(html).toContain('<html lang="zh">');
    expect(html).toContain('id="email-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('checked');
    const closed = careersJobHtml(await view(), 'acme', job, undefined, false);
    expect(closed).not.toContain('<form method="post"');
    expect(closed).toContain('Online applications are not available right now.');
  });
});
