/**
 * 72b100cd — PCB 2(II) needs a fact nothing in this system held: what the employer PAID LHDN, and when.
 *
 * ⚠️ WHY THIS IS NOT `statutory_report.ack_ref`, and the distinction is the reason the table exists.
 * That column is ONE acknowledgement for the RETURN — the CP39 lodgement — and its own contract says so.
 * A payment is a different act: an employer may pay more than once against one return, LHDN issues a
 * receipt per payment, and PCB 2(II) reports MTD and CP38 in SEPARATE columns. One reference cannot
 * express that. Measured on production 2026-09-21: all six CP39 rows are draft with ack_ref NULL and
 * filed_on NULL, so widening that column would have been reinterpreting a field nobody has used rather
 * than one carrying data.
 *
 * WHAT THIS FILE PINS
 *   1. nothing is derived — every value is keyed, and the service refuses an empty reference;
 *   2. one reference per company, month and stream, because the form has ONE box and no way to print
 *      two — a correction updates rather than appends;
 *   3. a month with no record reads as ABSENT, so the renderer can print an empty box rather than 0.00.
 *      On a tax form an absent box asserts nothing and a zero asserts the money does not exist, and
 *      those are different statements to LHDN (CLAUDE.md §8).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { PcbPaymentError, pcbPaymentsForYear, recordPcbPayment } from '../core/pcb-payment';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('72b100cd · a payment is recorded, never computed', () => {
  it('records a reference and reads it back for the month and stream it belongs to', async () => {
    await recordPcbPayment(adminCtx(b), {
      companyId: b.companyId,
      periodKey: '2026-03',
      kind: 'mtd',
      receiptRef: 'LHDN-778812',
      paidOn: '2026-04-14',
    });
    const map = await pcbPaymentsForYear(adminCtx(b), { companyId: b.companyId, year: 2026 });
    expect(map.get('2026-03|mtd')).toMatchObject({ receiptRef: 'LHDN-778812', paidOn: '2026-04-14' });
  });

  it('keeps MTD and CP38 apart — the form prints them in different columns', async () => {
    const base = { companyId: b.companyId, periodKey: '2026-03', paidOn: '2026-04-14' } as const;
    await recordPcbPayment(adminCtx(b), { ...base, kind: 'mtd', receiptRef: 'MTD-1' });
    await recordPcbPayment(adminCtx(b), { ...base, kind: 'cp38', receiptRef: 'CP38-1' });
    const map = await pcbPaymentsForYear(adminCtx(b), { companyId: b.companyId, year: 2026 });
    expect(map.get('2026-03|mtd')!.receiptRef).toBe('MTD-1');
    expect(map.get('2026-03|cp38')!.receiptRef).toBe('CP38-1');
  });

  /**
   * THE BOX THE FORM LEAVES EMPTY. A month with nothing recorded must be ABSENT from the map — not a
   * zero, not a blank string. The renderer decides to print nothing; it must not be handed a value that
   * could be mistaken for one.
   */
  it('a month with nothing recorded is absent, not empty-valued', async () => {
    await recordPcbPayment(adminCtx(b), {
      companyId: b.companyId, periodKey: '2026-03', kind: 'mtd', receiptRef: 'X', paidOn: '2026-04-14',
    });
    const map = await pcbPaymentsForYear(adminCtx(b), { companyId: b.companyId, year: 2026 });
    expect(map.has('2026-04|mtd'), 'April was never paid').toBe(false);
    expect(map.get('2026-04|mtd')).toBeUndefined();
    expect(map.has('2026-03|cp38'), 'no CP38 that month either').toBe(false);
  });

  it('reads only the year asked for', async () => {
    const base = { companyId: b.companyId, kind: 'mtd' as const, receiptRef: 'R', paidOn: '2026-01-10' };
    await recordPcbPayment(adminCtx(b), { ...base, periodKey: '2025-12' });
    await recordPcbPayment(adminCtx(b), { ...base, periodKey: '2026-01' });
    const map = await pcbPaymentsForYear(adminCtx(b), { companyId: b.companyId, year: 2026 });
    expect([...map.keys()]).toEqual(['2026-01|mtd']);
  });
});

