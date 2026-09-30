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

/** The two claims step 3 adds, per locale: the old-and-new-value promise and the on-site location clause.
 *  Asserted in the language the caption is written in — a half-applied reword that changed English and left
 *  five locales on the narrower step-1 sentence is exactly the failure the deep-merge hides. */
const KEPT_CLAIM: Record<string, string[]> = {
  en: ['Audit trail', 'old and new value', 'on-site location check'],
  ms: ['Jejak audit', 'nilai lama dan nilai baharu', 'lokasi di tapak'],
  zh: ['审计日志', '原值与新值', '现场位置校验'],
  ta: ['தணிக்கைப் பதிவில்', 'பழைய மதிப்பும் புதிய மதிப்பும்', 'இருப்பிடச் சரிபார்ப்பு'],
  th: ['บันทึกการตรวจสอบ', 'ค่าเดิมกับค่าใหม่', 'ตำแหน่งที่หน้างาน'],
  vi: ['Nhật ký kiểm toán', 'giá trị cũ và giá trị mới', 'vị trí tại chỗ'],
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

  it.each(LOCALES)('%s: dayCorrectAuditNote is live in every locale', (loc) => {
    const a = messages(loc).attendance;
    const v = String(a.dayCorrectAuditNote);
    expect(typeof a.dayCorrectAuditNote, `${loc}: the replacement must resolve`).toBe('string');
    expect(v.trim(), `${loc}: a blank caption is a silent regression`).not.toBe('');
    expect(v, `${loc}: the live caption must not itself be a retirement marker`).not.toContain('[retired');
  });

  /**
   * ⚠️ STEP 1's ASSERTION IS GONE FROM HERE, AND THIS IS THE RECORD OF WHY — the same "prose outlives the
   * kernel" rule, applied to a test. Step 1 asserted the caption did NOT contain the previous-value clause
   * (PREVIOUS_VALUE_CLAUSE below), because nothing stored it. Step 2 stores it, so the clause became TRUE
   * and the negative assertion became a guard against the fix. In zh and th it is not even expressible any
   * more: "原值" and "ค่าเดิม" are substrings of the "原值与新值" / "ค่าเดิมกับค่าใหม่" the corrected caption
   * legitimately says.
   *
   * The clause is now EARNED, not assumed, and what earns it is a different file:
   * test/r368-correction-before-after.test.ts pins the `{ before, after }` pair on `attendance.amended`.
   * If that file is ever weakened, the caption below is overclaiming again — the two move together.
   */
  it('the retired clause is still spelled out, so a future round can find what changed', () => {
    for (const loc of LOCALES) {
      expect(PREVIOUS_VALUE_CLAUSE[loc], `${loc}: the clause the old caption used`).toBeTruthy();
    }
    expect(
      String(messages('en').attendance.dayCorrectTrailNote),
      'the retired key quotes it, which is how a reader finds this history at all',
    ).toContain(PREVIOUS_VALUE_CLAUSE.en);
  });

  /**
   * STEP 3 — AND NOW IT SAYS WHAT IS KEPT. Step 1 made the caption true by saying LESS; step 2 made the
   * recording real, so the caption says more again — and every clause of it has to be checkable from this
   * repo (CLAUDE.md §8, "a shared caption may say only what is true of every member"):
   *
   *   · "the old and new value of every figure the correction moves" — the `{ before, after }` pair on the
   *     `attendance.amended` event, over the whole projection (test/r368-correction-before-after.test.ts);
   *   · "including the on-site location check it clears" — the 14 ADR-0070 geo columns are IN the pair;
   *   · "the Audit trail" — and NOT this screen, and NOT the personnel Change History card. The day screen
   *     renders no history, and core/read.ts `employeeAudit` filters on an aggregate-id set that excludes
   *     attendance. /admin/audit is the only surface, so it is the only one the sentence may name.
   *
   * The caption's own product noun must match what the Audit Trail screen calls itself, or a reader is sent
   * to a page that is not labelled the way the caption says.
   */
  it.each(LOCALES)('%s: the caption states what is now kept, and names the surface that shows it', (loc) => {
    const v = String(messages(loc).attendance.dayCorrectAuditNote);
    for (const phrase of KEPT_CLAIM[loc]) {
      expect(v, `${loc}: the caption must state "${phrase}" — it is what step 2 made true`).toContain(phrase);
    }
  });

  /** The product noun is tied to the screen's OWN label in English, where the caption is authored. The five
   *  translations inflect it (Tamil's locative is "தணிக்கைப் பதிவில்", not the bare nominative), so they are
   *  checked against their own listed phrase above rather than against a substring of `nav.auditTrail` — a check
   *  that would only be satisfiable by writing ungrammatical Tamil. */
  it('the English caption names the Audit trail exactly as the screen labels itself', () => {
    const m = messages('en');
    expect(String(m.attendance.dayCorrectAuditNote)).toContain(String(m.nav.auditTrail));
    expect(String(m.nav.auditTrail), 'and the nav row and the page heading already agree on it').toBe(
      String(m.admin.audit.title),
    );
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
