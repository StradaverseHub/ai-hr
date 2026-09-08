/**
 * 420ebab5 part two — the CONSOLIDATED Profile save, and the fence that makes it safe.
 *
 * ── WHAT IS BEING PINNED, AND WHY IT IS TWO DIFFERENT KINDS OF TEST ──────────────────────────────────
 * §1–§3 run the real server action against the real database: one "Save Changes" must do exactly what the
 * five per-card saves did — the SAME services, each with its OWN payload, in a declared order — and must
 * do it for the cards the admin actually touched and no others. Effective dating (ADR-0001/0003) is why
 * that matters: each service closes a version and inserts a successor, so collapsing five into one
 * blanket write would not be a refactor, it would be a different set of records.
 *
 * §4 is a SOURCE-SHAPE guard, and it is the one that must not be softened. The dangerous half of a
 * tab-wide Save is the tab-wide Discard beside it:
 * docs/audits/420ebab5-personnel-save-classification.md sorts all 35 forms on this screen into (a) plain
 * field edits, which consolidate, and (b) child-record lifecycle — adding a dependant, terminating a CP38
 * order, archiving a qualification, recording a salary revision — which are discrete acts, several of
 * them money-affecting, and which KEEP their own buttons. A Discard that appeared to cover a recorded
 * salary revision would be a control lying about what it does, which is worse than the scattered buttons
 * it replaced. The classification is a document and documents rot; §4 is the same statement in a form
 * that fails a build. It does NOT merely check a list — it checks the STRUCTURE the safety rests on: the
 * consolidated scope contains only the five (a) cards, and every one of the 25 bucket (b) writers is
 * still bound to a form of its own that the scope does not enclose.
 *
 * The behaviour of the scope in a browser — the change summary, the edited-field marking, Discard, and
 * the Save/Discard/Cancel prompt — is in test/personnel-tab-save.dom.test.tsx, which renders it.
 *
 * next/navigation and next/cache are stubbed inert and requireAdmin is stubbed to the seeded admin, so
 * the real FormData → service → database path runs. `saveProfileTabAction` itself does NOT redirect (it
 * returns a result), which is the whole point of §3.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const { redirect, sess } = vi.hoisted(() => ({
  redirect: vi.fn((_url: string) => undefined),
  sess: { ctx: null as unknown },
}));
vi.mock('next/navigation', () => ({ redirect, notFound: vi.fn(() => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('../lib/authz', async (importActual) => {
  const actual = await importActual<typeof import('../lib/authz')>();
  return { ...actual, requireAdmin: vi.fn(async () => sess.ctx) };
});
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { saveProfileTabAction } from '../app/admin/personnel/[employmentId]/actions';
import { PROFILE_TAB_SECTION_ORDER, SECTION_FIELD_PREFIX } from '../lib/personnel-tab-sections';
import { UNSAVED_GUARD_ATTR } from '../lib/unsaved-changes';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/**
 * A source scan that reads what the BROWSER would get, not what the file says.
 *
 * AGENTS 27: source-scanning guards do not strip comments, and this file's subject — "which form carries
 * which attribute" — is exactly the kind that a prose mention of the attribute would answer wrongly. The
 * page's own explanatory comments name `data-save-section`, `<form action={…}>` and several of the bucket
 * (b) action names, so every count below is taken after the comments are removed. Deliberately
 * conservative on `//`: only a line that IS a comment is dropped, so a `//` inside a string survives.
 */
function stripComments(src: string): string {
  // LINE comments go FIRST, and the order is load-bearing: one of the page's `//` notes contains the
  // characters that open a block comment, and stripping blocks first made that note swallow 3,346
  // characters of real JSX — including the CP38 dialog's form, which then read as "no longer bound to an
  // action". A guard that loses a form silently is worse than no guard.
  const withoutLines = src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('* ') || t === '*');
    })
    .join('\n');
  return withoutLines.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');
}

const PAGE = () => stripComments(read('app/admin/personnel/[employmentId]/page.tsx'));
const IDENTITY = () => stripComments(read('components/personnel-identity.tsx'));

