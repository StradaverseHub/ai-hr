/**
 * Feedback 127dffba — EPF Contribution Information Card redesign (Personnel · Bank & Statutory tab).
 *
 * Presentation-only change: label rename (EPF Mode → EPF Category), a grey placeholder on the EPF
 * Number field, removal of the disabled `manual_fixed` dropdown option, and the EPF fieldset presented
 * as a visually-distinct card. The persisted epf_mode enum (auto | voluntary_excess | exempt) and the
 * UI→enum mapping MUST stay unchanged — these tests pin that invariant alongside the surface changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapEpfUiMode } from '../lib/epf-mode-map';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('EPF Info Card (127dffba)', () => {
  it('mapEpfUiMode still yields only the three lawful enum values (mapping unchanged)', () => {
    const lawful = new Set(['auto', 'voluntary_excess', 'exempt']);
    for (const ui of ['auto', 'manual_percentage', 'semi_auto', 'manual_fixed', 'none', 'garbage', null, undefined]) {
      const { epfMode } = mapEpfUiMode(ui, null, null);
      expect(lawful.has(epfMode), `${String(ui)} -> ${epfMode}`).toBe(true);
    }
    // Spot-check the three canonical shapes are preserved.
    expect(mapEpfUiMode('auto', null, null).epfMode).toBe('auto');
    expect(mapEpfUiMode('manual_percentage', 11, 13)).toEqual({ epfMode: 'voluntary_excess', epfEmployeeRate: 0.11, epfEmployerRate: 0.13 });
    expect(mapEpfUiMode('semi_auto', 11, null)).toEqual({ epfMode: 'voluntary_excess', epfEmployeeRate: 0.11, epfEmployerRate: null });
    expect(mapEpfUiMode('none', null, null).epfMode).toBe('exempt');
    // Deferred fixed-amount coerces defensively to auto.
    expect(mapEpfUiMode('manual_fixed', 500, 500).epfMode).toBe('auto');
  });

  it('EPF Category dropdown no longer offers the manual_fixed option', () => {
    const src = read('components/epf-election.tsx');
    expect(src).not.toMatch(/<option[^>]*value="manual_fixed"/);
    // The other four categories remain.
    for (const v of ['auto', 'manual_percentage', 'semi_auto', 'none']) {
      expect(src, v).toMatch(new RegExp(`<option value="${v}"`));
    }
  });

  it('EPF Number input carries the grey placeholder 123456789 and no hardcoded default', () => {
    const src = read('app/admin/personnel/[employmentId]/page.tsx');
    const m = src.match(/<input name="epfNumber"[^>]*\/>/);
    expect(m, 'epfNumber input present').not.toBeNull();
    const tag = m![0];
    expect(tag).toContain('placeholder="123456789"');
    // Value stays bound to stored data, blank when empty (no baked-in sample).
    expect(tag).toContain("defaultValue={statutory?.epfNumber ?? ''}");
  });

  it('EPF label reads "EPF Category" (en) and is renamed across all 6 locales', () => {
    for (const loc of LOCALES) {
      const dict = JSON.parse(read(`messages/${loc}.json`));
      const label = dict?.people?.detail?.epfMode;
      expect(label, `${loc} epfMode present`).toBeTruthy();
      // The old English wording must be gone from every locale.
      expect(String(label).toLowerCase(), `${loc} not "EPF mode"`).not.toBe('epf mode');
    }
    const en = JSON.parse(read('messages/en.json'));
    expect(en.people.detail.epfMode).toBe('EPF Category');
  });
});
