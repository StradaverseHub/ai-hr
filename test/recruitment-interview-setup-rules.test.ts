/**
 * Recruitment slice 18 — the pure rules of interview set-up (packs/recruitment/interview-setup-model.ts): group, question, address
 * and room validation, the https-only map link, group expansion (each current member once; idempotent; nothing about the group
 * kept), the guidance shown (retired questions hidden) and the booking overlap rule (half-open: touching periods do not overlap).
 * The database side is test/recruitment-interview-setup.test.ts. Expected values are written out here, not computed with the module.
 */
import { describe, expect, it } from 'vitest';
import {
  expandInterviewers, guidanceQuestions, interviewPeriod, isHttpsMapLink, periodsOverlap, resolvePlace, validateAddress, validateGroup, validateQuestion,
  validateRoom, GROUP_MEMBERS_MAX,
} from '../packs/recruitment/service';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [A, B, C, D, E] = [id(1), id(2), id(3), id(4), id(5)];

describe('validateGroup', () => {
  it('needs a name of at most 80 characters and at most 20 distinct member ids', () => {
    expect(validateGroup({ name: '  Panel QZW  ', memberIds: [A, B, A] })).toEqual({ ok: true, value: { name: 'Panel QZW', memberIds: [A, B] } });
    expect(validateGroup({ name: ' ', memberIds: [] })).toEqual({ ok: false, code: 'missing_fields', fields: ['name'] });
    expect(validateGroup({ name: 'x'.repeat(81) })).toEqual({ ok: false, code: 'invalid_input', fields: ['name'] });
    expect(validateGroup({ name: 'x'.repeat(80) }).ok).toBe(true);
    expect(validateGroup({ name: 'Panel', memberIds: ['not-a-uuid'] })).toEqual({ ok: false, code: 'invalid_input', fields: ['memberIds'] });
    const many = Array.from({ length: GROUP_MEMBERS_MAX + 1 }, (_, i) => id(100 + i));
    expect(validateGroup({ name: 'Panel', memberIds: many })).toEqual({ ok: false, code: 'invalid_input', fields: ['memberIds'] });
    expect(validateGroup({ name: 'Panel', memberIds: many.slice(0, 20) }).ok).toBe(true);
  });
});

describe('expandInterviewers — each current member once', () => {
  const everyone = () => true;
  it('adds picked people, then each group member in order, with no duplicate of anyone already there', () => {
    const r = expandInterviewers({ existing: [A], picked: [B], groups: [{ id: id(90), memberIds: [A, C, B, D] }, { id: id(91), memberIds: [D, E] }], eligible: everyone });
    expect(r).toEqual({ interviewerIds: [A, B, C, D, E], added: [B, C, D, E], skipped: [] });
  });
  it('is idempotent: adding the same group to the result again adds nobody', () => {
    const groups = [{ id: id(90), memberIds: [B, C] }];
    const first = expandInterviewers({ existing: [A], groups, eligible: everyone });
    const second = expandInterviewers({ existing: first.interviewerIds, groups, eligible: everyone });
    expect(second).toEqual({ interviewerIds: [A, B, C], added: [], skipped: [] });
  });
  it('skips members who no longer have access (and reports them once), but never removes an existing interviewer', () => {
    const r = expandInterviewers({ existing: [D], groups: [{ id: id(90), memberIds: [B, C, D] }, { id: id(91), memberIds: [C] }], eligible: (u) => u !== C && u !== D });
    expect(r).toEqual({ interviewerIds: [D, B], added: [B], skipped: [C] });
  });
  it('keeps nothing of the group: the result is plain user ids, so a later group edit cannot reach it', () => {
    const group = { id: id(90), memberIds: [B] };
    const r = expandInterviewers({ groups: [group], eligible: everyone });
    group.memberIds = [C];
    expect(r.interviewerIds).toEqual([B]);
    expect(JSON.stringify(r)).not.toContain(id(90));
  });
});

describe('validateQuestion and the guidance shown', () => {
  it('title ≤200 required; guidance ≤2,000 and category ≤80 optional; template ids', () => {
    expect(validateQuestion({ title: ' Tell us about a QZW project ', guidance: '  Listen for ownership.\nAsk for numbers.  ', category: ' Experience ', formIds: [A] }))
      .toEqual({ ok: true, value: { title: 'Tell us about a QZW project', guidance: 'Listen for ownership.\nAsk for numbers.', category: 'Experience', formIds: [A] } });
    expect(validateQuestion({ title: '' })).toEqual({ ok: false, code: 'missing_fields', fields: ['title'] });
    expect(validateQuestion({ title: 'x'.repeat(201), guidance: 'g'.repeat(2001), category: 'c'.repeat(81), formIds: ['nope'] }))
      .toEqual({ ok: false, code: 'invalid_input', fields: ['title', 'guidance', 'category', 'formIds'] });
    expect(validateQuestion({ title: 'x'.repeat(200), guidance: 'g'.repeat(2000), category: 'c'.repeat(80) }).ok).toBe(true);
    expect(validateQuestion({ title: 'Q', guidance: '   ', category: '' })).toEqual({ ok: true, value: { title: 'Q', guidance: null, category: null, formIds: [] } });
  });
  it('shows linked questions that are not retired: categories first (alphabetical), uncategorised last, then by title', () => {
    const q = (n: number, title: string, category: string | null, retired = false) => ({ id: id(n), title, guidance: null, category, retired });
    const shown = guidanceQuestions([q(1, 'Zeta', null), q(2, 'Beta', 'Skills'), q(3, 'Alpha', 'Skills', true), q(4, 'Gamma', 'Culture'), q(5, 'Alpha', null)]);
    expect(shown.map((x) => x.title)).toEqual(['Gamma', 'Beta', 'Alpha', 'Zeta']);
    expect(shown.map((x) => x.id)).toEqual([id(4), id(2), id(5), id(1)]);
  });
});

