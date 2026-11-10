/**
 * Audit chain sealed at commit (migration 4700). A tenant's chain position is taken when the transaction
 * commits, under the existing audit-chain key, so a long transaction no longer blocks every other audited
 * write of the tenant. These tests run against real PostgreSQL, through separate connections.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type ReservedSql, type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyTenantChain } from '../core/audit-chain';
import { withTenant } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { grantAssistant } from '../core/assistant-grant';
import { peopleGeneralPolicyReviews } from '../core/assistant-actions/people-general-policy-review-store';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

let b: Base;
let ownerClient: Sql;
let appClient: Sql;
const open: ReservedSql[] = [];

async function begin(client: Sql): Promise<ReservedSql> {
  const c = await client.reserve();
  open.push(c);
  await c`begin`;
  return c;
}
async function finish(c: ReservedSql, verb: 'commit' | 'rollback' = 'commit') {
  await c.unsafe(verb);
  open.splice(open.indexOf(c), 1);
  c.release();
}
async function insertEvent(c: ReservedSql | Sql, tenantId: string, eventType: string, payload: unknown = { fictional: true }) {
  const id = randomUUID();
  await c`insert into public.domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,payload)
    values(${id}::uuid,${tenantId}::uuid,'test',${randomUUID()}::uuid,${eventType},'system',${c.json(payload as never)})`;
  return id;
}
type Row = { id: string; event_type: string; sequence: string; chain_seq: string | null; prev_hash: string | null; hash: string | null };
const rows = (tenantId: string) => ownerClient<Row[]>`select id,event_type,sequence::text,chain_seq::text,prev_hash,hash
  from public.domain_event where tenant_id=${tenantId}::uuid and aggregate_type='test' order by chain_seq nulls first,sequence`;
const pendingCount = async () => Number((await ownerClient`select (select count(*) from app.domain_event_chain_pending)+(select count(*) from app.domain_event_chain_seal) as n`)[0].n);
/** Independent of core/audit-chain.ts: contiguity from 1 and links and digests over every chained row. */
async function assertChainIntact(tenantId: string, expectedChained: number) {
  const broken = await ownerClient`with o as (select *,lag(hash) over (order by chain_seq) ph,row_number() over (order by chain_seq) n
      from public.domain_event where tenant_id=${tenantId}::uuid and chain_seq is not null)
    select chain_seq from o where chain_seq<>n or prev_hash is distinct from coalesce(ph,'GENESIS')
     or hash is distinct from app.domain_event_hash(prev_hash,tenant_id,chain_seq,aggregate_type,aggregate_id,event_type,actor_type::text,actor_id,subject_employment_id,payload)`;
  expect(broken).toEqual([]);
  const [count] = await ownerClient`select count(*)::int n from public.domain_event where tenant_id=${tenantId}::uuid and chain_seq is not null`;
  expect(count.n).toBe(expectedChained);
}
async function armWithHead(tenantId: string) {
  await setSetting(tenantId, 'audit.hash_chain_enabled', true);
  await insertEvent(ownerClient, tenantId, 'seal.head');
  const [head] = await rows(tenantId);
  expect(head.chain_seq).toBe('1');
}
async function keyFreeFromElsewhere(tenantId: string): Promise<boolean> {
  return ownerClient.begin(async (tx) => {
    const [r] = await tx`select pg_try_advisory_xact_lock(hashtext('audit-chain:'||${tenantId}::uuid::text)) ok`;
    return r.ok as boolean;
  }) as Promise<boolean>;
}

beforeAll(async () => {
  await migrateTestDb();
  ownerClient = postgres(process.env.TEST_MIGRATION_DATABASE_URL!, { max: 6, onnotice: () => {} });
  appClient = postgres(process.env.TEST_DATABASE_URL!, { max: 4, onnotice: () => {} });
});
afterAll(async () => {
  await ownerClient.end();
  await appClient.end();
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  open.length = 0;
});

