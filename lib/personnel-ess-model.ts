/** Explicit employee authority metadata; import/report eligibility never grants ESS access. */
export type PersonnelEssOwner='person'|'compliance'|'bank'|'identity'|'passport'|'registration'|'taxLegacy'|'dependent'|'qualification'|'emergency';
export type PersonnelEssMetadata={
 visibility:'visible'|'protected';
 edit:'immediate'|'approval'|'viewOnly'|'specialist';
 reason:string;
 binding?:{owner:PersonnelEssOwner;field:string;legacyKey?:string;nullable?:boolean};
 masked?:boolean;
 /** Compatibility defaults are finite; adding a descriptor never adds a default right. */
 legacyImmediate?:boolean;
 /** Exact existing primary register row only; never create or other-row authority. */
 legacyPrimaryKey?:string;
};
export type EssScalar=string|number|boolean|null;
export type EssFieldChange={fieldId:string;before:EssScalar;value:EssScalar};
export type EssRegisterChange={kind:'dependent'|'qualification'|'emergency';id:string|null;clientId:string;fields:EssFieldChange[]};
export type EssProfileProposal={v:2;fields:EssFieldChange[];registers:EssRegisterChange[]};
export type EssProfileSubmission={employmentId:string;proposal:EssProfileProposal};
export type EssProfileFailureCode='invalid'|'permission'|'fieldClosed'|'stale'|'unavailable'|'addressReview'|'system';
export class EssProfileError extends Error{
 constructor(readonly code:Exclude<EssProfileFailureCode,'system'>,readonly fieldIds:readonly string[]=[]){super('The profile change could not be applied.');this.name='EssProfileError';}
}
export const ESS_PROFILE_TABS=['Profile','Family','Employment','Employment History','Attendance','Bank & Statutory','Payroll','Leave','Documents','Qualification','Others'] as const;
