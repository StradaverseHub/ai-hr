/**
 * ADR-0030 (G3) Layer-0 guard — no cleartext sensitive PII in append-only DomainEvent payloads.
 * The `domain_event` log is immutable (REVOKE UPDATE/DELETE), so any salary / bank / NRIC written into a
 * payload can never be erased (PDPA conflict, finding S1). Event payloads must reference the row that
 * holds the value (via aggregateId or an explicit *Id), never inline the cleartext. This test scans the
 * service layer and fails the build if a banned key appears in an appendEvent `payload:` literal.
 * (Single-line payloads are the repo convention; object-spreads into payloads are banned in review.)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Keys that must NEVER appear as a DomainEvent payload key (they are personal/financial PII; reference
// the owning row instead). `amount` covers the per-person claim/component/pay figures.
const BANNED = [
  'basicSalary', 'bankName', 'bankAccountNo', 'icNumber', 'netPay', 'grossPay',
  'epfNumber', 'socsoNumber', 'taxNumber', 'overtimeAmount', 'bonusAmount', 'tp1Deduction', 'zakat', 'amount',
  // b4682879 — PDPA 2010 s.40 sensitive demographics: log them by field NAME, never inline the value.
  'religion', 'race',
];

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

describe('ADR-0030 Layer-0 — no cleartext PII in DomainEvent payloads', () => {
  const root = join(__dirname, '..', 'core');
  for (const file of tsFiles(root)) {
    const rel = file.slice(root.length + 1);
    it(`core/${rel} payloads reference, never inline, sensitive values`, () => {
      const offenders: string[] = [];
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const idx = line.indexOf('payload:');
        if (idx === -1) return;
        const after = line.slice(idx);
        for (const key of BANNED) {
          if (new RegExp(`\\b${key}\\s*:`).test(after)) offenders.push(`core/${rel}:${i + 1} → '${key}:'`);
        }
      });
      expect(offenders, `\nBanned PII key(s) in an event payload:\n${offenders.join('\n')}\n`).toEqual([]);
    });
  }
});
