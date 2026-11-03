/** AI v2 Phase 2 hardening (4 November 2026) — which pending profile updates payroll has to wait for. PURE.
 *
 * An employee's profile change request (profile_change_request.proposed) names the fields it would change: the legacy
 * shape is a patch keyed by field (lib/profile-requestable-fields.ts keys), the current shape (`v: 2`) lists each field by
 * its Personnel registry id (lib/personnel-field-registry.ts). A request is PAY-RELEVANT when it would change something a
 * payroll run reads: the bank details, the statutory and tax details (EPF, SOCSO and EIS, income tax, tax category,
 * children for relief), the identity numbers statutory files are keyed on, or the marital status the tax category depends
 * on. A photo, a contact detail, a preferred name or an address is not, and does not hold the Pre-salary loop. */

/** The legacy proposal keys that feed pay or a statutory file. */
export const PAY_RELEVANT_PROFILE_KEYS:ReadonlySet<string>=new Set(['bankName','bankAccountNo','taxCategory','numChildren','epfNumber','socsoNumber',
 'taxNumber','icNumber','oldIcNumber','passportNumber','maritalStatus']);
/** Registry ids: every Bank & Statutory field, and the identity and marital fields on the Profile tab. */
const PAY_RELEVANT_FIELD_IDS:ReadonlySet<string>=new Set(['profile.personal_details.maritalstatus']);
const PAY_RELEVANT_FIELD_PREFIXES=Object.freeze(['bank_statutory.']);
const IDENTITY_FIELD=/^profile\.[a-z_]+\.(icnumber|oldicnumber|passportnumber)$/;

const payRelevantFieldId=(id:unknown)=>typeof id==='string'&&(PAY_RELEVANT_FIELD_IDS.has(id)||IDENTITY_FIELD.test(id)
 ||PAY_RELEVANT_FIELD_PREFIXES.some(prefix=>id.startsWith(prefix)));

export function isPayRelevantProfileChange(proposed:unknown):boolean{
 if(!proposed||typeof proposed!=='object'||Array.isArray(proposed))return false;
 const p=proposed as Record<string,unknown>;
 if(p.kind==='photo')return false;
 if(p.v===2){
  const fields=Array.isArray(p.fields)?p.fields:[];
  const registers=Array.isArray(p.registers)?p.registers:[];
  const ids=[...fields,...registers.flatMap(row=>row&&typeof row==='object'&&Array.isArray((row as {fields?:unknown}).fields)?(row as {fields:unknown[]}).fields:[])]
   .map(field=>field&&typeof field==='object'?(field as {fieldId?:unknown}).fieldId:null);
  return ids.some(payRelevantFieldId);
 }
 return Object.keys(p).some(key=>PAY_RELEVANT_PROFILE_KEYS.has(key));
}
