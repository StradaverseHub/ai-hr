import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import type { AnalyticsRow, AnalyticsUnit } from '../packs/rewards/analytics-model';
import { analyticsTotals } from '../packs/rewards/analytics-model';

const ports = vi.hoisted(() => ({ load: vi.fn(), pdf: vi.fn() }));
vi.mock('../app/rewards/analytics/report', () => ({ loadRewardsAnalytics: ports.load }));
vi.mock('../packs/rewards/setup-pdf', () => ({ renderRewardSetupPdf: ports.pdf }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en-MY',
  getTranslations: async () => (key: string) => key,
}));

import { GET } from '../app/rewards/analytics/export/route';

const digest = 'a'.repeat(64);
const unit: AnalyticsUnit = {
  id: 'review-a', cycleId: 'cycle-a', cycle: 'Fictional annual review', year: 2026,
  companyId: 'company-a', company: 'Example Engineering', businessUnitId: 'bu-a', unit: 'Operations',
  groupId: 'group-a', groupName: 'Example Group', uploaded: false, branchFactors: false,
  people: 1, blockers: 0, poolCents: 400000, canSeePat: false, canOpenReview: true, patAchievement: 1.2345,
};
const visible: AnalyticsRow = {
  id: 'record-a', unitId: unit.id, name: '=2+2', employeeCode: 'E001', grade: '15', talent: 'STAR', performance: 'AE',
  department: null, beforeCents: 400000, afterCents: 440000, meritCents: 40000, promotionCents: 0, specialCents: 0,
  beforeRange: [320000, 420000, 520000], afterRange: [320000, 420000, 520000],
  promoted: false, incrementRun: true, excludedByPayWindow: false, bonusEligible: true,
  bonusBasicCents: 400000, bonusCents: 175000, lumpCents: 10000, pooled: true, exceptions: 0, blockers: 0,
};

function report(view: 'salary' | 'bonus' = 'bonus') {
  return {
    filters: { view, basis: 'annual', breakdown: 'unit' }, digest, reconciled: true,
    selected: [unit], rows: [visible], totals: analyticsTotals([visible]),
    protectedIncluded: true, protectedWithheld: false,
  };
}

const request = (format: string, extra = '') =>
  new Request('https://example.test/rewards/analytics/export?format=' + format + '&digest=' + digest + extra);

beforeEach(() => {
  vi.resetAllMocks();
  ports.load.mockResolvedValue(report());
  ports.pdf.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
});

describe('Rewards Analytics private exports', () => {
  it('rejects invalid or duplicated input before loading authorised data', async () => {
    expect((await GET(request('csv'))).status).toBe(400);
    expect((await GET(request('xlsx', '&digest=' + digest))).status).toBe(400);
    expect(ports.load).not.toHaveBeenCalled();
  });

  it('refuses revoked scope, stale totals and rows outside selected reviews', async () => {
    ports.load.mockRejectedValueOnce(new Error('Not authorised'));
    expect((await GET(request('pdf'))).status).toBe(403);
    ports.load.mockResolvedValueOnce({ ...report(), digest: 'b'.repeat(64) });
    expect((await GET(request('pdf'))).status).toBe(409);
    ports.load.mockResolvedValueOnce({ ...report(), reconciled: false });
    expect((await GET(request('xlsx'))).status).toBe(409);
    ports.load.mockResolvedValueOnce({ ...report(), rows: [{ ...visible, unitId: 'not-selected' }] });
    expect((await GET(request('xlsx'))).status).toBe(409);
    expect(ports.pdf).not.toHaveBeenCalled();
  });

  it('writes authorised details as cells, keeps cycle payouts fixed and omits restricted PAT', async () => {
    const response = await GET(request('xlsx', '&basis=annual&review=review-a&view=bonus'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Content-Type')).toContain('spreadsheetml');
    const book = XLSX.read(await response.arrayBuffer());
    const sheet = book.Sheets[book.SheetNames[0]];
    const [row] = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
    expect(row).toMatchObject({
      'Salary basis': 'annual', Company: unit.company, Cycle: unit.cycle, Name: visible.name,
      'Bonus basic (MYR)': 48000, 'Bonus (MYR, cycle payout)': 1750, 'Lump sum (MYR, cycle payout)': 100,
    });
    expect(row).not.toHaveProperty('PAT achievement (%)');
    expect(Object.values(sheet).some(cell => cell && typeof cell === 'object' && 'f' in cell)).toBe(false);
  });

  it('prints the selected view, date, scope and protected summary without naming staff', async () => {
    ports.load.mockResolvedValueOnce(report('salary'));
    const response = await GET(request('pdf', '&basis=annual&view=salary'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    const [title, lines] = ports.pdf.mock.calls[0] as [string, string[]];
    const rendered = lines.join('\n');
    expect(title).toContain('salary');
    expect(rendered).toContain('Cycle · Fictional annual review');
    expect(rendered).toContain('Scope · Example Engineering / Operations');
    expect(rendered).toMatch(/Date · \d{4}-\d{2}-\d{2}/);
    expect(rendered).toContain('Salary basis · annual');
    expect(rendered).toContain('Summary totals include protected staff');
    expect(rendered).not.toContain(visible.name);
  });
});
