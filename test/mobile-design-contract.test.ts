import { describe, expect, it } from 'vitest';
import { DEFAULT_MOBILE_DESIGN, MOBILE_ACCENTS, mobilePalette, parseMobileDesign, resolveMobileDesign } from '../lib/mobile-design';
import { MobileDesignResponse } from '../lib/mobile-api/contract';

describe('shared tenant mobile presentation contract', () => {
  it('rejects executable content, remote assets, policy changes, omissions and unsupported versions', () => {
    for (const value of [null, [], { ...DEFAULT_MOBILE_DESIGN, permission: 'super_admin' },
      { ...DEFAULT_MOBILE_DESIGN, schemaVersion: 2 }, { ...DEFAULT_MOBILE_DESIGN, logo: 'https://other-tenant.test/logo' },
      { ...DEFAULT_MOBILE_DESIGN, logo: 'data:image/svg+xml;base64,PHN2Zz4=' }, { ...DEFAULT_MOBILE_DESIGN, brandName: 'a\nscript' },
      { ...DEFAULT_MOBILE_DESIGN, homeOrder: ['clock', 'clock', 'leave', 'team'] },
      { ...DEFAULT_MOBILE_DESIGN, navigationOrder: ['requests'] }, { ...DEFAULT_MOBILE_DESIGN, accent: 'url(javascript:alert(1))' }]) {
      expect(() => parseMobileDesign(value)).toThrow('invalid_design');
    }
    expect(resolveMobileDesign({ schemaVersion: 999 })).toEqual(DEFAULT_MOBILE_DESIGN);
    const owned = parseMobileDesign(DEFAULT_MOBILE_DESIGN); owned.homeOrder.reverse();
    expect(DEFAULT_MOBILE_DESIGN.homeOrder).toEqual(['clock', 'tasks', 'leave', 'team']);
  });
  it('accepts a bounded PNG but refuses oversized decoded raster headers', () => {
    const header = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(header); header.writeUInt32BE(13,8); header.write('IHDR',12); header.writeUInt32BE(96,16); header.writeUInt32BE(96,20);
    const logo = () => 'data:image/png;base64,' + header.toString('base64');
    expect(parseMobileDesign({ ...DEFAULT_MOBILE_DESIGN, logo: logo() }).logo).toBe(logo());
    header.writeUInt32BE(100000,16); expect(() => parseMobileDesign({ ...DEFAULT_MOBILE_DESIGN, logo: logo() })).toThrow();
  });
  it('keeps every preset and theme readable, including the slider thumb', () => {
    const luminance = (hex: string) => {
      const c = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
      return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
    };
    const ratio = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
    for (const accent of Object.keys(MOBILE_ACCENTS) as (keyof typeof MOBILE_ACCENTS)[]) {
      for (const appearance of ['light', 'dark'] as const) {
        const p = mobilePalette({ ...DEFAULT_MOBILE_DESIGN, accent }, appearance);
        expect(ratio(p.text, p.bg)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(p.muted, p.bg)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(p.accent, p.bg)).toBeGreaterThanOrEqual(4.5);
      }
      expect(ratio(MOBILE_ACCENTS[accent].button, MOBILE_ACCENTS[accent].onButton)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('does not allow a response with unknown design or an arbitrary tenant identity', () => {
    expect(MobileDesignResponse.safeParse({ tenantId: 'tenant', revision: 1, publishedAt: '', config: DEFAULT_MOBILE_DESIGN }).success).toBe(false);
    expect(MobileDesignResponse.safeParse({ tenantId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', revision: 1, publishedAt: '', config: { ...DEFAULT_MOBILE_DESIGN, rules: {} } }).success).toBe(false);
  });
});
