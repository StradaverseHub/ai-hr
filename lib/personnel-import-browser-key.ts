/** React state lifetime only, never an authorization token or a client-supplied permission. */
import 'server-only';
import {createHash} from 'node:crypto';
import type {SessionContext} from '../db/client';

export function personnelImportBrowserKey(ctx:SessionContext,visibleCompanies:readonly string[]):string{
 const grants=(ctx.grants??ctx.roles?.map(role=>({role,companyId:null}))??[])
  .map(grant=>[grant.role,grant.companyId??null] as const)
  .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 return createHash('sha256').update(JSON.stringify(['personnel-import-browser-v1',ctx.tenantId,
  ctx.userId??null,ctx.personId??null,grants,[...new Set(visibleCompanies)].sort()])).digest('hex');
}
