import {requireGroupAdministration} from '@/lib/security-center-authz';
import {DuplicatesView,type DuplicatesSearch} from '../duplicates-view';
/** Board 0735d1b7 — Security Center > Users > Duplicate IC / Passport (group administrators only). */
export default async function DuplicateIdentityPage({searchParams}:{searchParams:Promise<DuplicatesSearch>}){
 const session=await requireGroupAdministration();
 return <DuplicatesView session={session} tab="identity" searchParams={await searchParams}/>;
}
