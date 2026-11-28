import {requireGroupAdministration} from '@/lib/security-center-authz';
import {DuplicatesView,type DuplicatesSearch} from '../duplicates-view';
/** Board 0735d1b7 — Security Center > Users > Duplicate Work Email Address (group administrators only). */
export default async function DuplicateEmailPage({searchParams}:{searchParams:Promise<DuplicatesSearch>}){
 const session=await requireGroupAdministration();
 return <DuplicatesView session={session} tab="email" searchParams={await searchParams}/>;
}
