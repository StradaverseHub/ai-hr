/** One tenant-wide policy; SQL owns admission, authorization, serialization and audit. */
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { pgSqlState } from '../lib/db-error';

/** 5e0b2154 — allowDuplicatedEmail relaxes the employee-import duplicate work/personal email checks only;
 *  login identity stays unique (app.create_login_person). */
export type PeopleGeneralPolicy = { allowDuplicatedNric: boolean; allowDuplicatedEmail: boolean; revision: string | null };
export class PeopleGeneralError extends Error {
  constructor(readonly reason: 'forbidden' | 'stale' | 'invalid') {
    super(`people-general:${reason}`);
    this.name = 'PeopleGeneralError';
  }
}
export async function readPeopleGeneralTx(tx: Tx): Promise<PeopleGeneralPolicy> {
  const [row] = await tx.execute<{ allow_duplicated_nric: boolean; allow_duplicated_email: boolean; revision: string | null }>(sql`select * from app.people_general_read()`);
  return { allowDuplicatedNric: row?.allow_duplicated_nric === true, allowDuplicatedEmail: row?.allow_duplicated_email === true, revision: row?.revision ?? null };
}
export function getPeopleGeneral(ctx: SessionContext) {
  return withTenant(ctx, readPeopleGeneralTx);
}
export function canConfigurePeopleGeneral(ctx: SessionContext) {
  return withTenant(ctx, async tx => {
    const [row] = await tx.execute<{ allowed: boolean }>(sql`select app.people_general_can_configure() as allowed`);
    return row?.allowed === true;
  });
}
export async function savePeopleGeneral(ctx: SessionContext, policy: PeopleGeneralPolicy, outerTx?: Tx) {
  if (typeof policy.allowDuplicatedNric !== 'boolean' || typeof policy.allowDuplicatedEmail !== 'boolean' || (policy.revision !== null && !/^[0-9a-f-]{36}$/i.test(policy.revision))) throw new PeopleGeneralError('invalid');
  try {
    const run = async (tx: Tx) => {
      const [row] = await tx.execute<{ revision: string }>(sql`select app.people_general_set(${policy.allowDuplicatedNric},${policy.allowDuplicatedEmail},${policy.revision}::uuid) as revision`);
      return { allowDuplicatedNric: policy.allowDuplicatedNric, allowDuplicatedEmail: policy.allowDuplicatedEmail, revision: row.revision };
    };
    return await (outerTx ? run(outerTx) : withTenant(ctx, run));
  } catch (error) {
    if (pgSqlState(error) === '42501') throw new PeopleGeneralError('forbidden');
    if (pgSqlState(error) === 'PN002') throw new PeopleGeneralError('stale');
    throw error;
  }
}
/** The ordinary native setter still returns its UUID. Only this explicit Tx path asks the
 * native-owned protected observation for the exact event/revision pair produced by that call. */
export async function savePeopleGeneralObservedTx(ctx: SessionContext, policy: PeopleGeneralPolicy, tx: Tx) {
  const saved = await savePeopleGeneral(ctx, policy, tx);
  const [row] = await tx.execute<{effect: unknown}>(sql`select app.people_general_policy_native_effect(${saved.revision}::uuid) as effect`);
  return {...saved, effect: row?.effect};
}

/** Queries only submitted keys, with fresh Workforce admission permission; no holder data. */
export async function occupiedNricsTx(tx: Tx, p: { companyId?: string; personId?: string; keys: string[] }): Promise<string[]> {
  if (!p.keys.length) return [];
  const keys = [...new Set(p.keys.filter(Boolean))];
  if (!keys.length) return [];
  const array = sql`ARRAY[${sql.join(keys.map(key => sql`${key}`), sql`, `)}]::text[]`;
  const rows = await tx.execute<{ key: string }>(sql`select app.people_nric_conflicts(${p.companyId ?? null}::uuid,${p.personId ?? null}::uuid,${array}) as key`);
  return rows.map(row => row.key);
}
