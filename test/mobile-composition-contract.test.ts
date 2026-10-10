import { describe, expect, it } from 'vitest';
import { composeMobileDesign, DEFAULT_MOBILE_DESIGN, legacyMobileDesign, mobileDesignTemplate, parseMobileDesign, type MobileDesignV2 } from '../lib/mobile-design';
import { newMobileBlock } from '../lib/mobile-composition';
const design = () => composeMobileDesign(DEFAULT_MOBILE_DESIGN);
describe('mobile visual composer contract and installed-client compatibility', () => {
  it('keeps all four distinct style directions valid in both themes and preserves the v1 projection', () => {
    const values = (['monolith', 'studio', 'editorial', 'vivid'] as const).map(name => mobileDesignTemplate(name));
    expect(new Set(values.map(d => JSON.stringify(d.composition))).size).toBe(4);
    for (const d of values) {
      expect(parseMobileDesign(d)).toEqual(d);
      expect(legacyMobileDesign(d).schemaVersion).toBe(1);
      expect(legacyMobileDesign(d)).not.toHaveProperty('composition');
      expect(parseMobileDesign(legacyMobileDesign(d))).toEqual(legacyMobileDesign(d));
    }
  });
  it('owns deeply nested snapshots and supports declared custom-screen links', () => {
    const d = design(); d.composition.pages.push({ id: 'benefits', title: 'Benefits', blocks: [newMobileBlock('text', 'intro')] });
    d.composition.pages[0].blocks.push({ ...newMobileBlock('action', 'open-benefits'), target: 'benefits' });
    d.composition.navigation.items.splice(1, 0, { target: 'benefits', label: 'Benefits', icon: 'grid' });
    const saved = parseMobileDesign(d) as MobileDesignV2;
    d.composition.pages[0].blocks[0].title = 'Changed'; d.composition.themes.light.bg = '#000000';
    expect(saved.composition.pages[0].blocks[0].title).toBe(''); expect(saved.composition.themes.light.bg).toBe('#f2f0eb');
    expect(DEFAULT_MOBILE_DESIGN).not.toHaveProperty('composition');
  });
  it.each([
    (d: MobileDesignV2) => { (d.composition as unknown as Record<string, unknown>).script = 'alert(1)'; },
    (d: MobileDesignV2) => { d.composition.pages[0].blocks[0].target = 'https://attacker.test'; },
    (d: MobileDesignV2) => { d.composition.pages[0].blocks[0].target = 'missing-screen'; },
    (d: MobileDesignV2) => { d.composition.pages[0].blocks.push(newMobileBlock('clock', 'duplicate-clock')); },
    (d: MobileDesignV2) => { d.composition.pages[0].blocks.push(newMobileBlock('text', 'welcome')); },
    (d: MobileDesignV2) => { d.composition.pages[0].blocks[0].body = 'x'.repeat(601); },
    (d: MobileDesignV2) => { d.composition.pages.push({ id: 'clock', title: '', blocks: [] }); },
    (d: MobileDesignV2) => { d.composition.pages[0].id = 'not-home'; },
    (d: MobileDesignV2) => { d.composition.typography.bodySize = NaN; },
    (d: MobileDesignV2) => { d.composition.layout.padding = 12.5; },
    (d: MobileDesignV2) => { d.composition.themes.dark.muted = d.composition.themes.dark.bg; },
    (d: MobileDesignV2) => { d.composition.themes.light.button = 'url(javascript:alert(1))'; },
    (d: MobileDesignV2) => { d.composition.navigation.items.reverse(); },
    (d: MobileDesignV2) => { (d as unknown as Record<string, unknown>).schemaVersion = '2'; },
  ])('refuses executable, inaccessible, unbound or malformed composition %#', mutate => {
    const d = design(); mutate(d); expect(() => parseMobileDesign(d)).toThrow('invalid_design');
  });
});
