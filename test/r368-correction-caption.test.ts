/**
 * r368 · c8282468 — THE CAPTION UNDER THE ADMIN DAY-CORRECTION FORM, AND WHAT IT IS ALLOWED TO PROMISE.
 *
 * `attendance.dayCorrectTrailNote` read, in all six locales:
 *
 *     "Saved immediately, and recorded: who changed it, when, the previous value and this reason."
 *
 * Who, when and the reason are kept. THE PREVIOUS VALUE WAS KEPT NOWHERE — `decideAttendanceCorrection`
 * overwrote the day's figures with a blind `insert … onConflictDoUpdate` that never read the existing row,
 * and the `attendance.amended` payload carried after-values only. No history table, no before column, no
 * spelling of previousValue anywhere in the repo. That sentence is an AUDIT PROMISE, printed on the screen
 * where an HR user changes a figure that feeds pay, and it promised something the system could not produce.
 *
 * THE TRUTH FIX SHIPS AHEAD OF THE RECORDING, on purpose and in its own commit: if the recording had
 * slipped a month the screen would still have stopped overclaiming. So this file pins the SEPARABLE half —
 * the key is retired IN PLACE (never deleted: `i18n/request.ts` deep-merges each locale over English, so
 * dropping a key from en.json alone leaves five locales still rendering the old sentence while the English
 * one vanishes), the new key exists and is live in all six, and the form renders the new one.
 *
 * WHY THE OLD KEY IS NOT SIMPLY REWORDED: item 67268d83's approved plan flags this same caption for its
 * round 2, which puts it on a SECOND screen (/attendance/my-records/<date>). A rename makes "consume the
 * corrected key" the only way that round can compile, and leaves the false sentence quoted where a reader
 * of the catalogue can see what changed and why.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const messages = (loc: string) => JSON.parse(readFileSync(join(ROOT, `messages/${loc}.json`), 'utf8'));
const DAY_PAGE = readFileSync(join(ROOT, 'app/attendance/individual/[date]/page.tsx'), 'utf8');

/** The previous-value clause, per locale, exactly as the retired sentence spelled it. A revival in ANY
 *  locale is the failure the deep-merge hides, so the phrase is checked in the language it was written in
 *  rather than only in English. */
const PREVIOUS_VALUE_CLAUSE: Record<string, string> = {
  en: 'the previous value',
  ms: 'nilai sebelumnya',
  zh: '原值',
  ta: 'முந்தைய மதிப்பு',
  th: 'ค่าเดิม',
  vi: 'giá trị trước đó',
};

describe('r368 c8282468 · the correction caption stops promising what nothing stored', () => {
  it('the form renders the NEW key, and no longer the retired one', () => {
    expect(DAY_PAGE, 'the caption under the admin correction form').toContain("t('dayCorrectAuditNote')");
    expect(DAY_PAGE, 'the retired key must have no renderer left').not.toContain("t('dayCorrectTrailNote')");
  });

  it.each(LOCALES)('%s: dayCorrectTrailNote is RETIRED IN PLACE, not deleted', (loc) => {
    const a = messages(loc).attendance;
    expect(typeof a.dayCorrectTrailNote, `${loc}: the key must still EXIST — retire, never delete`).toBe('string');
    expect(String(a.dayCorrectTrailNote), `${loc}: and it must carry this round's retirement marker`).toMatch(
      /^\[retired r368 —/,
    );
  });

  it.each(LOCALES)('%s: dayCorrectAuditNote is live, and does not claim the previous value', (loc) => {
    const a = messages(loc).attendance;
    const v = String(a.dayCorrectAuditNote);
    expect(typeof a.dayCorrectAuditNote, `${loc}: the replacement must resolve`).toBe('string');
    expect(v.trim(), `${loc}: a blank caption is a silent regression`).not.toBe('');
    expect(v, `${loc}: the live caption must not itself be a retirement marker`).not.toContain('[retired');
    // ⚠️ THE WHOLE POINT. The clause the screen may not print until something stores it.
    expect(
      v,
      `${loc}: the caption may not promise the previous value — check what is stored before relaxing this`,
    ).not.toContain(PREVIOUS_VALUE_CLAUSE[loc]);
  });

  /** The retirement note has to say what the sentence claimed and why it was wrong, or the next round
   *  reads a bare marker and reinstates the claim. It also has to point at the replacement by name. */
  it('the retirement note quotes the false claim and names its replacement', () => {
    const note = String(messages('en').attendance.dayCorrectTrailNote);
    expect(note, 'the item that found it').toContain('c8282468');
    expect(note, 'what it claimed').toContain('the previous value');
    expect(note, 'the key that replaced it').toContain('dayCorrectAuditNote');
  });
});
