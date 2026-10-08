/**
 * r418 (items e74af58c and 5c31d379) — THE IDENTITY NUMBER BORANG 8A AND BORANG A PRINT, with no database.
 *
 * `statutoryIdentityFor` is the one rule both reads use; every branch is pinned here. The two agency upload
 * files are NOT changed by r418 (their own specs carry an IC / SOCSO foreign-worker number and no passport),
 * so this file also pins that the file-side rows put the STORED IC FIELD in the `ic` slot and never the
 * printed passport. test/r418-statutory-identity-report.test.ts drives the same rule through the reads.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { statutoryIdentityFor } from '../localization/my/statutory-identity';
import { borang8AFrom } from '../lib/borang-8a';
import { borangAFrom } from '../lib/borang-a';
import { borangAFileReadiness, buildBorangAFile, parseBorangAFileTotals } from '../lib/kwsp-borang-a-file';
import { borang8AFileRows } from '../app/payroll/borang-8a/shared';
import { borangAFileRows } from '../app/payroll/borang-a/shared';

const id = (p: Partial<Parameters<typeof statutoryIdentityFor>[0]>) =>
  statutoryIdentityFor({ epfCitizenship: null, nationality: null, icNumber: null, passportNumber: null, ...p });

describe('statutoryIdentityFor — every branch of the approved rule', () => {
  it('non_citizen → the passport number', () => {
    expect(id({ epfCitizenship: 'non_citizen', nationality: 'Australian', passportNumber: 'PA1234567' })).toEqual({
      value: 'PA1234567',
      kind: 'passport',
      missing: null,
    });
  });
  it('non_citizen → the passport even when an IC is also on file (the status decides, not what happens to exist)', () => {
    expect(id({ epfCitizenship: 'non_citizen', icNumber: '900101015555', passportNumber: 'PA1234567' }).value).toBe('PA1234567');
  });
  it('non_citizen with no passport → missing "Passport number", even with an IC on file', () => {
    expect(id({ epfCitizenship: 'non_citizen', nationality: 'Australian' })).toEqual({ value: '', kind: null, missing: 'Passport number' });
    expect(id({ epfCitizenship: 'non_citizen', icNumber: '900101015555' }).missing).toBe('Passport number');
    // Whitespace is not a number.
    expect(id({ epfCitizenship: 'non_citizen', passportNumber: '   ' }).missing).toBe('Passport number');
  });
  it('pr → the IC field, as the MyPR number', () => {
    expect(id({ epfCitizenship: 'pr', icNumber: '850505055555', passportNumber: 'X1' })).toEqual({
      value: '850505055555',
      kind: 'mypr',
      missing: null,
    });
  });
  it('pr with no IC field → missing "MyPR number" (a passport does not stand in for it)', () => {
    expect(id({ epfCitizenship: 'pr', passportNumber: 'X1', nationality: 'Indonesian' })).toEqual({
      value: '',
      kind: null,
      missing: 'MyPR number',
    });
  });
  it('citizen with an IC → the IC, whatever the nationality text says (the production Singaporean keeps the IC)', () => {
    expect(id({ epfCitizenship: 'citizen', nationality: 'Singaporean', icNumber: '880808085555', passportNumber: 'K1234567' })).toEqual({
      value: '880808085555',
      kind: 'ic',
      missing: null,
    });
    expect(id({ epfCitizenship: 'citizen', nationality: 'Malaysian', icNumber: ' 880808085555 ' }).value).toBe('880808085555');
  });
  it('NO statutory row (null status) is read as a citizen', () => {
    expect(id({ icNumber: '880808085555' })).toEqual({ value: '880808085555', kind: 'ic', missing: null });
    expect(id({})).toEqual({ value: '', kind: null, missing: 'IC' });
  });
  it('citizen with no IC, a non-Malaysian nationality and a passport → the passport', () => {
    expect(id({ epfCitizenship: 'citizen', nationality: 'Singaporean', passportNumber: 'K1234567' })).toEqual({
      value: 'K1234567',
      kind: 'passport',
      missing: null,
    });
    expect(id({ nationality: 'Australian', passportNumber: 'PA1' }).kind).toBe('passport');
  });
  it('citizen with no IC and a non-Malaysian nationality but no passport → missing "IC or passport number"', () => {
    expect(id({ epfCitizenship: 'citizen', nationality: 'Singaporean' }).missing).toBe('IC or passport number');
  });
  it('citizen with no IC, a MALAYSIAN or blank nationality → missing "IC", and a passport does NOT stand in', () => {
    for (const nationality of ['Malaysian', 'malaysia', 'MY', 'MYS', '', '  ', null]) {
      expect(id({ epfCitizenship: 'citizen', nationality, passportNumber: 'A1234567' }), String(nationality)).toEqual({
        value: '',
        kind: null,
        missing: 'IC',
      });
    }
  });
  it('is client-safe: imports nothing but the leaf nationality helper', () => {
    const src = fs.readFileSync(path.join(__dirname, '../localization/my/statutory-identity.ts'), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./ic-dob']);
    // Comments name what it avoids; the CODE must not use any of it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code.length).toBeGreaterThan(500);
    expect(code).not.toMatch(/'use client'|db\/client|next-intl/);
  });
});

/** A row as the reads emit it for the reported case: the printed number is the passport, the IC field empty. */
const passportRow8a = {
  employmentId: 'eD',
  startDate: '',
  stopDate: '',
  status: '',
  ic: 'PA1234567',
  idKind: 'passport',
  icNumber: '',
  name: 'EMPLOYEE D',
  contribution: 10,
  socsoEmployer: 7,
  socsoEmployee: 3,
  eisEmployer: 0,
  eisEmployee: 0,
  wage: 3000,
  skbbk: 0,
};
const citizenRow8a = { ...passportRow8a, employmentId: 'eA', ic: '900101015555', idKind: 'ic', icNumber: '900101015555', name: 'EMPLOYEE A' };

