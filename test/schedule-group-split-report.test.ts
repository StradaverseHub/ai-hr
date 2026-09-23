/**
 * 07ebd04d — WHAT THE READ-ONLY REPORT ACTUALLY PRINTS, asserted against the shape production holds.
 *
 * The reporter's protocol makes step one a report and step four "get confirmation BEFORE migration", so
 * this output is the document a human makes an irreversible decision from. A document like that should
 * not be read for the first time when it is pasted in front of them, which is why
 * scripts/report-schedule-group-split.ts renders through a PURE `buildReport` and this file asserts the
 * text.
 *
 * THE FIXTURE IS PRODUCTION'S MEASURED SHAPE (2026-09-22), not an invented one:
 *   · SIX active shifts. weekly_pattern is {1,2,3,4,5} on all six, byte-identical.
 *   · half_pattern {6} on AM02 only; off_pattern {6} on MB28 only; empty everywhere else.
 *   · group "Standard" holds AM01, AM02, AM03, MB28, SemiFlex01; group "A02" holds AM4.
 *   · open assignments: AM01 1, AM02 0, AM03 1, AM4 0, MB28 2, SemiFlex01 2.
 *
 * ⚠️ THE FIXTURE IS NOT EVIDENCE ABOUT PRODUCTION. It is the shape the parent measured, restated here so
 * the RENDERING can be asserted; the real numbers come from running the script on the box. What is
 * asserted is that given that shape, the report says the right things — in particular that "Standard"
 * needs THREE groups and not two, that the Saturday of each carries the multiplier it is actually paid
 * at, and that nobody is reported as unaffected who is attached through the default-shift fallback.
 */
import { describe, expect, it } from 'vitest';
import {
  buildReport,
  collectAttachments,
  kindsOf,
  proposedGroupName,
  type ReportAttachment,
  type ReportInput,
} from '../scripts/report-schedule-group-split';

const STANDARD = 'rule-standard';
const A02 = 'rule-a02';

const MON_TO_FRI = [1, 2, 3, 4, 5];

const shifts = [
  { id: 's-am01', code: 'AM01', name: 'AM01', ruleId: STANDARD, weeklyPattern: MON_TO_FRI, halfPattern: [], offPattern: [] },
  { id: 's-am02', code: 'AM02', name: 'AM02', ruleId: STANDARD, weeklyPattern: MON_TO_FRI, halfPattern: [6], offPattern: [] },
  { id: 's-am03', code: 'AM03', name: 'AM03', ruleId: STANDARD, weeklyPattern: MON_TO_FRI, halfPattern: [], offPattern: [] },
  { id: 's-am4', code: 'AM4', name: 'AM4', ruleId: A02, weeklyPattern: MON_TO_FRI, halfPattern: [], offPattern: [] },
  { id: 's-mb28', code: 'MB28', name: 'SAG MORNING FULL', ruleId: STANDARD, weeklyPattern: MON_TO_FRI, halfPattern: [], offPattern: [6] },
  { id: 's-sf01', code: 'SF01', name: 'Semi Flexi Shift 01', ruleId: STANDARD, weeklyPattern: MON_TO_FRI, halfPattern: [], offPattern: [] },
];

const rules = [
  { id: A02, name: 'A02', status: 'active', isDefault: false },
  { id: STANDARD, name: 'Standard', status: 'active', isDefault: true },
];

const who = (n: string, groupId: string | null, via: ReportAttachment['via'] = 'arrangement'): ReportAttachment => ({
  employmentId: `e-${n}`,
  employeeCode: n.toUpperCase(),
  name: `Person ${n}`,
  groupId,
  terminatedOn: null,
  via,
  since: via === 'arrangement' ? '2026-01-01' : null,
});

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    today: '2026-09-23',
    generatedAt: '2026-09-23T03:00:00.000Z',
    rules,
    shifts,
    attached: new Map<string, ReportAttachment[]>([
      ['s-am01', [who('a', null)]],
      ['s-am03', [who('b', null)]],
      ['s-mb28', [who('c', null), who('d', null)]],
      ['s-sf01', [who('e', null), who('f', null)]],
    ]),
    collisions: { past: 0, future: 0, rows: [] },
    ...overrides,
  };
}

const text = (i: ReportInput) => buildReport(i).lines.join('\n');