describe('72b100cd · one box, one reference', () => {
  it('re-keying CORRECTS the reference rather than adding a second one', async () => {
    const base = { companyId: b.companyId, periodKey: '2026-05', kind: 'mtd' as const };
    await recordPcbPayment(adminCtx(b), { ...base, receiptRef: 'TYPO-1', paidOn: '2026-06-01' });
    await recordPcbPayment(adminCtx(b), { ...base, receiptRef: 'LHDN-990011', paidOn: '2026-06-02' });

    const rows = await owner.db
      .select({ ref: schema.pcbPayment.receiptRef })
      .from(schema.pcbPayment)
      .where(and(eq(schema.pcbPayment.companyId, b.companyId), eq(schema.pcbPayment.periodKey, '2026-05')));
    expect(rows, 'the form has one box; two rows could never be printed').toHaveLength(1);
    expect(rows[0].ref).toBe('LHDN-990011');
  });
});

describe('72b100cd · what it refuses, because a tax form prints it verbatim', () => {
  it('refuses an empty or whitespace reference — "paid" without evidence is a click', async () => {
    for (const receiptRef of ['', '   ']) {
      await expect(
        recordPcbPayment(adminCtx(b), {
          companyId: b.companyId, periodKey: '2026-03', kind: 'mtd', receiptRef, paidOn: '2026-04-14',
        }),
      ).rejects.toBeInstanceOf(PcbPaymentError);
    }
  });

  it('refuses anything that is not a month', async () => {
    for (const periodKey of ['2026', '2026-13', '2026-00', 'March']) {
      await expect(
        recordPcbPayment(adminCtx(b), {
          companyId: b.companyId, periodKey, kind: 'mtd', receiptRef: 'R', paidOn: '2026-04-14',
        }),
      ).rejects.toBeInstanceOf(PcbPaymentError);
    }
  });

  /**
   * NO FORMAT CHECK ON THE REFERENCE ITSELF, and that is deliberate rather than an omission: this repo
   * cannot verify LHDN's receipt format, and policing one would be inventing third-party behaviour —
   * the same reasoning statutory_report.ack_ref records for the identical decision.
   */
  it('accepts whatever shape LHDN actually issued', async () => {
    for (const receiptRef of ['LHDN/2026/00123', 'A-1', '000000000001']) {
      await expect(
        recordPcbPayment(adminCtx(b), {
          companyId: b.companyId, periodKey: '2026-07', kind: 'mtd', receiptRef, paidOn: '2026-08-01',
        }),
      ).resolves.toBeTruthy();
    }
  });

  it('trims the reference, so a stray space is not a different receipt', async () => {
    await recordPcbPayment(adminCtx(b), {
      companyId: b.companyId, periodKey: '2026-09', kind: 'mtd', receiptRef: '  LHDN-42  ', paidOn: '2026-10-01',
    });
    const map = await pcbPaymentsForYear(adminCtx(b), { companyId: b.companyId, year: 2026 });
    expect(map.get('2026-09|mtd')!.receiptRef).toBe('LHDN-42');
  });
});

/**
 * THE SHAPE ON SCREEN. The service above is only half the guarantee: the payment form must sit BESIDE the
 * download form, never inside it. A nested form is invalid HTML and browsers drop the inner one, so a
 * nested payment form would render, accept typing, and silently submit the DOWNLOAD instead — losing the
 * receipt reference with no error. test/cp39-form.test.ts measures the nesting for the screen as a whole;
 * this pins the half r321 is answerable for.
 */
describe('72b100cd · the payment form is a sibling of the downloads, not a child', () => {
  const SRC = readFileSync(join(__dirname, '..', 'app/payroll/cp39/preview/page.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  const blocks = () => {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (const m of SRC.matchAll(/<form[\s>]|<\/form>/g)) {
      const at = m.index ?? 0;
      if (m[0] === '</form>') {
        depth -= 1;
        if (depth === 0) out.push(SRC.slice(start, at));
      } else {
        if (depth === 0) start = at;
        depth += 1;
      }
    }
    return out;
  };

  it('posts to the server action, and no download form contains it', () => {
    const mine = blocks().filter((f) => f.includes('recordPcbPaymentAction'));
    expect(mine, 'exactly one top-level form records the payment').toHaveLength(1);
    expect(mine[0], 'and it is not the download form').not.toContain('formAction=');
  });

  it('keys both streams from one form definition, so they cannot drift apart', () => {
    expect(SRC).toContain("name=\"kind\"");
    expect(SRC).toMatch(/\bmtd\b/);
    expect(SRC).toMatch(/\bcp38\b/);
  });
});