describe('isHttpsMapLink and validateAddress', () => {
  it('accepts full https links only', () => {
    for (const ok of ['https://maps.example.test/?q=QZW+Tower', 'https://example.test', 'https://a-b.example.test:8443/path#frag', 'HTTPS://example.test'.toLowerCase()]) {
      expect(isHttpsMapLink(ok), ok).toBe(true);
    }
    for (const bad of ['http://maps.example.test', 'https://', 'https://localhost', 'https://user:pw@example.test', 'javascript:alert(1)', 'https://exa mple.test',
      'https://example.test/a b', 'https://example.test/"x"', 'https://-bad.example.test', 'ftp://example.test', ' https://example.test', 'https://example.test/<x>',
      `https://example.test/${'p'.repeat(2000)}`, 'https://example.test\\evil', 'HTTPS://example.test']) {
      expect(isHttpsMapLink(bad), bad).toBe(false);
    }
  });
  it('needs a name, an address and a region; refuses a non-https map link as the map link', () => {
    expect(validateAddress({ name: ' QZW Tower ', address: ' 1 Fictional Road ', region: ' Kuala Lumpur ', mapUrl: ' https://maps.example.test/qzw ' }))
      .toEqual({ ok: true, value: { name: 'QZW Tower', address: '1 Fictional Road', region: 'Kuala Lumpur', mapUrl: 'https://maps.example.test/qzw' } });
    expect(validateAddress({ name: '', address: '', region: '' })).toEqual({ ok: false, code: 'missing_fields', fields: ['name', 'address', 'region'] });
    expect(validateAddress({ name: 'N', address: 'A', region: 'R', mapUrl: 'http://maps.example.test' })).toEqual({ ok: false, code: 'invalid_input', fields: ['mapUrl'] });
    expect(validateAddress({ name: 'n'.repeat(121), address: 'a'.repeat(501), region: 'r'.repeat(121) }))
      .toEqual({ ok: false, code: 'invalid_input', fields: ['name', 'address', 'region'] });
    expect(validateAddress({ name: 'N', address: 'A', region: 'R', mapUrl: '' })).toEqual({ ok: true, value: { name: 'N', address: 'A', region: 'R', mapUrl: null } });
  });
});

describe('validateRoom and resolvePlace', () => {
  it('a room has a name and a whole capacity 1–1,000; enabled unless switched off', () => {
    expect(validateRoom({ name: ' Room QZW ', capacity: '8' })).toEqual({ ok: true, value: { name: 'Room QZW', capacity: 8, enabled: true } });
    expect(validateRoom({ name: 'R', capacity: '1000', enabled: false })).toEqual({ ok: true, value: { name: 'R', capacity: 1000, enabled: false } });
    expect(validateRoom({ name: '', capacity: '' })).toEqual({ ok: false, code: 'missing_fields', fields: ['name', 'capacity'] });
    for (const capacity of ['0', '1001', '2.5', '-3', 'ten']) expect(validateRoom({ name: 'R', capacity }), capacity).toEqual({ ok: false, code: 'invalid_input', fields: ['capacity'] });
  });
  it('a room names its address; a room of another address, or a place on a video interview, is refused', () => {
    const owner = (room: string) => (room === C ? A : room === D ? B : null);
    expect(resolvePlace({ type: 'onsite', addressId: null, roomId: null, roomAddress: owner })).toEqual({ ok: true, addressId: null, roomId: null });
    expect(resolvePlace({ type: 'onsite', addressId: A, roomId: null, roomAddress: owner })).toEqual({ ok: true, addressId: A, roomId: null });
    expect(resolvePlace({ type: 'onsite', addressId: null, roomId: C, roomAddress: owner })).toEqual({ ok: true, addressId: A, roomId: C });
    expect(resolvePlace({ type: 'onsite', addressId: A, roomId: C, roomAddress: owner })).toEqual({ ok: true, addressId: A, roomId: C });
    expect(resolvePlace({ type: 'onsite', addressId: A, roomId: D, roomAddress: owner })).toEqual({ ok: false, fields: ['roomId'] });
    expect(resolvePlace({ type: 'onsite', addressId: null, roomId: E, roomAddress: owner })).toEqual({ ok: false, fields: ['roomId'] });
    expect(resolvePlace({ type: 'video', addressId: A, roomId: null, roomAddress: owner })).toEqual({ ok: false, fields: ['addressId'] });
  });
});

describe('the booking overlap rule (the same rule as 5219\'s exclusion constraint)', () => {
  const at = (hhmm: string) => `2026-12-01T${hhmm}:00+08:00`;
  it('half-open periods: touching is allowed, any real overlap is not', () => {
    const tenToEleven = interviewPeriod(at('10:00'), 60);
    expect(tenToEleven.end - tenToEleven.start).toBe(3_600_000);
    expect(periodsOverlap(tenToEleven, interviewPeriod(at('11:00'), 30))).toBe(false); // starts when the first ends
    expect(periodsOverlap(tenToEleven, interviewPeriod(at('09:00'), 60))).toBe(false); // ends when the first starts
    expect(periodsOverlap(tenToEleven, interviewPeriod(at('10:59'), 5))).toBe(true);
    expect(periodsOverlap(tenToEleven, interviewPeriod(at('09:30'), 31))).toBe(true);
    expect(periodsOverlap(tenToEleven, interviewPeriod(at('10:15'), 15))).toBe(true); // inside
    expect(periodsOverlap(interviewPeriod(at('10:15'), 15), tenToEleven)).toBe(true); // symmetric
    expect(periodsOverlap(tenToEleven, interviewPeriod(at('09:00'), 180))).toBe(true); // around
  });
});
