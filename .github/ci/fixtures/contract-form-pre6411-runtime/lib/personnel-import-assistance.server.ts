/** Server-only digest owner. Client computes the same digest from the exported canonical text. */
import {createHash} from 'node:crypto';
import {personnelImportRegistryRevisionText,personnelImportHeadersRevisionText,personnelImportSourceRevisionText,type PersonnelImportHeader} from './personnel-import-assistance';
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
export const PERSONNEL_IMPORT_ASSISTANCE_REGISTRY_DIGEST=hash(personnelImportRegistryRevisionText());
export function personnelImportHeaderDigests(headers:readonly PersonnelImportHeader[]){
 const headersDigest=hash(personnelImportHeadersRevisionText(headers));
 return Object.freeze({headersDigest,registryDigest:PERSONNEL_IMPORT_ASSISTANCE_REGISTRY_DIGEST,sourceRevision:hash(personnelImportSourceRevisionText(headersDigest,PERSONNEL_IMPORT_ASSISTANCE_REGISTRY_DIGEST))});
}
