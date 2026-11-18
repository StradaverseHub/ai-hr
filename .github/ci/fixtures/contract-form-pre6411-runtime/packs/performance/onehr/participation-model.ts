/** Source participation(): adding/removing somebody never changes their right to rate colleagues. */
export type ParticipationOverride = 'add' | 'remove' | null;
/** D-P1-22: 'unit_out' is the cycle exclusion rule (company or exact department not taking part). */
export type ParticipationReason = 'added' | 'removed' | 'confirmed' | 'not_confirmed' | 'confirmed_after_open' | 'left' | 'native_rule' | 'existing_review' | 'unit_out';
/** Precedence (ADR-0150): left, then the unit rule, then the per-person override, then the opening rule. */
export function assessmentParticipation(input:{left:boolean;yearsOfService:number|null;confirmationDate:string|null;override?:ParticipationOverride;unitOut?:boolean},openedOn:string):{takingPart:boolean;reason:ParticipationReason} {
 if(input.left)return {takingPart:false,reason:'left'};
 if(input.unitOut)return {takingPart:false,reason:'unit_out'};
 if(input.override)return {takingPart:input.override==='add',reason:input.override==='add'?'added':'removed'};
 if((input.yearsOfService??0)>1)return {takingPart:true,reason:'confirmed'};
 if(!input.confirmationDate)return {takingPart:false,reason:'not_confirmed'};
 if(openedOn&&input.confirmationDate.slice(0,10)>openedOn)return {takingPart:false,reason:'confirmed_after_open'};
 return {takingPart:true,reason:'confirmed'};
}
/** Native employment owns service dates. A one-year anniversary is not MORE than one year.
 * The source package has no employee export; imported historical service values cannot be inferred. */
export function serviceBeyondYear(hiredOn:string,asOf:string):boolean {
 const anniversary=`${Number(hiredOn.slice(0,4))+1}${hiredOn.slice(4)}`;
 return asOf>anniversary;
}
