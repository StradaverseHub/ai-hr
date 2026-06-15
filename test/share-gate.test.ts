import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware';

const req = (auth?: string) =>
  new NextRequest('http://localhost/people', auth ? { headers: { authorization: auth } } : undefined);
const basic = (pass: string) => 'Basic ' + Buffer.from(`demo:${pass}`).toString('base64');

describe('share gate (middleware.ts)', () => {
  // Each test controls SHARE_PASSWORD explicitly — don't inherit it from the ambient env (.env.local,
  // which a hosting setup may populate and vitest loads).
  beforeEach(() => {
    delete process.env.SHARE_PASSWORD;
  });
  afterEach(() => {
    delete process.env.SHARE_PASSWORD;
  });

  it('is a no-op when SHARE_PASSWORD is unset (normal dev)', () => {
    expect(middleware(req()).status).not.toBe(401);
  });

  it('challenges with 401 when gated and no credentials', () => {
    process.env.SHARE_PASSWORD = 'sekret';
    const res = middleware(req());
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Basic');
  });

  it('rejects a wrong password', () => {
    process.env.SHARE_PASSWORD = 'sekret';
    expect(middleware(req(basic('nope'))).status).toBe(401);
  });

  it('lets the correct password through (any username)', () => {
    process.env.SHARE_PASSWORD = 'sekret';
    expect(middleware(req(basic('sekret'))).status).not.toBe(401);
  });
});
