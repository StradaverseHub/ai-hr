/** Filing-readiness fields already used by the Malaysian company Statutory tab. Optional TIN/SSM are not invented requirements. */
export const MY_COMPANY_REGISTRATION_FIELDS=['epfEmployerNo','socsoEmployerCode','lhdnEmployerNo'] as const;
export function companyRegistrationReadinessMY(row: {epfEmployerNo?:string|null;socsoEmployerCode?:string|null;lhdnEmployerNo?:string|null;hrdfStatus?:string|null}|null|undefined){
 return {missing:MY_COMPANY_REGISTRATION_FIELDS.filter(key=>!row?.[key]?.trim()),levyUnavailable:!row||!row.hrdfStatus||row.hrdfStatus==='not_registered'};
}