const key = (section: string, field: string) => `${SECTION_FIELD_PREFIX}.${section}.${field}`;

function payload(sections: string[], fields: Record<string, string>, employmentId: string, tab = 'profile') {
  const fd = new FormData();
  fd.set('employmentId', employmentId);
  fd.set('sections', sections.join(','));
  fd.set('tab', tab);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const readPerson = (personId: string) =>
  owner.db
    .select()
    .from(schema.person)
    .where(eq(schema.person.id, personId))
    .limit(1)
    .then((r) => r[0]);

const readEmployment = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId))
    .limit(1)
    .then((r) => r[0]);

const readStatutory = (personId: string) =>
  owner.db
    .select()
    .from(schema.employeeStatutoryMy)
    .where(eq(schema.employeeStatutoryMy.personId, personId))
    .limit(1)
    .then((r) => r[0]);

describe('420ebab5 part two — one Save per tab on Personnel → Profile', () => {
  let base: Base;
  let employmentId: string;
  let personId: string;
  let email: string;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    const a = adminCtx(base);
    sess.ctx = a;
    email = `tabsave-${Date.now()}@acme.test`;
    const emp = await hireEmployee(a, {
      person: { fullName: 'Ali bin Ahmad', primaryEmail: email },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    employmentId = emp.employmentId;
    personId = emp.personId;
    redirect.mockClear();
  });
  afterAll(async () => {
    await closeAll();
  });

  // ── §1 the consolidated save calls each card's own service, with that card's own payload ───────────
  describe('§1 two cards, one Save', () => {
    it('writes Personal Details AND Contact & Address in one request without either clobbering the other', async () => {
      const newEmail = `hassan-${Date.now()}@acme.test`;
      const result = await saveProfileTabAction(
        payload(
          ['person', 'contact'],
          {
            [key('person', 'employmentId')]: employmentId,
            [key('person', 'personId')]: personId,
            [key('person', 'fullName')]: 'Ali bin Hassan',
            [key('person', 'employeeCode')]: 'E-4201',
            // The mirrors, carrying the LIVE values the way the client sends them.
            [key('person', 'primaryEmail')]: newEmail,
            [key('person', 'phone')]: '+60123456789',
            [key('contact', 'employmentId')]: employmentId,
            [key('contact', 'personId')]: personId,
            [key('contact', 'fullName')]: 'Ali bin Hassan',
            [key('contact', 'primaryEmail')]: newEmail,
            [key('contact', 'phone')]: '+60123456789',
            [key('contact', 'permanentCity')]: 'Kuala Lumpur',
          },
          employmentId,
        ),
      );

      expect(result.ok).toBe(true);
      expect(result.saved).toEqual(['person', 'contact']);

      const p = await readPerson(personId);
      // Both survive. Personal Details owns the name, Contact owns the email — and the card that carries
      // the OTHER one as a hidden mirror wrote the live value, not the one the server had rendered.
      expect(p.fullName).toBe('Ali bin Hassan');
      expect(p.primaryEmail).toBe(newEmail);
      expect(p.permanentCity).toBe('Kuala Lumpur');
      expect((await readEmployment(employmentId)).employeeCode).toBe('E-4201');
      // It returns rather than redirecting — a redirect could not have said which card failed.
      expect(redirect).not.toHaveBeenCalled();
    });

    it('a card the admin did not touch is never written, even if its fields ride along in the payload', async () => {
      const result = await saveProfileTabAction(
        payload(
          ['person'],
          {
            [key('person', 'employmentId')]: employmentId,
            [key('person', 'personId')]: personId,
            [key('person', 'fullName')]: 'Ali bin Hassan',
            [key('person', 'primaryEmail')]: email,
            [key('person', 'employeeCode')]: 'E-1001',
            // Crafted: present in the request but NOT named in `sections`.
            [key('contact', 'employmentId')]: employmentId,
            [key('contact', 'personId')]: personId,
            [key('contact', 'fullName')]: 'Ali bin Hassan',
            [key('contact', 'primaryEmail')]: email,
            [key('contact', 'permanentCity')]: 'Should Not Land',
          },
          employmentId,
        ),
      );

      expect(result.ok).toBe(true);
      expect(result.saved).toEqual(['person']);
      const p = await readPerson(personId);
      expect(p.fullName).toBe('Ali bin Hassan');
      expect(p.permanentCity).toBeNull();
    });

    it('forces the employment from the top level — a section cannot redirect a write at another employment', async () => {
      const a = adminCtx(base);
      const other = await hireEmployee(a, {
        person: { fullName: 'Other Person', primaryEmail: `other-${Date.now()}@acme.test` },
        companyId: base.companyId,
        departmentId: base.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });

      const result = await saveProfileTabAction(
        payload(
          ['person'],
          {
            // The forged one. Everything else is a normal Personal Details payload.
            [key('person', 'employmentId')]: other.employmentId,
            [key('person', 'personId')]: personId,
            [key('person', 'fullName')]: 'Ali bin Ahmad',
            [key('person', 'primaryEmail')]: email,
            [key('person', 'employeeCode')]: 'E-9999',
          },
          employmentId,
        ),
      );

      expect(result.ok).toBe(true);
      expect((await readEmployment(employmentId)).employeeCode).toBe('E-9999');
      expect((await readEmployment(other.employmentId)).employeeCode).not.toBe('E-9999');
    });
  });

  // ── §2 the section list is a fence, not a hint ─────────────────────────────────────────────────────
  describe('§2 only bucket (a) sections exist to this action', () => {
    it('refuses a section name it does not recognise and writes nothing', async () => {
      const result = await saveProfileTabAction(
        payload(
          ['compensation'],
          {
            [key('compensation', 'employmentId')]: employmentId,
            [key('compensation', 'amount')]: '99999',
            [key('person', 'personId')]: personId,
            [key('person', 'fullName')]: 'Should Not Land',
            [key('person', 'primaryEmail')]: email,
          },
          employmentId,
        ),
      );

      expect(result.ok).toBe(false);
      expect(result.failedSection).toBe('compensation');
      expect(result.saved).toEqual([]);
      expect((await readPerson(personId)).fullName).toBe('Ali bin Ahmad');
    });

    it('the declared section list is exactly the five bucket (a) cards of the Profile tab', () => {
      expect([...PROFILE_TAB_SECTION_ORDER]).toEqual(['person', 'compliance', 'contact', 'ic', 'passport']);
    });
  });

  // ── §3 a failure names the card that broke, and does not lie about the ones that did not ───────────
  describe('§3 per-section failure', () => {
    it('reports which card failed and which had already committed', async () => {
      const result = await saveProfileTabAction(
        payload(
          ['person', 'ic'],
          {
            [key('person', 'employmentId')]: employmentId,
            [key('person', 'personId')]: personId,
            [key('person', 'fullName')]: 'Ali bin Hassan',
            [key('person', 'primaryEmail')]: email,
            [key('person', 'employeeCode')]: 'E-1002',
            [key('ic', 'employmentId')]: employmentId,
            [key('ic', 'personId')]: personId,
            // Not a MyKad — the pack setter refuses it.
            [key('ic', 'icNumber')]: '42',
            [key('ic', 'oldIcNumber')]: '',
          },
          employmentId,
        ),
      );

      expect(result.ok).toBe(false);
      expect(result.failedSection).toBe('ic');
      expect(result.saved).toEqual(['person']);
      expect(result.error).toBeTruthy();
      // Personal Details ran first and committed — the result says so, and the database agrees.
      expect((await readPerson(personId)).fullName).toBe('Ali bin Hassan');
      // The IC did not land.
      expect((await readStatutory(personId))?.icNumber ?? null).not.toBe('42');
    });

    it('a valid IC still reaches the same pack setter through the consolidated door', async () => {
      const result = await saveProfileTabAction(
        payload(
          ['ic'],
          {
            [key('ic', 'employmentId')]: employmentId,
            [key('ic', 'personId')]: personId,
            [key('ic', 'icNumber')]: '900101015030',
            [key('ic', 'oldIcNumber')]: '',
          },
          employmentId,
        ),
      );

      expect(result.ok).toBe(true);
      expect((await readStatutory(personId))?.icNumber).toBe('900101015030');
    });
  });

  // ── §4 THE FENCE ──────────────────────────────────────────────────────────────────────────────────
  describe('§4 bucket (b) keeps its own buttons, outside the tab-wide Save', () => {
    /**
     * Every writer the classification put in bucket (b): a record in a register, a dated version, or a row
     * in the Employment History ledger. Each is a deliberate act with its own confirmation, and several
     * move money. NONE of them may ever be reachable from a tab-wide Save or Discard.
     */
    const BUCKET_B = [
      'addEmergencyContactAction',
      'editEmergencyContactAction',
      'deleteEmergencyContactAction',
      'setEmploymentComponentAction',
      'addCp38Action',
      'editCp38Action',
      'terminateCp38Action',
      'unfreezeEncashmentAction',
      'adjustEncashmentAction',
      'addDependentAction',
      'editDependentAction',
      'archiveDependentAction',
      'addQualificationAction',
      'editQualificationAction',
      'archiveQualificationAction',
      'setDefaultShiftAction',
      'setCompensationAction',
      'reverseMovementEventAction',
      'changeEmploymentCompanyAction',
      'setDirectSuperiorAction',
      'endDelegationAction',
      'addDelegationAction',
      'setLocationAction',
      'setPersonPhotoAction',
      'removePersonPhotoAction',
    ];

    /** Every `<form …>` OPENING TAG on the page, which is where both `action` and the marker live. */
    const formTags = (src: string) =>
      src
        .split('<form')
        .slice(1)
        .map((chunk) => chunk.slice(0, chunk.indexOf('>')));

    it('every bucket (b) writer is still bound to a form of its own', () => {
      // Several are add-vs-edit ternaries (`action={editing ? editX : addX}`), so the binding is matched
      // inside the action expression rather than as a bare `{name}`.
      const bound = formTags(PAGE())
        .map((tag) => /action=\{([\s\S]*?)\}/.exec(tag)?.[1] ?? '')
        .join(' | ');
      for (const action of BUCKET_B) {
        expect(bound, `${action} must still be bound to a <form action={…}>`).toContain(action);
      }
    });

    it('no bucket (b) form carries the consolidated-save marker', () => {
      // A bucket (b) form that acquired data-save-section would be silently swept into the tab's Save AND
      // — the dangerous half — into its Discard.
      for (const tag of formTags(PAGE())) {
        const expr = /action=\{([\s\S]*?)\}/.exec(tag)?.[1] ?? '';
        const b = BUCKET_B.find((a) => expr.includes(a));
        if (!b) continue;
        expect(tag, `${b}'s form must not carry data-save-section`).not.toContain('data-save-section');
      }
    });

    it('the save scope encloses ONLY the five (a) cards, and the Emergency Contact register sits outside it', () => {
      const page = PAGE();
      const open = page.indexOf('<TabSaveScope');
      const close = page.indexOf('</TabSaveScope>');
      expect(open, 'the Profile tab opens a TabSaveScope').toBeGreaterThan(-1);
      expect(close).toBeGreaterThan(open);

      const inside = page.slice(open, close);
      // Personal Details, the compliance fields and Contact & Address are inside; IdentityFields (which
      // holds the IC and passport forms) is rendered inside it too.
      expect(inside).toContain('data-save-section="person"');
      expect(inside).toContain('data-save-section="compliance"');
      expect(inside).toContain('data-save-section="contact"');
      expect(inside).toContain('<IdentityFields');
      // …and the register of emergency contacts is NOT.
      expect(inside).not.toContain('emergencyContactPanel');
      expect(page.indexOf('{emergencyContactPanel}')).toBeGreaterThan(close);
    });

    it('the marker appears on exactly the five (a) forms and nowhere else', () => {
      const ids = [...PAGE().matchAll(/data-save-section="([a-z]+)"/g)].map((m) => m[1]);
      const identityIds = [...IDENTITY().matchAll(/data-save-section="([a-z]+)"/g)].map((m) => m[1]);
      expect([...ids, ...identityIds].sort()).toEqual(
        [...PROFILE_TAB_SECTION_ORDER].sort(),
      );
    });

    it('the two consolidated cards are still the only place their writers are wired to a form', () => {
      // NOT a no-JavaScript fallback — an earlier version of this test said so and was wrong. Implicit
      // submission needs a form with no submit button AND exactly one field that blocks it; both cards
      // here carry several, so with the bundle blocked neither can be posted by any keystroke. The
      // binding is pinned because it is the sole wiring of setIcAction / setPassportAction, and because a
      // <form> with no action at all would POST to the current URL.
      const identity = IDENTITY();
      expect(identity).toContain('action={setIcAction} data-save-section="ic"');
      expect(identity).toContain('action={setPassportAction} data-save-section="passport"');
    });

    /**
     * The workbook anchor is the one same-origin `<a>` on this screen that is NOT a link to a page: its
     * click downloads a spreadsheet and leaves the reader where they were. The screen-leaving guard
     * intercepts same-origin anchors while a tab is dirty, so without the opt-out it turned that download
     * into an "Unsaved changes" dialog followed by a router.push at a route with no page to render. The
     * behaviour is pinned in test/personnel-tab-save.dom.test.tsx §10; what can only be pinned HERE is
     * that the real anchor still carries the attribute.
     */
    it('the Employment History workbook anchor stays exempt from the unsaved-changes guard', () => {
      // `<a[\s>]` and not `<a`, so `<article`/`<aside` cannot be mistaken for an anchor.
      const anchors = PAGE()
        .split(/<a[\s>]/)
        .slice(1)
        .map((chunk) => chunk.slice(0, chunk.indexOf('>')));
      const exportAnchor = anchors.find((tag) => tag.includes('movement-export'));
      expect(exportAnchor, 'the Export to Excel anchor is still a bare <a> on this page').toBeDefined();
      expect(exportAnchor).toContain(`${UNSAVED_GUARD_ATTR}="ignore"`);
    });

    it('the five (a) cards no longer carry a Save button of their own', () => {
      const page = PAGE();
      const scope = page.slice(page.indexOf('<TabSaveScope'), page.indexOf('</TabSaveScope>'));
      // Scoped to the consolidated cards, NOT to the whole file: `saveDetails` is also the label on the
      // Attendance tab's Holiday Calendar card, which is bucket (a) but is not consolidated this round.
      expect(scope).not.toContain("t('saveDetails')");
      expect(scope).not.toContain("t('saveComplianceFields')");
      expect(scope).not.toContain("t('saveContact')");
      // Nothing inside the scope submits on its own any more.
      expect(scope).not.toContain('<button');
      const identity = IDENTITY();
      expect(identity).not.toContain("t('saveIc')");
      expect(identity).not.toContain("t('savePassport')");
      expect(identity).not.toContain('<button');
    });
  });

  // ── §5 i18n ───────────────────────────────────────────────────────────────────────────────────────
  describe('§5 the new labels exist in all six locales', () => {
    it('components.tabSave is complete and non-empty everywhere', () => {
      const keys = [
        'saveChanges',
        'discardChanges',
        'cancel',
        'saving',
        'savedToast',
        'saveFailed',
        'noChanges',
        'changedCount',
        'reviewChanges',
        'hideChanges',
        'colField',
        'colOriginal',
        'colNew',
        'editedBadge',
        'emptyValue',
        'unsavedTitle',
        'unsavedBody',
      ];
      for (const loc of LOCALES) {
        const msg = JSON.parse(read(`messages/${loc}.json`));
        for (const k of keys) {
          const v = msg?.components?.tabSave?.[k];
          expect(typeof v, `messages/${loc}.json missing components.tabSave.${k}`).toBe('string');
          expect(v.length, `messages/${loc}.json components.tabSave.${k} empty`).toBeGreaterThan(0);
        }
        // The count placeholder must survive translation or the badge renders a literal brace.
        expect(msg.components.tabSave.changedCount).toContain('{count}');
      }
    });
  });
});
