/** lib/mobile-api/v2/common.ts: opaque keyset cursors, page bounds, refusal and command shapes. No database. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  COMMAND_CONFLICT, CURSOR_MAX_LENGTH, CommandConflict, MobileRefusal, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, PageRequestRefused,
  commandOf, decodeCursor, encodeCursor, pageOf, pageRequest, refusalOf,
} from '../lib/mobile-api/v2/common';

const Keyset = z.tuple([z.string().min(20), z.string().uuid()]);
const at = '2026-10-28T01:02:03.456+00:00', id = '6f1c2b8e-3d4a-4b5c-9d6e-7f8a9b0c1d2e';
const url = (q: string) => new URL('https://hr.test/api/mobile/v2/notifications' + q);

describe('keyset cursor', () => {
  it('round-trips a tuple through an opaque base64url string', () => {
    const cursor = encodeCursor('notifications', [at, id]);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain(id); // opaque, not a readable query string
    expect(decodeCursor('notifications', cursor, Keyset)).toEqual([at, id]);
    for (const tuple of [[1], ['é漢字'], [null, 0, -1.5, 'x']] as const) {
      expect(decodeCursor('l', encodeCursor('l', tuple), z.array(z.union([z.string(), z.number(), z.null()])))).toEqual(tuple);
    }
  });

  it('reads an absent or empty cursor as the first page', () => {
    expect(decodeCursor('notifications', null, Keyset)).toBeNull();
    expect(decodeCursor('notifications', undefined, Keyset)).toBeNull();
    expect(decodeCursor('notifications', '', Keyset)).toBeNull();
  });

  it('refuses a tampered, garbage, foreign or wrongly shaped cursor with a typed refusal, never another error', () => {
    const cursor = encodeCursor('notifications', [at, id]);
    const flipped = cursor.slice(0, 10) + (cursor[10] === 'A' ? 'B' : 'A') + cursor.slice(11);
    const forged = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const cases = [
      flipped, cursor + 'A', cursor.slice(0, -1) + '=', '!!!!', 'a', '%7B%7D', forged({ v: 1 }), forged([2, 'notifications', at, id]),
      forged([1, 'payslips', at, id]), forged([1, 'notifications', at, 'not-a-uuid']), forged([1, 'notifications']),
      forged([1, 'notifications', at, id, 1, 2, 3]), forged([1, 'notifications', 'x'.repeat(200), id]), Buffer.from([0xff, 0xfe, 0x00]).toString('base64url'),
    ];
    for (const raw of cases) {
      let thrown: unknown;
      try { decodeCursor('notifications', raw, Keyset); } catch (e) { thrown = e; }
      expect(thrown, raw).toBeInstanceOf(PageRequestRefused);
    }
  });

  it('refuses an oversized cursor before decoding it, and never encodes one', () => {
    expect(() => decodeCursor('notifications', 'A'.repeat(CURSOR_MAX_LENGTH + 4), Keyset)).toThrow(PageRequestRefused);
    expect(() => encodeCursor('notifications', ['x'.repeat(129)])).toThrow();
    expect(() => encodeCursor('notifications', [1, 2, 3, 4, 5])).toThrow();
    expect(() => encodeCursor('notifications', [Number.NaN])).toThrow();
  });
});

describe('page request and shape', () => {
  it('defaults to 25, caps at 50 and refuses anything else', () => {
    expect(pageRequest(url(''), 'notifications', Keyset)).toEqual({ limit: PAGE_SIZE_DEFAULT, cursor: null });
    expect(PAGE_SIZE_DEFAULT).toBe(25);
    expect(pageRequest(url('?limit=50'), 'notifications', Keyset).limit).toBe(PAGE_SIZE_MAX);
    for (const q of ['?limit=0', '?limit=51', '?limit=-1', '?limit=2.5', '?limit=1e1', '?limit=', '?limit=10&limit=20', '?cursor=a&cursor=b', '?cursor=@@']) {
      expect(() => pageRequest(url(q), 'notifications', Keyset), q).toThrow(PageRequestRefused);
    }
    const cursor = encodeCursor('notifications', [at, id]);
    expect(pageRequest(url('?limit=10&cursor=' + cursor), 'notifications', Keyset)).toEqual({ limit: 10, cursor: [at, id] });
  });

  it('bounds a page to 50 items and a well-formed cursor or null', () => {
    const Page = pageOf(z.object({ id: z.string() }));
    expect(Page.parse({ items: [{ id: 'a', extra: 1 }], nextCursor: null })).toEqual({ items: [{ id: 'a' }], nextCursor: null });
    expect(Page.safeParse({ items: Array.from({ length: 51 }, () => ({ id: 'a' })), nextCursor: null }).success).toBe(false);
    expect(Page.safeParse({ items: [], nextCursor: 'has spaces' }).success).toBe(false);
    expect(Page.safeParse({ items: [], nextCursor: 'x'.repeat(CURSOR_MAX_LENGTH + 1) }).success).toBe(false);
    expect(Page.safeParse({ items: [] }).success).toBe(false);
  });
});

describe('refusal and command shapes', () => {
  it('a refusal names only its declared codes; the generic shape accepts any code', () => {
    const Refused = refusalOf(['not_released', 'self_approval']);
    expect(Refused.parse({ outcome: 'refused', code: 'self_approval' })).toEqual({ outcome: 'refused', code: 'self_approval' });
    expect(Refused.safeParse({ outcome: 'refused', code: 'request_conflict' }).success).toBe(false);
    expect(MobileRefusal.parse({ outcome: 'refused', code: 'request_conflict', message: 'x' }).code).toBe('request_conflict');
    expect(MobileRefusal.safeParse({ outcome: 'refused', code: 'Has Space' }).success).toBe(false);
    expect(CommandConflict.parse(COMMAND_CONFLICT)).toEqual({ outcome: 'refused', code: 'request_conflict' });
  });

  it('a command requires a uuid requestId and refuses unknown keys', () => {
    const Decide = commandOf({ decision: z.enum(['approve', 'reject']) });
    expect(Decide.parse({ requestId: id, decision: 'approve' })).toEqual({ requestId: id, decision: 'approve' });
    expect(Decide.safeParse({ requestId: 'nope', decision: 'approve' }).success).toBe(false);
    expect(Decide.safeParse({ requestId: id, decision: 'approve', employmentId: id }).success).toBe(false);
  });
});
