/** The final release proof is distinct from the content hash each person signed. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {pgSqlState} from '../lib/db-error';
import {ContractManagementError} from '../lib/contract-management-model';
export type ContractSharedReleaseProof={protocol:'contract-release-v1';fingerprint:string;contentHash:string;contentRevision:number;releasedAt:string};
export async function readContractSharedReleaseProof(ctx:SessionContext,letterId:string):Promise<ContractSharedReleaseProof|null>{
 z.uuid().parse(letterId);
 try{return await withScopedLifecycleTenant(ctx,async tx=>{
  await tx.execute(sql`select app.access_workforce_write_lock()`);
  const [row]=await tx.execute<{proof:ContractSharedReleaseProof|null}>(sql`select app.contract_shared_release_proof(${letterId}::uuid) as proof`);return row.proof;
 });}catch(error){if(pgSqlState(error)==='42501')throw new ContractManagementError('forbidden','This document release proof is unavailable.');throw error;}
}
