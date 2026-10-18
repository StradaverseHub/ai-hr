import { describe, expect, it } from 'vitest';
import config from '../next.config';
import { PHASE_PRODUCTION_SERVER } from 'next/constants';

describe('camera permission response policy', () => {
  it('permits first-party attendance capture without granting other pages camera or microphone', async () => {
    const resolved = config(PHASE_PRODUCTION_SERVER);
    const rules = await resolved.headers!();
    const defaults = rules.find(rule => rule.source === '/:path*')!.headers;
    const clockRules = rules.filter(rule => rule.source === '/attendance/clock');
    expect(clockRules).toHaveLength(1);
    expect(defaults.find(header => header.key === 'Permissions-Policy')?.value).toBe('camera=(), microphone=(), geolocation=(self)');
    expect(clockRules[0].headers.find(header => header.key === 'Permissions-Policy')?.value).toBe('camera=(self), microphone=(), geolocation=(self)');
    expect(rules.filter(rule => rule.headers.some(header => header.key === 'Permissions-Policy' && header.value.includes('camera=(self)'))).map(rule => rule.source)).toEqual(['/attendance/clock']);
  });
});
