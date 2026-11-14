/**
 * Recruitment slice 18 — interview set-up: the pure rules (docs/recruitment-reconstruction/specification.md "Slice 18", D-058).
 * Deterministic and client-safe: no database, no clock, no model. ./interview-setup runs every write through these checks; 5719's
 * CHECKs, guards and exclusion constraint refuse the same independently.
 *
 *   Interviewer groups  a name (≤80, unique in the company) and up to GROUP_MEMBERS_MAX members. Adding a group to an interview adds
 *                       each CURRENT member who still has access as an individual interviewer, once (expandInterviewers): the group
 *                       is not remembered on the interview, so later group edits change no interview.
 *   Question bank       a title (≤200), optional guidance (≤2,000) and category (≤80), linked to scorecard templates. Questions are
 *                       read-only guidance on the feedback form: never answered, never scored.
 *   Addresses, rooms    name (≤120), address (≤500), region (≤120), an optional map link that must be https (isHttpsMapLink); rooms
 *                       with a name (≤120), a capacity (1–1,000) and an enabled switch. A room is booked for an interview's period
 *                       [start, start + duration): two periods overlap exactly when each starts before the other ends, so touching
 *                       periods (one ends when the other starts) do NOT overlap (periodsOverlap — the rule 5719's exclusion
 *                       constraint applies with tstzrange '[)' and &&).
 */
import { isUuid } from './model';

export const GROUP_NAME_MAX = 80;
export const GROUP_MEMBERS_MAX = 20;
export const GROUPS_MAX = 100;
export const QUESTION_TITLE_MAX = 200;
export const QUESTION_GUIDANCE_MAX = 2000;
export const QUESTION_CATEGORY_MAX = 80;
export const QUESTIONS_MAX = 500;
/** The most questions linked to one scorecard template (the feedback form shows them all). */
export const FORM_QUESTIONS_MAX = 30;
export const ADDRESS_NAME_MAX = 120;
export const ADDRESS_TEXT_MAX = 500;
export const ADDRESS_REGION_MAX = 120;
export const MAP_LINK_MAX = 2000;
export const ADDRESSES_MAX = 100;
export const ROOM_NAME_MAX = 120;
export const ROOM_CAPACITY_MAX = 1000;
export const ROOMS_PER_ADDRESS_MAX = 50;
/** The most interviewers on one interview (slice 2's limit). */
export const INTERVIEWERS_MAX = 20;

type Refused = { ok: false; code: 'missing_fields' | 'invalid_input'; fields: string[] };

const text = (value: unknown, max: number): string | null | undefined => {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  if (!t) return null;
  return t.length <= max ? t : undefined;
};
const idList = (value: unknown, max: number): string[] | undefined => {
  const list = (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]).filter((v) => v !== '');
  const unique = [...new Set(list)];
  return unique.length <= max && unique.every(isUuid) ? (unique as string[]) : undefined;
};
const flag = (value: unknown) => value === true || value === 'on' || value === 'true';

// ── Groups ───────────────────────────────────────────────────────────────────────────────────────────────────

export type GroupInput = { name?: unknown; memberIds?: unknown };
export type ValidGroup = { name: string; memberIds: string[] };
/** A group: a name (≤80) and 0–20 distinct member ids. Whether the members have access to the company is the service's check. */
export function validateGroup(input: GroupInput): { ok: true; value: ValidGroup } | Refused {
  const name = text(input.name, GROUP_NAME_MAX);
  if (name === null) return { ok: false, code: 'missing_fields', fields: ['name'] };
  const memberIds = idList(input.memberIds, GROUP_MEMBERS_MAX);
  const invalid = [...(name === undefined ? ['name'] : []), ...(memberIds === undefined ? ['memberIds'] : [])];
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  return { ok: true, value: { name: name!, memberIds: memberIds! } };
}

