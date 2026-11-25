/**
 * Board 74a7a074 — the rendered Audit Trail detail, in all six locales: one before/after record and one
 * hire record. Fictional fixtures only. Labels are what core/audit-labels.ts would return; an id it did not
 * return (deleted or out of scope) must read "Record not available", and raw ids must appear only inside
 * the collapsed Technical details block.
 */
import { render, within } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';
import type { AuditLabels } from '../lib/audit-fields';

type Catalogue = Record<string, unknown>;
const CATALOGUES: Record<string, Catalogue> = { en, ms, ta, th, vi: vi_, zh };
const current = vi.hoisted(() => ({ locale: 'en' }));
const lookup = (obj: Catalogue, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Catalogue)[k] : undefined), obj);

vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) =>
    Object.assign(
      (key: string, values?: Record<string, unknown>) => {
        let text = String(lookup(CATALOGUES[current.locale], `${ns}.${key}`) ?? `${ns}.${key}`);
        for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, String(value));
        return text;
      },
      { has: () => true },
    ),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: unknown }) => createElement('a', { href, ...props }, children as never),
}));

import { AuditTable } from '../components/audit-table';

const C = '11111111-1111-4111-8111-111111111111';
const E = '22222222-2222-4222-8222-222222222222';
const D1 = '33333333-3333-4333-8333-333333333331';
const D2 = '33333333-3333-4333-8333-333333333332';
const M = '44444444-4444-4444-8444-444444444444';
const M2 = '44444444-4444-4444-8444-444444444445';
const P = '55555555-5555-4555-8555-555555555555';
const PP = '66666666-6666-4666-8666-666666666666';
const at = new Date('2026-11-20T09:14:03.112Z');

const ROWS = [
  {
    id: 'fictional-update', aggregateType: 'employment', aggregateId: E, eventType: 'employment.info.updated', actorType: 'USER',
    actorName: 'SAMPLE ADMIN', occurredAt: at, sequence: 48211,
    payload: { companyId: C, employmentId: E, positionId: P, before: { departmentId: D1, managerEmploymentId: M }, after: { departmentId: D2, managerEmploymentId: M2 } },
  },
  {
    id: 'fictional-hire', aggregateType: 'employment', aggregateId: E, eventType: 'employment.hired', actorType: 'USER',
    actorName: 'SAMPLE ADMIN', occurredAt: at, sequence: 48212,
    payload: {
      employmentInformation: { hiredOn: '2026-11-20', orgBranch: 'Fictional Branch', confirmationDate: null },
      personId: PP, companyId: C, departmentId: D2, businessUnitId: null, hiredOn: '2026-11-20', positionId: P,
      costCenterId: null, gradeId: null, employmentType: 'full_time',
    },
  },
];
// M2 is deliberately missing: deleted or outside the viewer's scope, which must read the same.
const LABELS: AuditLabels = {
  company: { [C]: { label: 'Sample Holdings', code: 'SHB' } },
  employment: { [E]: { label: 'SAMPLE EMPLOYEE', code: 'EMP0001' }, [M]: { label: 'SAMPLE MANAGER', code: 'BD0001' } },
  person: { [PP]: { label: 'SAMPLE EMPLOYEE', code: null } },
  department: { [D1]: { label: 'Sales', code: null }, [D2]: { label: 'Marketing', code: null } },
  position: { [P]: { label: 'Assistant General Manager', code: null } },
};

const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-audit-detail="${id}"]`)!;
const section = (id: string, name: string) => rowOf(id).querySelector<HTMLElement>(`[data-audit-section="${name}"]`)!;
const ALL_IDS = [C, E, D1, D2, M, M2, P, PP];

describe('74a7a074 — readable Audit Trail detail', () => {
  for (const locale of Object.keys(CATALOGUES)) {
    it(`renders Action / Record / Changes / Other details and Technical details in ${locale}`, async () => {
      current.locale = locale;
      const t = (CATALOGUES[locale] as { components: { auditTable: Record<string, string> } }).components.auditTable;
      const { unmount } = render(await AuditTable({ rows: ROWS, nowMs: at.getTime() + 60_000, labels: LABELS }));

      // Before/after record.
      const action = section('fictional-update', 'action');
      expect(action).toHaveTextContent(t.sectionAction);
      expect(action).toHaveTextContent(`${t.doneBy}SAMPLE ADMIN`);
      expect(action).toHaveTextContent('20-Nov-2026');
      const record = section('fictional-update', 'record');
      expect(record).toHaveTextContent(`${t.field_company}Sample Holdings (SHB)`);
      expect(record).toHaveTextContent(`${t.field_employee}SAMPLE EMPLOYEE / EMP0001`);
      expect(record).toHaveTextContent(`${t.field_position}Assistant General Manager`);
      const changes = section('fictional-update', 'changes');
      const headers = within(changes).getAllByRole('columnheader').map((h) => h.textContent);
      expect(headers).toEqual([t.columnField, t.columnPrevious, t.columnUpdated]);
      const body = within(changes).getAllByRole('row').slice(1).map((r) => [...r.children].map((c) => c.textContent));
      expect(body).toEqual([
        [t.field_department, 'Sales', 'Marketing'],
        [t.field_directSuperior, 'SAMPLE MANAGER / BD0001', t.notAvailable],
      ]);
      expect(rowOf('fictional-update')).toHaveTextContent(t.currentNames);

      // Hire record: the record named, the information block read as fields, empties shown as a dash.
      const hireRecord = section('fictional-hire', 'record');
      expect(hireRecord).toHaveTextContent(`${t.field_person}SAMPLE EMPLOYEE`);
      expect(hireRecord).toHaveTextContent(`${t.field_company}Sample Holdings (SHB)`);
      expect(hireRecord).toHaveTextContent(`${t.field_department}Marketing`);
      expect(hireRecord).toHaveTextContent(`${t.field_businessUnit}—`);
      const other = section('fictional-hire', 'other');
      expect(other).toHaveTextContent(`${t.field_hiredOn}2026-11-20`);
      expect(other).toHaveTextContent(`${t.field_employmentType}full_time`);
      expect(other).toHaveTextContent('Fictional Branch');
      expect(section('fictional-hire', 'changes')).toBeNull();

      for (const id of ['fictional-update', 'fictional-hire']) {
        const technical = section(id, 'technical') as HTMLDetailsElement;
        expect(technical.open).toBe(false);
        expect(technical.querySelector('summary')).toHaveTextContent(t.technicalDetails);
        // Raw ids appear only inside Technical details.
        const outside = rowOf(id).cloneNode(true) as HTMLElement;
        outside.querySelector('[data-audit-section="technical"]')!.remove();
        for (const raw of ALL_IDS) expect(outside.textContent, `${locale} ${id} ${raw}`).not.toContain(raw);
      }
      expect(section('fictional-update', 'technical')).toHaveTextContent(`before.departmentId${D1}`);
      expect(section('fictional-update', 'technical')).toHaveTextContent(`after.managerEmploymentId${M2}`);
      expect(section('fictional-hire', 'technical')).toHaveTextContent(`personId${PP}`);
      unmount();
    });
  }

  it('without labels, the original key: value lines render unchanged', async () => {
    current.locale = 'en';
    const { container, unmount } = render(await AuditTable({ rows: ROWS.slice(0, 1), nowMs: at.getTime() }));
    expect(container.querySelector('[data-audit-detail]')).toBeNull();
    expect(container).toHaveTextContent(`departmentId${D1} → ${D2}`);
    expect(container).toHaveTextContent(`companyId${C}`);
    unmount();
  });
});
