import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { defaultPolicy, meritMatrixRows } from '../packs/rewards/model';

describe('179539d1 merit matrix reference row order', () => {
  it('lists rows SSTAR, STAR, SCORE, IMPRO, PIP whatever order the stored policy keys come back in', () => {
    const policy = defaultPolicy(2026);
    // Postgres jsonb returns object keys sorted by length then bytewise: the order the page showed before.
    const jsonbOrder = Object.fromEntries(['PIP', 'STAR', 'IMPRO', 'SCORE', 'SSTAR'].map(k => [k, policy.meritMatrix[k as keyof typeof policy.meritMatrix]]));
    expect(Object.keys(jsonbOrder)).toEqual(['PIP', 'STAR', 'IMPRO', 'SCORE', 'SSTAR']);
    const rows = meritMatrixRows(jsonbOrder as typeof policy.meritMatrix);
    expect(rows.map(([talent]) => talent)).toEqual(['SSTAR', 'STAR', 'SCORE', 'IMPRO', 'PIP']);
    expect(rows.map(([talent, values]) => values)).toEqual(['SSTAR', 'STAR', 'SCORE', 'IMPRO', 'PIP'].map(t => policy.meritMatrix[t as keyof typeof policy.meritMatrix]));
  });

  it('the Review tab Reference section renders its rows through meritMatrixRows, not the stored key order', () => {
    // 37f82412: the merit matrix moved from the page into the collapsed Reference section.
    const page = readFileSync('app/rewards/[unitId]/desk/review-details.tsx', 'utf8');
    const start = page.indexOf("t('meritMatrix')");
    expect(start).toBeGreaterThanOrEqual(0);
    const section = page.slice(start, start + 1500);
    expect(section.length).toBeGreaterThan(500);
    expect(section).toContain('meritMatrixRows(policy.meritMatrix)');
    expect(section).not.toContain('Object.entries(policy.meritMatrix)');
    expect(section).toMatch(/'below', 'within', 'above'/);
  });
});
