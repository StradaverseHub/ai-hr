import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import en from '../messages/en.json';
import { EntitlementRecalcHistory } from '../components/leave/entitlement-recalc-history';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => {
    const value = (key: string): unknown => `${namespace}.${key}`.split('.').reduce<unknown>((node, part) =>
      node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined, en);
    const t = (key: string) => {
      const result = value(key);
      if (typeof result !== 'string') throw new Error(`MISSING_MESSAGE: ${namespace}.${key}`);
      return result;
    };
    t.has = (key: string) => typeof value(key) === 'string';
    return t;
  },
}));

type Row = Parameters<typeof EntitlementRecalcHistory>[0]['rows'][number];
const row: Row = {
  id: 'fictional-history', leaveTypeId: 'fictional-type', leaveTypeName: 'Fictional annual leave',
  previousEntitlement: 10, newEntitlement: 12, delta: 2, reason: 'uncatalogued_historical_reason',
  effectiveOn: '2025-06-02', changeEffectiveOn: '2025-06-01', tookEffectOn: '2025-06-01',
  previousGradeId: null, newGradeId: 'fictional-grade', previousGradeName: null,
  newGradeName: 'Fictional grade', gradeChanged: true, createdAt: '2025-06-02T00:00:00Z',
};

describe('retained read-only entitlement recalculation history', () => {
  it('renders an explicit empty history rather than losing the section', async () => {
    const html = renderToStaticMarkup(await EntitlementRecalcHistory({ rows: [] }));
    expect(html).toContain(en.people.detail.recalcHistoryTitle);
    expect(html).toContain(en.people.detail.recalcHistoryEmpty);
    expect(html).not.toContain('<form');
  });

  it('retains dated facts, grade uncertainty and raw unknown reasons without missing translations', async () => {
    const html = renderToStaticMarkup(await EntitlementRecalcHistory({ rows: [row] }));
    expect(html).toContain('01-Jun-2025');
    expect(html).toContain('Fictional annual leave');
    expect(html).toContain('— → Fictional grade');
    expect(html).toContain('uncatalogued_historical_reason');
    expect(html).not.toContain('recalcReason.');
    expect(html).toContain('+2');
    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain('<form');
  });
});
