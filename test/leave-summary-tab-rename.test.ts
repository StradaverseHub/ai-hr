/**
 * Guard for the "Leave Types" -> "Summary" rename (nav.leaveSummary, formerly admin.leaveTabs.types).
 *
 * The first entry in Leave config (/admin/leave — a sidebar fly-out child since 645e67c4)
 * was renamed from "Leave Types" to "Summary" in all six locales. This guard is
 * deliberately slim: it pins only the i18n key, because the change is a
 * display-label-only rename — no route, component or service behaviour changed.
 *
 * The hardcoded old-string list below is load-bearing: i18n-coverage.test.ts
 * check A only enforces that every en key is present and non-blank in the other
 * locales — it cannot detect a locale that silently kept its OLD translation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MESSAGES = path.resolve(__dirname, '../messages');

type Dict = Record<string, unknown>;
const load = (loc: string): Dict => JSON.parse(fs.readFileSync(path.join(MESSAGES, `${loc}.json`), 'utf8'));

function getPath(obj: Dict, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);
}

// 645e67c4 — the eight leave-config labels moved from admin.leaveTabs into the nav namespace when the
// tab strip became a sidebar fly-out. The RENAME this file defends is unaffected by that move, so the
// key is re-pointed rather than the test retired: "Summary" must still be the first entry's label.
const KEY = 'nav.leaveSummary';

/** Pre-rename translations per locale — the rename must have replaced every one of these. */
const OLD_LABELS: Record<string, string> = {
  en: 'Leave Types',
  ms: 'Jenis Cuti',
  ta: 'விடுப்பு வகைகள்',
  th: 'ประเภทการลา',
  vi: 'Loại nghỉ phép',
  zh: '假期类型',
};

describe('leave config Summary rename (nav.leaveSummary, formerly admin.leaveTabs.types)', () => {
  it('en.json labels the first Leave config entry "Summary"', () => {
    expect(getPath(load('en'), KEY)).toBe('Summary');
  });

  it('no locale still carries its old "Leave Types" translation for the tab', () => {
    const stale = Object.entries(OLD_LABELS)
      .filter(([loc, old]) => getPath(load(loc), KEY) === old)
      .map(([loc]) => loc);
    expect(stale, `locales still using the pre-rename label: ${stale.join(', ')}`).toEqual([]);
  });
});
