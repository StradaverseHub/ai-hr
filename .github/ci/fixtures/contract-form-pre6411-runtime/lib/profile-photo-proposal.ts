/** Pending bytes stay in a request-bound table; proposal/audit JSON contains no image or filename. */
export const PROFILE_PHOTO_FIELD='profile.personal_details.photo';
export type ProfilePhotoProposal={v:3;kind:'photo';fieldId:typeof PROFILE_PHOTO_FIELD;baselineHash:string};
export function isProfilePhotoProposal(value:unknown):value is ProfilePhotoProposal{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const p=value as Record<string,unknown>;return Object.keys(p).length===4&&p.v===3&&p.kind==='photo'&&p.fieldId===PROFILE_PHOTO_FIELD&&typeof p.baselineHash==='string'&&/^[0-9a-f]{64}$/.test(p.baselineHash);
}