/**
 * The interviewers of an interview after adding people and groups: `existing` first (kept as they are), then the picked people,
 * then each group's members in the order given — every user once. A member who may not interview for the company now (`eligible`
 * says no: archived, or no longer employed by the company or administering it) is skipped and reported; a picked person is not
 * filtered here (the service refuses an ineligible pick outright). Nothing about the group is kept, so a later group edit changes
 * no interview.
 */
export function expandInterviewers(input: {
  existing?: readonly string[]; picked?: readonly string[]; groups?: readonly { id: string; memberIds: readonly string[] }[]; eligible: (userId: string) => boolean;
}): { interviewerIds: string[]; added: string[]; skipped: string[] } {
  const seen = new Set<string>(input.existing ?? []);
  const added: string[] = [];
  const skipped = new Set<string>();
  const add = (id: string) => { if (!seen.has(id)) { seen.add(id); added.push(id); } };
  for (const id of input.picked ?? []) add(id);
  for (const g of input.groups ?? []) {
    for (const id of g.memberIds) {
      if (seen.has(id)) continue;
      if (input.eligible(id)) add(id);
      else skipped.add(id);
    }
  }
  return { interviewerIds: [...(input.existing ?? []), ...added], added, skipped: [...skipped] };
}

// ── Questions ────────────────────────────────────────────────────────────────────────────────────────────────

export type QuestionInput = { title?: unknown; guidance?: unknown; category?: unknown; formIds?: unknown };
export type ValidQuestion = { title: string; guidance: string | null; category: string | null; formIds: string[] };
/** A question: a title (≤200), optional guidance (≤2,000, line breaks kept) and category (≤80), and the templates it is linked to. */
export function validateQuestion(input: QuestionInput): { ok: true; value: ValidQuestion } | Refused {
  const title = text(input.title, QUESTION_TITLE_MAX);
  if (title === null) return { ok: false, code: 'missing_fields', fields: ['title'] };
  const guidance = input.guidance == null || input.guidance === '' ? null
    : typeof input.guidance === 'string' ? (input.guidance.trim() ? (input.guidance.trim().length <= QUESTION_GUIDANCE_MAX ? input.guidance.trim() : undefined) : null) : undefined;
  const category = text(input.category, QUESTION_CATEGORY_MAX);
  const formIds = idList(input.formIds, 50);
  const invalid = [
    ...(title === undefined ? ['title'] : []), ...(guidance === undefined ? ['guidance'] : []), ...(category === undefined ? ['category'] : []),
    ...(formIds === undefined ? ['formIds'] : []),
  ];
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  return { ok: true, value: { title: title!, guidance: guidance ?? null, category: category ?? null, formIds: formIds! } };
}

export type GuidanceQuestion = { id: string; title: string; guidance: string | null; category: string | null; retired: boolean };
/**
 * What the feedback form shows for a template: its linked questions that are NOT retired, read when the form is rendered (a retired
 * question disappears from every feedback form opened afterwards; questions are guidance only, so nothing stored refers to them).
 * Grouped by category (uncategorised last), then by title.
 */
