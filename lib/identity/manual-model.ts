export const manualIdentityErrorCodes = ['forbidden','invalid','target','conflict','unavailable','uncertain'] as const;
export type ManualIdentityErrorCode = typeof manualIdentityErrorCodes[number];
export class ManualIdentityError extends Error {
  constructor(public readonly code: ManualIdentityErrorCode) { super(`Manual account setup: ${code}`); }
}
export type ManualIdentityEnrollment = {
  id:string; tenant_id:string; person_id:string; created_by:string; issuer:string;
  username:string; email:string; role:string; company_id:string|null;
  status:'reserved'|'prepared'|'linked'|'active'|'cancelled';
  subject:string|null; app_user_id:string|null; created_at:Date;
};
export const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateTemporaryPassword(password:string,username:string,email:string) {
  if(password.length<14||password.length>128||/[\u0000-\u001f\u007f]/.test(password)||
    [username,email].includes(password.toLowerCase())) throw new ManualIdentityError('invalid');
}
/** Never expose a provider/database error: query wrappers can contain parameters, including secrets. */
export function manualIdentityError(error:unknown):ManualIdentityError {
  if(error instanceof ManualIdentityError)return error;
  let current=error; const seen=new Set<unknown>();
  while(current && typeof current==='object' && !seen.has(current)) {
    seen.add(current); const e=current as {message?:unknown;code?:unknown;cause?:unknown};
    if(e.code==='23505')return new ManualIdentityError('conflict');
    for(const code of ['forbidden','invalid','target','conflict'] as const)
      if(e.message===`manual_identity_${code}`)return new ManualIdentityError(code);
    current=e.cause;
  }
  return new ManualIdentityError('unavailable');
}
