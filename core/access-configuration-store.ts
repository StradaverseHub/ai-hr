/** Concrete restricted-runtime adapter. Database writes independently enforce and audit each edit. */
import {sql} from 'drizzle-orm';
import {pgErrorChain,pgSqlState} from '../lib/db-error';
import {AccessPermissionError} from '../lib/access-permission-model';
import {parseAccessOwnerState} from '../lib/access-owner-state';
import type {AccessConfigurationOwner} from './access-configuration';

function refusal(error:unknown):never{
  const state=pgSqlState(error),messages=pgErrorChain(error).map(link=>link.message);
  if(messages.includes('access last administrator'))throw new AccessPermissionError('lastAdministrator');
  if(messages.includes('access unsupported'))throw new AccessPermissionError('unsupported');
  if(state==='42501')throw new AccessPermissionError('ceiling');
  if(state==='40001')throw new AccessPermissionError('changed');
  if(['23503','23505','23514','22P02'].includes(state??''))throw new AccessPermissionError('invalid');
  throw error; // Infrastructure failures remain failures, not permission guesses or a false success.
}

export const accessConfigurationStore:AccessConfigurationOwner={
  async loadCurrent(tx,ctx){
    try{
      await tx.execute(sql`select app.access_configuration_initialize()`);
      const [row]=await tx.execute<{state:unknown}>(sql`select app.access_configuration_state() as state`);
      return parseAccessOwnerState(row?.state,ctx.tenantId);
    }catch(error){return refusal(error);}
  },
  async persist(tx,_ctx,change){
    try{
      const [row]=await tx.execute<{committed:boolean}>(sql`select app.access_configuration_commit(${change.before.revision}::uuid,${change.scopeFingerprint},${JSON.stringify(change.command)}::jsonb,${change.after.revision}::uuid) as committed`);
      return row?.committed===true;
    }catch(error){return refusal(error);}
  },
};
