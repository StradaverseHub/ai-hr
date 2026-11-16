import {createHmac} from 'node:crypto';
export const RESIGNATION_RUNTIME_PURPOSE='aihr-resignation-runtime-v1';
export function resignationRuntimeKey(master:string):Buffer{if(!/^[a-fA-F0-9]{64}$/.test(master))throw Error('Invalid authentication key.');return createHmac('sha256',Buffer.from(master,'hex')).update(RESIGNATION_RUNTIME_PURPOSE).digest();}
export type ResignationRuntimeClaim={operation:'begin'|'create'|'save'|'context'|'read'|'notify'|'retrySave'|'postingRejected'|'email';caseId?:string;companyId?:string;revision?:number;command?:Record<string,unknown>;args?:Record<string,unknown>};
export function signResignationRuntime(claim:ResignationRuntimeClaim,principal:{tenantId:string;userId:string|null;personId:string|null;transactionId:string},master:string,now=Date.now()){
 const payload=JSON.stringify({v:1,purpose:RESIGNATION_RUNTIME_PURPOSE,...principal,...claim,runner:'resignation-journey',issuedAt:now,expiresAt:now+60_000});
 return{payload,signature:createHmac('sha256',resignationRuntimeKey(master)).update(payload).digest('hex')};
}