describe('the PERKESO ASSIST file keeps carrying the IC field (its own spec names no passport)', () => {
  it('the printed Borang 8A row carries the passport; the file rows carry the stored IC field', () => {
    const form = borang8AFrom({ header: {}, rows: [citizenRow8a, passportRow8a] });
    expect(form.pages[0].rows.map((r) => r.ic)).toEqual(['900101015555', 'PA1234567']);
    const { rows, passportOnly } = borang8AFileRows(form);
    expect(rows.map((r) => r.ic)).toEqual(['900101015555', '']);
    expect(passportOnly).toEqual(['EMPLOYEE D']);
  });
  it('a row shaped before r418 (no icNumber key) keeps its `ic` as the IC field — the pre-r418 file bytes', () => {
    const { idKind: _k, icNumber: _i, ...old } = citizenRow8a;
    const form = borang8AFrom({ header: {}, rows: [old] });
    expect(borang8AFileRows(form).rows[0].ic).toBe('900101015555');
    expect(borang8AFileRows(form).passportOnly).toEqual([]);
  });
});

const passportRowA = {
  employmentId: 'eD',
  memberNo: '17955667',
  ic: 'PA1234567',
  idKind: 'passport',
  icNumber: '',
  name: 'EMPLOYEE D',
  staffNo: 'D1',
  wage: 3000,
  employer: 60,
  employee: 60,
  wageRecorded: 'yes',
};

describe('the KWSP i-Akaun file keeps carrying the IC field (the one real EPFORMA2 file has no passport field)', () => {
  it('the printed Borang A row carries the passport; the file rows carry the stored IC field', () => {
    const form = borangAFrom({ header: {}, rows: [passportRowA] });
    expect(form.pages[0].rows[0].ic).toBe('PA1234567');
    expect(borangAFileRows(form)[0].ic).toBe('');
  });
  it('the file refuses the passport-only person by name, saying why', () => {
    const form = borangAFrom({ header: {}, rows: [passportRowA] });
    const r = borangAFileReadiness({ employerRef: '019632261', rows: borangAFileRows(form) });
    expect(r.ok).toBe(false);
    expect(r.employees).toEqual([
      {
        employmentId: 'eD',
        name: 'EMPLOYEE D',
        problem: "only a passport number is on file, and the upload file's identity field holds a 12-digit identity card number",
      },
    ]);
  });
  it('a citizen without an IC keeps the old wording', () => {
    const form = borangAFrom({ header: {}, rows: [{ ...passportRowA, ic: '', idKind: '', icNumber: '' }] });
    const r = borangAFileReadiness({ employerRef: '019632261', rows: borangAFileRows(form) });
    expect(r.employees.map((e) => e.problem)).toEqual(['no identity card number']);
  });
  it('the EPFORMA2 writer still builds a month with no member rows: header, employer, trailer, zero totals', () => {
    const text = buildBorangAFile({
      employer: { epfRefNo: '019632261', code: '', periodMonth: 8, periodYear: 2026 },
      employees: [],
      fileDate: new Date(2026, 7, 13),
    });
    expect(text.split('\r\n').map((l) => l.slice(0, 2))).toEqual(['00', '01', '99']);
    const t = parseBorangAFileTotals(text);
    expect([t.detailCount, t.trailerCount, t.headerEmployerCents, t.headerEmployeeCents]).toEqual([0, 0, 0, 0]);
  });
});