describe('sealing', () => {
  it('assigns contiguous positions in sequence order per transaction across interleaved transactions', async () => {
    await armWithHead(b.tenantId);
    const a = await begin(ownerClient);
    const c = await begin(ownerClient);
    const a1 = await insertEvent(a, b.tenantId, 'a.1');
    const c1 = await insertEvent(c, b.tenantId, 'c.1');
    const a2 = await insertEvent(a, b.tenantId, 'a.2');
    const c2 = await insertEvent(c, b.tenantId, 'c.2');
    const [inside] = await a`select chain_seq,hash from public.domain_event where id=${a1}::uuid`;
    expect(inside).toEqual({ chain_seq: null, hash: null });
    await finish(c);
    await finish(a);
    const after = await rows(b.tenantId);
    expect(after.map((r) => r.chain_seq)).toEqual(['1', '2', '3', '4', '5']);
    // The later committer takes the later positions, and each transaction keeps its own order.
    expect(after.slice(1).map((r) => r.id)).toEqual([c1, c2, a1, a2]);
    await assertChainIntact(b.tenantId, 5);
    expect(await verifyTenantChain(adminCtx(b))).toMatchObject({ valid: true, checked: 5, unchainedInsideChain: 0 });
    expect(await pendingCount()).toBe(0);
  });

  it('seals tenants independently within one transaction', async () => {
    const other = await seedBase();
    await armWithHead(b.tenantId);
    await armWithHead(other.tenantId);
    const a = await begin(ownerClient);
    await insertEvent(a, b.tenantId, 'x.1');
    await insertEvent(a, other.tenantId, 'y.1');
    await insertEvent(a, b.tenantId, 'x.2');
    await finish(a);
    await assertChainIntact(b.tenantId, 3);
    await assertChainIntact(other.tenantId, 2);
    expect(await pendingCount()).toBe(0);
  });

  it('seals events a deferred trigger appends after the first seal has run', async () => {
    await armWithHead(b.tenantId);
    await ownerClient.unsafe(`create function pg_temp_seal_late() returns trigger language plpgsql as $$
      begin
       if new.event_type='late.trigger' then
        insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,payload)
         values(new.tenant_id,'test',gen_random_uuid(),'late.appended','system','{}');
       end if;
       return null;
      end $$`);
    await ownerClient.unsafe(`create constraint trigger zzz_seal_late after insert on public.domain_event deferrable initially deferred for each row execute function pg_temp_seal_late()`);
    try {
      const a = await begin(ownerClient);
      await insertEvent(a, b.tenantId, 'late.trigger');
      await finish(a);
    } finally {
      await ownerClient.unsafe('drop trigger zzz_seal_late on public.domain_event');
      await ownerClient.unsafe('drop function pg_temp_seal_late()');
    }
    await assertChainIntact(b.tenantId, 3);
    expect((await rows(b.tenantId)).map((r) => r.event_type)).toEqual(['seal.head', 'late.trigger', 'late.appended']);
    expect(await pendingCount()).toBe(0);
  });

  it('hashes the stored row, so a later BEFORE trigger cannot make the digest disagree with it', async () => {
    await armWithHead(b.tenantId);
    await ownerClient.unsafe(`create function pg_temp_seal_rewrite() returns trigger language plpgsql as $$
      begin new.payload:=coalesce(new.payload,'{}'::jsonb)||'{"attributed":true}'; return new; end $$`);
    await ownerClient.unsafe(`create trigger zzz_seal_rewrite before insert on public.domain_event for each row execute function pg_temp_seal_rewrite()`);
    try {
      const a = await begin(ownerClient);
      await insertEvent(a, b.tenantId, 'rewritten');
      await finish(a);
    } finally {
      await ownerClient.unsafe('drop trigger zzz_seal_rewrite on public.domain_event');
      await ownerClient.unsafe('drop function pg_temp_seal_rewrite()');
    }
    await assertChainIntact(b.tenantId, 2);
  });
});