export function guidanceQuestions<Q extends GuidanceQuestion>(linked: readonly Q[]): Q[] {
  return linked.filter((q) => !q.retired).sort((a, b) =>
    (a.category === null ? 1 : 0) - (b.category === null ? 1 : 0) || (a.category ?? '').localeCompare(b.category ?? '') || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

// ── Addresses and rooms ──────────────────────────────────────────────────────────────────────────────────────

const HOST_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;
/**
 * An https map link: exactly the scheme "https://", a host name of two or more dot-separated labels (letters, digits, hyphens), no
 * user name or password, an optional port, then an optional path, query or fragment without spaces, control characters, quotes,
 * angle brackets, backslashes or backticks; at most 2,000 characters. The same shape as 5719's CHECK.
 */
export function isHttpsMapLink(value: string): boolean {
  if (value.length > MAP_LINK_MAX || !value.startsWith('https://')) return false;
  if (/[\s\u0000-\u001f\u007f"<>\\`]/.test(value)) return false;
  const rest = value.slice('https://'.length);
  const cut = rest.search(/[/?#]/);
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!m) return false;
  const labels = m[1].split('.');
  return labels.length >= 2 && labels.every((l) => HOST_LABEL.test(l));
}

export type AddressInput = { name?: unknown; address?: unknown; region?: unknown; mapUrl?: unknown };
export type ValidAddress = { name: string; address: string; region: string; mapUrl: string | null };
export function validateAddress(input: AddressInput): { ok: true; value: ValidAddress } | Refused {
  const name = text(input.name, ADDRESS_NAME_MAX);
  const address = text(input.address, ADDRESS_TEXT_MAX);
  const region = text(input.region, ADDRESS_REGION_MAX);
  const missing = [...(name === null ? ['name'] : []), ...(address === null ? ['address'] : []), ...(region === null ? ['region'] : [])];
  if (missing.length) return { ok: false, code: 'missing_fields', fields: missing };
  const mapUrl = input.mapUrl == null || input.mapUrl === '' ? null : typeof input.mapUrl === 'string' ? (input.mapUrl.trim() || null) : undefined;
  const invalid = [
    ...(name === undefined ? ['name'] : []), ...(address === undefined ? ['address'] : []), ...(region === undefined ? ['region'] : []),
    ...(mapUrl === undefined || (mapUrl !== null && !isHttpsMapLink(mapUrl)) ? ['mapUrl'] : []),
  ];
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  return { ok: true, value: { name: name!, address: address!, region: region!, mapUrl: mapUrl ?? null } };
}

export type RoomInput = { name?: unknown; capacity?: unknown; enabled?: unknown };
export type ValidRoom = { name: string; capacity: number; enabled: boolean };
export function validateRoom(input: RoomInput): { ok: true; value: ValidRoom } | Refused {
  const name = text(input.name, ROOM_NAME_MAX);
  const rawCapacity = typeof input.capacity === 'number' ? String(input.capacity) : typeof input.capacity === 'string' ? input.capacity.trim() : '';
  const missing = [...(name === null ? ['name'] : []), ...(rawCapacity === '' ? ['capacity'] : [])];
  if (missing.length) return { ok: false, code: 'missing_fields', fields: missing };
  const capacity = /^\d{1,4}$/.test(rawCapacity) ? Number(rawCapacity) : NaN;
  const invalid = [...(name === undefined ? ['name'] : []), ...(!(capacity >= 1 && capacity <= ROOM_CAPACITY_MAX) ? ['capacity'] : [])];
  if (invalid.length) return { ok: false, code: 'invalid_input', fields: invalid };
  return { ok: true, value: { name: name!, capacity, enabled: input.enabled === undefined ? true : flag(input.enabled) } };
}

/**
 * Where an on-site interview takes place: an address, optionally one of its rooms. A room alone names its address (`roomAddress`
 * looks it up); a room of another address than the chosen one is refused. Free text (site, meeting room) stays for other cases.
 */
export function resolvePlace(input: { type: string; addressId: string | null; roomId: string | null; roomAddress: (roomId: string) => string | null }):
  { ok: true; addressId: string | null; roomId: string | null } | { ok: false; fields: string[] } {
  if (!input.addressId && !input.roomId) return { ok: true, addressId: null, roomId: null };
  if (input.type !== 'onsite') return { ok: false, fields: [input.roomId ? 'roomId' : 'addressId'] };
  if (!input.roomId) return { ok: true, addressId: input.addressId, roomId: null };
  const owner = input.roomAddress(input.roomId);
  if (!owner || (input.addressId && input.addressId !== owner)) return { ok: false, fields: ['roomId'] };
  return { ok: true, addressId: owner, roomId: input.roomId };
}

/** An interview's period in epoch milliseconds, half-open: [start, start + minutes). */
export function interviewPeriod(startsAt: Date | string, durationMinutes: number): { start: number; end: number } {
  const start = new Date(startsAt).getTime();
  return { start, end: start + durationMinutes * 60_000 };
}
/** Two half-open periods overlap exactly when each starts before the other ends; touching periods do not. */
export function periodsOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}
