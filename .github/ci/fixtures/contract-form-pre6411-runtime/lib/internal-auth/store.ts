import { client, withPoolWork } from '../../db/client';
import type { AuthSql } from './record-store';
import {readRecord,readRecordPair} from './record-store';
export { readRecord, readRecordPair, writeRecord, deleteRecord, revokeCredentialsSessions } from './record-store';
export type { AuthSql } from './record-store';
/** An admitted AuthSql for pool-owned leaf reads and writes, so a raw call never waits unbounded in the
 * driver queue. Transaction owners keep passing their own tx. This facade never re-runs a statement; only a
 * refused admission, which started nothing, is asked for again (db/client.ts withPoolWork). */
export const admittedAuthSql = { unsafe: (query: string, parameters?: never[]) => withPoolWork('authentication', () => client.unsafe(query, parameters)) } as unknown as AuthSql;
/** Pool-owned non-locking reads. Caller-owned transactions keep the explicit leaf
 * functions above and never acquire a second pool admission. No SQL/result cache. */
export function readAuthRecord<T>(key:string):Promise<T|null>{
  return withPoolWork('authentication',()=>readRecord<T>(client,key),undefined,{idempotent:true});
}
export function readAuthRecordPair<T>(firstKey:string,secondKey:string,acceptsFirst:(first:T)=>boolean):Promise<T|null>{
  return withPoolWork('authentication',()=>readRecordPair<T>(client,firstKey,secondKey,acceptsFirst),undefined,{idempotent:true});
}
/** One admitted connection for a serial authentication read. There is no BEGIN:
 * native guards keep their original statement snapshots. Finish before any
 * authTransaction, external IO or unrelated work, and always release on refusal. */
export function withAuthReadConnection<T>(read:(connection:AuthSql)=>Promise<T>):Promise<T>{
  return withPoolWork('authentication',async()=>{
    const connection=await client.reserve();
    try{return await read(connection);}
    finally{connection.release();}
  });
}
export async function authTransaction<T>(lock: string, fn: (tx: AuthSql) => Promise<T>, signal?: AbortSignal): Promise<T> {
  return await withPoolWork('authentication', () => client.begin(async tx => {
    await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('internal-auth:'||$1,0))", [lock]);
    return fn(tx as unknown as AuthSql);
  }), signal) as T;
}