describe('rollback', () => {
  it('leaves no event, no pending row and no gap after a transaction rollback', async () => {
    await armWithHead(b.tenantId);
    const a = await begin(ownerClient);
    await insertEvent(a, b.tenantId, 'discarded');
    await finish(a, 'rollback');
    await insertEvent(ownerClient, b.tenantId, 'kept');
    expect((await rows(b.tenantId)).map((r) => [r.event_type, r.chain_seq])).toEqual([['seal.head', '1'], ['kept', '2']]);
    await assertChainIntact(b.tenantId, 2);
    expect(await pendingCount()).toBe(0);
  });

  it('leaves no event and no gap after a savepoint rollback', async () => {
    await armWithHead(b.tenantId);
    const a = await begin(ownerClient);
    await insertEvent(a, b.tenantId, 'before');
    await a`savepoint s1`;
    await insertEvent(a, b.tenantId, 'discarded');
    await a`rollback to savepoint s1`;
    await insertEvent(a, b.tenantId, 'after');
    await finish(a);
    expect((await rows(b.tenantId)).map((r) => [r.event_type, r.chain_seq])).toEqual([['seal.head', '1'], ['before', '2'], ['after', '3']]);
    await assertChainIntact(b.tenantId, 3);
    expect(await pendingCount()).toBe(0);
  });

  it('a failed seal aborts the commit, because committed must still mean chained', async () => {
    await armWithHead(b.tenantId);
    await ownerClient.unsafe(`create function pg_temp_seal_fail() returns trigger language plpgsql as $$
      begin if new.chain_seq is not null then raise exception 'fictional seal failure'; end if; return new; end $$`);
    await ownerClient.unsafe(`create trigger zzz_seal_fail before update on public.domain_event for each row execute function pg_temp_seal_fail()`);
    try {
      const a = await begin(ownerClient);
      await insertEvent(a, b.tenantId, 'unsealable');
      await expect(a`commit`).rejects.toThrow('fictional seal failure');
      open.splice(open.indexOf(a), 1);
      a.release();
    } finally {
      await ownerClient.unsafe('drop trigger zzz_seal_fail on public.domain_event');
      await ownerClient.unsafe('drop function pg_temp_seal_fail()');
    }
    expect((await rows(b.tenantId)).map((r) => r.event_type)).toEqual(['seal.head']);
    expect(await pendingCount()).toBe(0);
  });
});

