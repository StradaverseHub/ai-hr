/** Runtime custody for attachment-bearing emails. This is not a business authorization grant. */
import {createHmac} from 'node:crypto';
export const AUTOMATION_EMAIL_ASSET_PURPOSE='aihr-shared-email-assets-runtime-v1';
export function automationEmailAssetKey(master:string):Buffer{
 if(!/^[a-fA-F0-9]{64}$/.test(master))throw new Error('Invalid authentication key.');
 return createHmac('sha256',Buffer.from(master,'hex')).update(AUTOMATION_EMAIL_ASSET_PURPOSE).digest();
}
export type AutomationEmailAssetClaim={tenantId:string;userId:string|null;personId:string|null;transactionId:string;module:'probation';subjectId:string;key:string;digest:string;to:readonly string[];cc:readonly string[]};
export function signAutomationEmailAsset(claim:AutomationEmailAssetClaim,master:string,now=Date.now()){
 const payload=JSON.stringify({v:1,purpose:AUTOMATION_EMAIL_ASSET_PURPOSE,...claim,issuedAt:now,expiresAt:now+60000});
 return {payload,signature:createHmac('sha256',automationEmailAssetKey(master)).update(payload).digest('hex')};
}
