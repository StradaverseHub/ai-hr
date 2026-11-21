import {expect} from 'vitest';

type OpeningIdentity={year:number;companyId:string;employmentId:string};
export type OpeningPrefix=readonly {payslipId:string;sourceHash:string}[];
type Statutory=Record<string,unknown>;

/** Expected identity and source bytes come from the fixture's independently selected owners,
 * never from the saved stamp. No arbitrary UUID, key, version, prefix or monetary value is ignored. */
export function verifyTaxOpeningProvenance(statutory:Statutory,identity:OpeningIdentity,prefix:OpeningPrefix=[]):void {
 expect(statutory.taxBasisImportedSources,'these fixtures contain no imported payroll').toEqual([]);
 expect(statutory.taxBasisOpeningSource,'exact opening authority and prior native source hashes').toEqual({
  version:1,...identity,prefix,
 });
}

/** For two independently seeded employees, retain the complete stamp except its proven owner UUIDs. */
export function normalizeEmptyTaxOpeningProvenance(statutory:Statutory,identity:OpeningIdentity):Statutory {
 verifyTaxOpeningProvenance(statutory,identity);
 return {...statutory,taxBasisOpeningSource:{version:1,year:identity.year,
  companyId:'validated-opening-company',employmentId:'validated-opening-employment',prefix:[]}};
}

/** The legacy goldens predate only these two additive fields. Verification precedes their removal. */
export function withoutVerifiedTaxOpeningProvenance(statutory:Statutory,identity:OpeningIdentity,prefix:OpeningPrefix=[]):Statutory {
 verifyTaxOpeningProvenance(statutory,identity,prefix);
 const {taxBasisImportedSources,taxBasisOpeningSource,...original}=statutory;
 return original;
}

/** Raw rows must already have passed verifyTaxOpeningProvenance before canonicalization drops IDs/version.
 * Only the historical digest projection uses this function; full reset/sync/job equality keeps both fields. */
export function legacyOpeningDocument<D>(document:D):D {
 const value=document as {payslips:{statutory:Statutory}[]} & Record<string,unknown>;
 return {...value,payslips:value.payslips.map(row=>{
  const {taxBasisImportedSources,taxBasisOpeningSource,...statutory}=row.statutory;
  return {...row,statutory};
 })} as D;
}
