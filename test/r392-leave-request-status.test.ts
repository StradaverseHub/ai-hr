/**
 * r392 · e6712304 — My Leave › "Leave History" is renamed "Leave Request Status". A label change only:
 * the keys stay (tests, saved role configs and the mobile preview name keys, as with r389's
 * leaveOverview), the route stays, and the admin "Leave History Data Import" screen keeps its name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { leavePack } from '@/packs/leave';

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const cat = (l: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), 'messages', `${l}.json`), 'utf8'));
const NOW: Record<string, string> = {
  en: 'Leave Request Status', ms: 'Status Permohonan Cuti', ta: 'விடுப்பு கோரிக்கை நிலை',
  th: 'สถานะคำขอลา', vi: 'Trạng thái đơn xin nghỉ phép', zh: '休假申请状态',
};
const WAS: Record<string, string> = {
  en: 'Leave History', ms: 'Sejarah Cuti', ta: 'விடுப்பு வரலாறு', th: 'ประวัติการลา', vi: 'Lịch sử nghỉ phép', zh: '休假记录',
};

describe('r392 · Leave Request Status', () => {
  it('the menu row, the page heading and the mobile preview read the new name in six locales', () => {
    for (const l of LOCALES) {
      const m = cat(l);
      expect(m.nav.leaveHistory, l).toBe(NOW[l]);
      expect(m.nav.leaveHistory, `${l} changed`).not.toBe(WAS[l]);
      expect(m.leave.historyHeading, `${l} heading follows the menu`).toBe(m.nav.leaveHistory);
      expect(m.mobilePreview.leave.history, `${l} mobile preview follows the menu`).toBe(m.nav.leaveHistory);
    }
  });

  it('only the label moved: same key, same route, and the import screen keeps its name', () => {
    const self = leavePack.navNodes!.find((n) => n.group === 'main')!;
    expect(self.children.find((c) => c.labelKey === 'leaveHistory')?.href).toBe('/leave/history');
    const en = cat('en');
    expect(en.nav.leaveHistoryImport).toBe('Leave History Data Import');
    expect(en.admin.leaveDataImport.history).toBe('Leave History Data Import');
  });
});