describe('07ebd04d — the split report', () => {
  it('SAYS THE SPLIT IS THREE WAYS, and names each proposed group', () => {
    const t = text(input());
    expect(t).toContain('GROUP "Standard" (the tenant default) — 5 shift(s), 3 distinct working week(s)  ⇒ SPLIT INTO 3');
    expect(t).toContain('Standard 5 Day');
    expect(t).toContain('Standard 5.5 Day');
    expect(t).toContain('Standard 5 Day + Saturday Off');
    // A02 holds one shift and is self-consistent — the plan says leave it alone, so the report must not
    // propose a split for it. (The rev-1 plan said A02 was empty; it is not.)
    expect(t).toContain('GROUP "A02" — 1 shift(s), 1 distinct working week(s)  ⇒ no split needed');
  });

  it('PRINTS THE SATURDAY KIND WITH THE MULTIPLIER IT IS PAID AT — the reporter’s actual question', () => {
    const t = text(input());
    expect(t).toContain('Saturday resolves to: rest  (overtime 2.0x)');
    expect(t).toContain('Saturday resolves to: half');
    expect(t).toContain('Saturday resolves to: off  (overtime 1.5x)');
  });

  it('PRINTS THE RAW COLUMNS BESIDE THE ENGINE’S READING, so the derivation is checkable', () => {
    const t = text(input());
    expect(t).toContain('columns as stored: weekly [1,2,3,4,5]  half []  off [6]'); // MB28
    expect(t).toContain('columns as stored: weekly [1,2,3,4,5]  half [6]  off []'); // AM02
    expect(t).toContain('week as the engine reads it: Mon=full Tue=full Wed=full Thu=full Fri=full Sat=off Sun=rest');
  });

  it('NAMES EVERY AFFECTED EMPLOYEE, and says nobody is on the half-day shift', () => {
    const out = buildReport(input());
    expect(out.affected).toBe(6);
    expect(out.lines.join('\n')).toContain('shift AM02 (AM02)');
    expect(out.lines.join('\n')).toContain('(nobody is attached to this shift today)');
    for (const code of ['A', 'B', 'C', 'D', 'E', 'F']) {
      expect(out.lines.join('\n')).toContain(`${code} | Person ${code.toLowerCase()} | via arrangement since 2026-01-01`);
    }
  });

  it('COUNTS AN EMPLOYEE ATTACHED BY THE DEFAULT-SHIFT FALLBACK — the engine does, so the report must', () => {
    // core/attendance.ts scheduleFor falls back to employment.default_shift_id when there is NO live
    // arrangement row. Before this round the report only read the arrangement ladder, so such a person
    // was reported as unaffected while their Saturday moved with everyone else's.
    const attached = input().attached;
    attached.set('s-am02', [who('g', null, 'default_shift_id')]);
    const out = buildReport(input({ attached }));
    expect(out.affected).toBe(7);
    expect(out.lines.join('\n')).toContain('G | Person g | via default_shift_id');
  });

  it('…AND THE COLLECTION ITSELF APPLIES scheduleFor’s PRECEDENCE, not just the rendering', () => {
    // The case above only proves buildReport RENDERS such a row. This proves collectAttachments
    // PRODUCES one — which is the half that was missing, and the half where the under-count lived.
    const base = { employeeCode: 'X', name: 'Person x', groupId: null, terminatedOn: null };
    const attached = collectAttachments({
      arrangements: [{ employmentId: 'e-1', shiftId: 's-am01', validFrom: '2026-02-01', ...base, employeeCode: 'ONE' }],
      defaults: [
        // e-1 ALSO has a default_shift_id, pointing somewhere else. The ladder wins; this must not
        // produce a second attachment, or the same person would be counted on two shifts.
        { employmentId: 'e-1', shiftId: 's-mb28', ...base, employeeCode: 'ONE' },
        // e-2 has NO arrangement row at all, so the engine reaches its default shift. It must appear.
        { employmentId: 'e-2', shiftId: 's-mb28', ...base, employeeCode: 'TWO' },
        // e-3 has no default shift either. Nothing to attach.
        { employmentId: 'e-3', shiftId: null, ...base, employeeCode: 'THREE' },
      ],
      withLiveArrangement: new Set(['e-1']),
    });
    expect(attached.get('s-am01')?.map((a) => [a.employmentId, a.via, a.since])).toEqual([['e-1', 'arrangement', '2026-02-01']]);
    expect(attached.get('s-mb28')?.map((a) => [a.employmentId, a.via])).toEqual([['e-2', 'default_shift_id']]);
    expect([...attached.keys()].sort()).toEqual(['s-am01', 's-mb28']);
  });

  it('an employment whose ladder has NO OPEN row still resolves to the ladder, not to the cache', () => {
    // pickArrangementOn takes the greatest valid_from <= date and IGNORES valid_to, so a closed-off
    // ladder still answers and the default-shift cache is NOT consulted. `withLiveArrangement` is
    // therefore keyed on any live row, not on an open one — get that wrong and the report shows the
    // person on two shifts at once.
    const base = { employeeCode: 'Y', name: 'Person y', groupId: null, terminatedOn: null };
    const attached = collectAttachments({
      arrangements: [], // nothing OPEN
      defaults: [{ employmentId: 'e-9', shiftId: 's-am01', ...base }],
      withLiveArrangement: new Set(['e-9']), // …but a live, closed row exists
    });
    expect(attached.size).toBe(0);
  });

  it('MARKS AN EMPLOYEE STRANDED when their own group already differs from their shift’s', () => {
    // 8cd601d0 shipped assertShiftsAllowedForEmploymentsTx: an employment in group X may only be put on a
    // shift whose rule_id is X, and an EMPTY group refuses everything. So the split's real risk is people
    // left behind in the old group, and the report has to name them rather than count shifts.
    const attached = input().attached;
    attached.set('s-am01', [who('a', A02)]);
    const out = buildReport(input({ attached }));
    expect(out.stranded).toBe(1);
    expect(out.lines.join('\n')).toContain('group: A02  ⚠️ STRANDED — this employee is already in a different group from the shift');
  });

  it('SAYS WHICH EMPLOYEES THE MIGRATION MUST MOVE WITH THE SHIFT', () => {
    const attached = input().attached;
    attached.set('s-mb28', [who('c', STANDARD), who('d', STANDARD)]);
    const out = buildReport(input({ attached }));
    expect(out.stranded).toBe(0);
    expect(out.lines.join('\n')).toContain('→ the same migration must move this employee into the proposed group');
  });

  it('REFUSES TO NAME A WEEK THAT IS NOT ONE OF THE REPORTER’S THREE, rather than mislabelling it', () => {
    // Tue–Sat with Monday rest is a perfectly legal shift and is NOT "Standard 5 Day", even though its
    // Saturday is a full day. Picking a name here would put a working week on screen that the shift does
    // not have.
    const odd = { id: 's-odd', code: 'ODD', name: 'Tue-Sat', ruleId: A02, weeklyPattern: [2, 3, 4, 5, 6], halfPattern: [], offPattern: [] };
    const out = buildReport(input({ shifts: [...shifts, odd] }));
    expect(out.unnamed).toBe(1);
    expect(out.lines.join('\n')).toContain('(UNNAMED —');
    expect(proposedGroupName(odd)).toMatch(/^\(UNNAMED/);
    // …and a Saturday that is a FULL working day is a fourth case, also unnamed.
    expect(proposedGroupName({ weeklyPattern: [1, 2, 3, 4, 5, 6], halfPattern: [], offPattern: [] })).toMatch(/^\(UNNAMED/);
  });

  it('WARNS THAT AN EMPTY GROUP REFUSES EVERYTHING — the 8cd601d0 trap', () => {
    const out = buildReport(input({ rules: [...rules, { id: 'rule-empty', name: 'Empty', status: 'active', isDefault: false }] }));
    expect(out.lines.join('\n')).toContain('GROUP "Empty" — no shifts. ⚠️ An EMPTY group refuses every shift assignment');
  });

  it('REPORTS THE OFF-DAY ROSTER COLLISION, and says plainly when there is none', () => {
    expect(text(input())).toContain('(no rows — every off-pattern weekday is unrostered, so the 1.5x branch is the one in force)');
    const t = text(input({ collisions: { past: 12, future: 3, rows: ['    e-c | 2026-10-03 | rostered REST on an OFF-pattern weekday'] } }));
    expect(t).toContain('rows in the PAST (history — preserved, not migrated): 12');
    expect(t).toContain('rows on 2026-09-23 OR LATER (these dates still change): 3');
    expect(t).toContain('e-c | 2026-10-03 | rostered REST on an OFF-pattern weekday');
  });

  it('STATES ON ITS FACE THAT IT CHANGED NOTHING — condition 4 is confirmation BEFORE migration', () => {
    const t = text(input());
    expect(t).toContain('READ-ONLY — nothing was modified, no migration was written and none was run.');
    expect(t).toContain('NOTHING HAS BEEN MOVED. This is the list the restructuring needs confirmed before it runs.');
  });

  it('the four-way reading of production’s six shifts is what the split is BY', () => {
    // Stated as kinds rather than prose so a future change to shiftDayKindFor cannot quietly re-group them.
    expect(kindsOf(shifts[0]).join(' ')).toBe('full full full full full rest rest'); // AM01 — Saturday REST
    expect(kindsOf(shifts[1]).join(' ')).toBe('full full full full full half rest'); // AM02 — Saturday HALF
    expect(kindsOf(shifts[4]).join(' ')).toBe('full full full full full off rest'); // MB28 — Saturday OFF
  });
});

describe('07ebd04d — the report script writes nothing', () => {
  it('contains no insert, update or delete — condition 1 of the protocol', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../scripts/report-schedule-group-split.ts', import.meta.url), 'utf8'),
    );
    // Strip the header comment block, which quotes engine code and the reporter's conditions.
    const code = src.split('\nimport ').slice(1).join('\nimport ');
    for (const f of ['.insert(', '.update(', '.delete(']) {
      expect(code, `the report must never ${f}`).not.toContain(f);
    }
  });
});
