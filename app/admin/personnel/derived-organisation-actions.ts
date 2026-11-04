'use server';
import {requireAdmin} from '@/lib/authz';
import {derivedOrganisationForForm} from '@/core/derived-organisation-display';
export async function derivedOrganisationAction(input:{companyId?:string;employmentId?:string;asOf?:string}){
 return derivedOrganisationForForm(await requireAdmin(),{companyId:input.companyId,employmentId:input.employmentId,asOf:input.asOf});
}