describe('unarmed tenants and first arming', () => {
  it('leaves an unarmed tenant unchained, keeps caller slots, and takes no key while open', async () => {
    const a = await begin(ownerClient);
    const plain = await insertEvent(a, b.tenantId, 'unarmed');
    const slotted = randomUUID();
    await a`insert into public.domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,chain_seq,prev_hash,hash)
      values(${slotted}::uuid,${b.tenantId}::uuid,'test',${randomUUID()}::uuid,'unarmed.slotted','system',41,'FICTIONAL-PREV','FICTIONAL-HASH')`;
    expect(await keyFreeFromElsewhere(b.tenantId)).toBe(true);
    await finish(a);
    const after = await ownerClient`select id,chain_seq::text,prev_hash,hash from public.domain_event where id in (${plain}::uuid,${slotted}::uuid)`;
    expect(after.find((r) => r.id === plain)).toMatchObject({ chain_seq: null, prev_hash: null, hash: null });
    expect(after.find((r) => r.id === slotted)).toMatchObject({ chain_seq: '41', prev_hash: 'FICTIONAL-PREV', hash: 'FICTIONAL-HASH' });
    expect(await pendingCount()).toBe(0);
  });

  it('serializes two armed writers racing to create the first position, with no fork', async () => {
    await setSetting(b.tenantId, 'audit.hash_chain_enabled', true);
    const a = await begin(ownerClient);
    const c = await begin(ownerClient);
    await insertEvent(a, b.tenantId, 'genesis.a');
    expect(await keyFreeFromElsewhere(b.tenantId)).toBe(false);
    let secondDone = false;
    const second = insertEvent(c, b.tenantId, 'genesis.c').then((id) => { secondDone = true; return id; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(secondDone).toBe(false);
    await finish(a);
    await second;
    await finish(c);
    expect((await rows(b.tenantId)).map((r) => [r.event_type, r.chain_seq])).toEqual([['genesis.a', '1'], ['genesis.c', '2']]);
    await assertChainIntact(b.tenantId, 2);
  });

  it('chains an unarmed writer that commits after the tenant was armed, leaving no hole', async () => {
    const unarmed = await begin(ownerClient);
    await insertEvent(unarmed, b.tenantId, 'straddling');
    await setSetting(b.tenantId, 'audit.hash_chain_enabled', true);
    await insertEvent(ownerClient, b.tenantId, 'first.chained');
    await finish(unarmed);
    expect((await rows(b.tenantId)).map((r) => [r.event_type, r.chain_seq])).toEqual([['first.chained', '1'], ['straddling', '2']]);
    await assertChainIntact(b.tenantId, 2);
    expect((await verifyTenantChain(adminCtx(b))).unchainedInsideChain).toBe(0);
  });

  it('keeps an unarmed writer that committed first outside the chain, as pre-chain history', async () => {
    const unarmed = await begin(ownerClient);
    await insertEvent(unarmed, b.tenantId, 'pre.chain');
    await finish(unarmed);
    await setSetting(b.tenantId, 'audit.hash_chain_enabled', true);
    await insertEvent(ownerClient, b.tenantId, 'first.chained');
    expect((await rows(b.tenantId)).map((r) => [r.event_type, r.chain_seq])).toEqual([['pre.chain', null], ['first.chained', '1']]);
    expect((await verifyTenantChain(adminCtx(b))).unchainedInsideChain).toBe(0);
  });
});

describe('transactions that already own the chain key', () => {
  it('chains immediately after app._domain_event_next, as the Assistant bank and catalogue frames rely on', async () => {
    await armWithHead(b.tenantId);
    const a = await begin(ownerClient);
    const [pre] = await a`select app._domain_event_next(${b.tenantId}::uuid,true) v`;
    expect(pre.v).toMatchObject({ armed: true, priorSeq: 1 });
    const id = await insertEvent(a, b.tenantId, 'framed');
    const [inside] = await a`select chain_seq::text from public.domain_event where id=${id}::uuid`;
    expect(inside.chain_seq).toBe('2');
    expect((await a`select count(*)::int n from app.domain_event_chain_pending`)[0].n).toBe(0);
    await finish(a);
    await assertChainIntact(b.tenantId, 2);
  });

  it('chains immediately after a direct take of the key, as onboarding and lifecycle services do', async () => {
    await armWithHead(b.tenantId);
    const a = await begin(ownerClient);
    await a`select pg_advisory_xact_lock(hashtext('audit-chain:'||${b.tenantId}::uuid::text))`;
    const id = await insertEvent(a, b.tenantId, 'explicit');
    expect((await a`select chain_seq::text from public.domain_event where id=${id}::uuid`)[0].chain_seq).toBe('2');
    await finish(a);
    await assertChainIntact(b.tenantId, 2);
  });

  it('keeps immediate assignment for a REPEATABLE READ writer, whose snapshot cannot read a fresh head at commit', async () => {
    await armWithHead(b.tenantId);
    const a = await ownerClient.reserve();
    open.push(a);
    await a`begin isolation level repeatable read`;
    const id = await insertEvent(a, b.tenantId, 'repeatable.read');
    expect((await a`select chain_seq::text from public.domain_event where id=${id}::uuid`)[0].chain_seq).toBe('2');
    expect((await a`select count(*)::int n from app.domain_event_chain_pending`)[0].n).toBe(0);
    await finish(a);
    await assertChainIntact(b.tenantId, 2);
  });

  it('recognizes the key for tenants whose hash is negative and positive', async () => {
    const seen = new Set<boolean>();
    for (let i = 0; i < 64 && seen.size < 2; i++) {
      const tenant = randomUUID();
      const a = await begin(ownerClient);
      const [hash] = await a`select hashtext('audit-chain:'||${tenant}::uuid::text)<0 negative`;
      expect((await a`select app._domain_event_chain_key_held(${tenant}::uuid) held`)[0].held).toBe(false);
      await a`select pg_advisory_xact_lock(hashtext('audit-chain:'||${tenant}::uuid::text))`;
      expect((await a`select app._domain_event_chain_key_held(${tenant}::uuid) held`)[0].held).toBe(true);
      await finish(a, 'rollback');
      seen.add(hash.negative as boolean);
    }
    expect(seen.size).toBe(2);
  });

  it('holds the prior chain position across a pending event followed by a frame in the same transaction', async () => {
    await armWithHead(b.tenantId);
    const a = await begin(ownerClient);
    const early = await insertEvent(a, b.tenantId, 'pending.first');
    await a`select app._domain_event_next(${b.tenantId}::uuid,true)`;
    const framed = await insertEvent(a, b.tenantId, 'framed.second');
    await finish(a);
    const after = await ownerClient`select id,chain_seq::text from public.domain_event where id in (${early}::uuid,${framed}::uuid)`;
    expect(after.find((r) => r.id === framed)?.chain_seq).toBe('2');
    expect(after.find((r) => r.id === early)?.chain_seq).toBe('3');
    await assertChainIntact(b.tenantId, 3);
  });
});

describe('fences', () => {
  it('seals the receipt event of a completed Assistant root past its completed-root fence', async () => {
    vi.stubEnv('AI_CONFIG_SECRET', 'fictional-audit-seal-key');
    try {
      await setModule(b.tenantId, 'assistant', 'active');
      const ctx = { ...adminCtx(b), grants: [{ role: 'hr_admin' as const, companyId: null }] };
      await grantAssistant(ctx, { appUserId: b.adminUserId });
      await armWithHead(b.tenantId);
      const action = 'org.people_general.change' as const;
      const input = { action, contractVersion: 1, expected: { allowDuplicatedNric: false, allowDuplicatedEmail: false }, desired: { allowDuplicatedNric: true, allowDuplicatedEmail: true } };
      const { review } = await peopleGeneralPolicyReviews.prepare(ctx, input);
      await peopleGeneralPolicyReviews.confirm(ctx, { action, contractVersion: 1, actionId: review.actionId, reviewedDigest: review.reviewedDigest });
      const [event] = await ownerClient`select e.id,e.chain_seq::text,e.hash from public.domain_event e
        join app.assistant_own_leave_review r on r.receipt_event_id=e.id where r.id=${review.actionId}::uuid`;
      expect(event.chain_seq).not.toBeNull();
      expect(event.hash).toHaveLength(64);
      const chained = await ownerClient`select count(*)::int n from public.domain_event where tenant_id=${b.tenantId}::uuid and chain_seq is not null`;
      await assertChainIntact(b.tenantId, chained[0].n as number);
      expect(await pendingCount()).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('gives the application role no access to the seal tables, and it cannot update events', async () => {
    const denied = async (run: () => PromiseLike<unknown>) => {
      await expect(Promise.resolve().then(run)).rejects.toMatchObject({ code: '42501' });
    };
    await denied(() => appClient`select * from app.domain_event_chain_pending`);
    await denied(() => appClient`select * from app.domain_event_chain_seal`);
    await denied(() => appClient`insert into app.domain_event_chain_seal(xid,tenant_id,sealing) values(pg_current_xact_id(),${b.tenantId}::uuid,true)`);
    await denied(() => appClient`select app._domain_event_chain_key_held(${b.tenantId}::uuid)`);
    await denied(() => appClient`update public.domain_event set payload='{}' where tenant_id=${b.tenantId}::uuid`);
  });

  it('every UPDATE trigger on domain_event carries the seal exemption and nothing else was reshaped', async () => {
    const triggers = await ownerClient`select tgname::text, pg_get_triggerdef(oid) def from pg_trigger
      where tgrelid='public.domain_event'::regclass and not tgisinternal and (tgtype & 16)<>0 order by 1`;
    expect(triggers.length).toBe(21);
    for (const t of triggers) expect(t.def, t.tgname as string).toContain('WHEN (((pg_trigger_depth() = 0) OR (NOT app.domain_event_chain_sealing())))');
    const [chain] = await ownerClient`select pg_get_triggerdef(oid) def, tgtype from pg_trigger where tgrelid='public.domain_event'::regclass and tgname='domain_event_chain_tg'`;
    expect(chain.tgtype).toBe(7);
    expect(chain.def).not.toContain('WHEN');
  });

  it('reports not-sealing to ordinary sessions, however the GUCs are set', async () => {
    const a = await begin(ownerClient);
    await a`select set_config('app.audit_chain_sealing','on',true)`;
    await a`select pg_current_xact_id()`;
    expect((await a`select app.domain_event_chain_sealing() s`)[0].s).toBe(false);
    await finish(a, 'rollback');
  });

  it('keeps the contract custody fence on inserts by the application role', async () => {
    await expect(appClient.begin(async (tx) => {
      await tx`select set_config('app.tenant_id',${b.tenantId},true)`;
      await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type) values(${b.tenantId}::uuid,'contract',${randomUUID()}::uuid,'contract.renewed','system')`;
    })).rejects.toBeDefined();
  });

  it('still refuses a direct update of a chained event outside the seal path for the application role', async () => {
    await armWithHead(b.tenantId);
    const [head] = await rows(b.tenantId);
    await expect(appClient`update public.domain_event set chain_seq=${99} where id=${head.id}::uuid`).rejects.toMatchObject({ code: '42501' });
    expect((await rows(b.tenantId))[0].chain_seq).toBe('1');
  });
});

describe('SET CONSTRAINTS ALL IMMEDIATE', () => {
  it('seals at the end of each statement and then holds the key until commit', async () => {
    await armWithHead(b.tenantId);
    const a = await begin(ownerClient);
    const first = await insertEvent(a, b.tenantId, 'immediate.1');
    expect((await a`select chain_seq from public.domain_event where id=${first}::uuid`)[0].chain_seq).toBeNull();
    expect(await keyFreeFromElsewhere(b.tenantId)).toBe(true);
    await a`set constraints all immediate`;
    expect((await a`select chain_seq::text from public.domain_event where id=${first}::uuid`)[0].chain_seq).toBe('2');
    expect(await keyFreeFromElsewhere(b.tenantId)).toBe(false);
    const second = await insertEvent(a, b.tenantId, 'immediate.2');
    expect((await a`select chain_seq::text from public.domain_event where id=${second}::uuid`)[0].chain_seq).toBe('3');
    await finish(a);
    await assertChainIntact(b.tenantId, 3);
    expect(await pendingCount()).toBe(0);
  });
});

describe('non-blocking proof', () => {
  it('login and clock-in complete while another transaction holds audit events open for three seconds', async () => {
    await armWithHead(b.tenantId);
    const ctx = adminCtx(b);
    const a = await begin(ownerClient);
    await insertEvent(a, b.tenantId, 'import.started');
    await insertEvent(a, b.tenantId, 'import.row');
    const opened = performance.now();

    const loginStart = performance.now();
    await appClient.begin(async (tx) => {
      await tx`select app.append_auth_event(${b.tenantId}::uuid,'app-user',${randomUUID()}::uuid,'app-user.login','system',null,null)`;
    });
    const loginMs = performance.now() - loginStart;

    const clockStart = performance.now();
    await withTenant(ctx, async (tx) => {
      await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'attendance', aggregateId: randomUUID(), eventType: 'attendance.clock-in', actor: actorOf(ctx), payload: { fictional: true } });
    });
    const clockMs = performance.now() - clockStart;

    process.stderr.write(`[audit-commit-seal] login ${loginMs.toFixed(1)} ms, clock-in ${clockMs.toFixed(1)} ms\n`);
    expect(loginMs).toBeLessThan(200);
    expect(clockMs).toBeLessThan(200);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 3000 - (performance.now() - opened))));
    expect(await keyFreeFromElsewhere(b.tenantId)).toBe(true);
    await insertEvent(a, b.tenantId, 'import.finished');
    await finish(a);

    const [count] = await ownerClient`select count(*)::int n from public.domain_event where tenant_id=${b.tenantId}::uuid and chain_seq is not null`;
    expect(count.n).toBe(6);
    await assertChainIntact(b.tenantId, 6);
    expect(await verifyTenantChain(ctx)).toMatchObject({ valid: true, checked: 6, unchainedInsideChain: 0 });
  }, 20_000);
});

describe('installed by the non-superuser production owner', () => {
  it('migrates as ai_hr_owner and seals with every definer running as that owner', async () => {
    const database = `ai_hr_seal_owner_${randomBytes(12).toString('hex')}`;
    const adminUrl = new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
    adminUrl.pathname = '/postgres';
    const dbUrl = (user: string) => { const u = new URL(process.env.TEST_MIGRATION_DATABASE_URL!); u.username = user; u.pathname = `/${database}`; return u.toString(); };
    const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${database}"`);
    const directory = mkdtempSync(join(tmpdir(), 'audit-seal-owner-'));
    let fixture: Sql | undefined; let ordinary: Sql | undefined; let application: Sql | undefined;
    try {
      // Everything but this migration, as the fixture superuser, exactly as the database arrived before it.
      mkdirSync(join(directory, 'meta'));
      const journal = JSON.parse(readFileSync('db/migrations/meta/_journal.json', 'utf8'));
      const last = journal.entries.at(-1);
      expect(last.tag).toBe('4700_audit_chain_commit_seal');
      for (const entry of journal.entries) copyFileSync(`db/migrations/${entry.tag}.sql`, join(directory, `${entry.tag}.sql`));
      writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, -1) }));
      fixture = postgres(dbUrl('postgres'), { max: 1, onnotice: () => {} });
      await migrate(drizzle(fixture), { migrationsFolder: directory });

      // Project the production owner shape: a login with no superuser, CREATEROLE or BYPASSRLS owns the schema.
      const objects = await fixture<{ command: string }[]>`
        select format('ALTER SCHEMA %I OWNER TO ai_hr_owner',nspname) command from pg_namespace where nspname in ('app','public','drizzle') and nspowner='postgres'::regrole
        union all select format('ALTER TABLE %I.%I OWNER TO ai_hr_owner',n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname in ('app','public','drizzle') and c.relkind in ('r','p') and c.relowner='postgres'::regrole
        union all select format('ALTER VIEW %I.%I OWNER TO ai_hr_owner',n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname in ('app','public') and c.relkind='v' and c.relowner='postgres'::regrole
        union all select format('ALTER SEQUENCE %I.%I OWNER TO ai_hr_owner',n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname in ('app','public','drizzle') and c.relkind='S' and c.relowner='postgres'::regrole
          and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype in ('a','i'))
        union all select format('ALTER %s %I.%I(%s) OWNER TO ai_hr_owner',case p.prokind when 'p' then 'PROCEDURE' when 'a' then 'AGGREGATE' else 'FUNCTION' end,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname in ('app','public') and p.proowner='postgres'::regrole
          and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')`;
      expect(objects.length).toBeGreaterThan(100);
      for (const object of objects) await fixture.unsafe(object.command);
      await fixture.unsafe(`alter database "${database}" owner to ai_hr_owner`);

      ordinary = postgres(dbUrl('ai_hr_owner'), { max: 1, onnotice: () => {} });
      const [identity] = await ordinary`select session_user login, (select rolsuper or rolbypassrls from pg_roles where rolname=session_user) elevated`;
      expect(identity).toEqual({ login: 'ai_hr_owner', elevated: false });
      writeFileSync(join(directory, 'meta/_journal.json'), JSON.stringify(journal));
      await migrate(drizzle(ordinary), { migrationsFolder: directory });

      const owners = await fixture`select p.proname::text name, p.proowner::regrole::text owner from pg_proc p
        where p.oid in ('app.domain_event_chain_tg()'::regprocedure,'app.domain_event_chain_seal_now()'::regprocedure,'app.domain_event_chain_arm()'::regprocedure,'app.domain_event_chain_sealing()'::regprocedure,'app.append_auth_event(uuid,text,uuid,text,text,uuid,jsonb)'::regprocedure)`;
      expect(owners).toHaveLength(5);
      for (const row of owners) expect(row.owner, row.name as string).toBe('ai_hr_owner');
      const [table] = await fixture`select relowner::regrole::text owner, relforcerowsecurity force from pg_class where oid='public.domain_event'::regclass`;
      expect(table).toEqual({ owner: 'ai_hr_owner', force: false });

      const tenantId = randomUUID();
      await fixture`insert into public.tenant(id,name,workos_org_id) values(${tenantId}::uuid,'Fictional Seal Tenant',${'org_'+tenantId})`;

      // The runtime role: login writes through the definer function, and the seal runs at its commit.
      application = postgres(dbUrl('ai_hr_app'), { max: 2, onnotice: () => {} });
      const login = (event: string) => application!`select app.append_auth_event(${tenantId}::uuid,'app-user',${randomUUID()}::uuid,${event},'system',null,null)`;
      // Arm through the session setting, as withTenant does, so the first position is created by the runtime role.
      await application.begin(async (tx) => {
        await tx`select set_config('app.audit_hash_chain','on',true)`;
        await tx`select app.append_auth_event(${tenantId}::uuid,'app-user',${randomUUID()}::uuid,'app-user.genesis','system',null,null)`;
      });
      await application.begin(async (tx) => {
        await tx`select app.append_auth_event(${tenantId}::uuid,'app-user',${randomUUID()}::uuid,'app-user.one','system',null,null)`;
        await tx`select app.append_auth_event(${tenantId}::uuid,'app-user',${randomUUID()}::uuid,'app-user.two','system',null,null)`;
      });
      await login('app-user.three');

      const chained = await fixture`select event_type,chain_seq::text from public.domain_event where tenant_id=${tenantId}::uuid and chain_seq is not null order by chain_seq`;
      expect(chained.map((r) => [r.event_type, r.chain_seq])).toEqual([['app-user.genesis', '1'], ['app-user.one', '2'], ['app-user.two', '3'], ['app-user.three', '4']]);
      const broken = await fixture`with o as (select *,lag(hash) over (order by chain_seq) ph from public.domain_event where tenant_id=${tenantId}::uuid and chain_seq is not null)
        select chain_seq from o where prev_hash is distinct from coalesce(ph,'GENESIS')
         or hash is distinct from app.domain_event_hash(prev_hash,tenant_id,chain_seq,aggregate_type,aggregate_id,event_type,actor_type::text,actor_id,subject_employment_id,payload)`;
      expect(broken).toEqual([]);
      expect((await fixture`select (select count(*) from app.domain_event_chain_pending)::int p,(select count(*) from app.domain_event_chain_seal)::int s`)[0]).toEqual({ p: 0, s: 0 });
    } finally {
      await application?.end();
      await ordinary?.end();
      await fixture?.end();
      await admin.unsafe(`drop database if exists "${database}" with (force)`);
      await admin.end();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
});

// Kept apart from the harness's drizzle handle so a failed assertion above cannot leave a transaction open.
describe('harness sanity', () => {
  it('runs against the migrated schema with the seal installed', async () => {
    const [row] = await owner.db.execute<{ present: boolean }>(sql`select to_regclass('app.domain_event_chain_pending') is not null present`);
    expect(row.present).toBe(true);
  });
});
