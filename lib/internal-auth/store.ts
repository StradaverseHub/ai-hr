import { client, withPoolWork } from '../../db/client';
import type { AuthSql } from './record-store';
import {readRecord,readRecordPair} from './record-store';
export { readRecord, readRecordPair, writeRecord, deleteRecord, revokeCredentialsSessions } from './record-store';
export type { AuthSql } from './record-store';
/** Pool-owned non-locking reads. Caller-owned transactions keep the explicit leaf
 * functions above and never acquire a second pool admission. No SQL/result cache. */
export function readAuthRecord<T>(key:string):Promise<T|null>{
  return withPoolWork('authentication',()=>readRecord<T>(client,key));
}
export function readAuthRecordPair<T>(firstKey:string,secondKey:string,acceptsFirst:(first:T)=>boolean):Promise<T|null>{
  return withPoolWork('authentication',()=>readRecordPair<T>(client,firstKey,secondKey,acceptsFirst));
}
export async function authTransaction<T>(lock: string, fn: (tx: AuthSql) => Promise<T>): Promise<T> {
  return await withPoolWork('authentication', () => client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('internal-auth:'||$1,0))", [lock]);
    return fn(tx as unknown as AuthSql);
  })) as T;
}
