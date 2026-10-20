import {requireAdmin} from '@/lib/authz';
import {SystemLabelImport} from './system-label-import';
export async function SystemLabelImportTools(){
 await requireAdmin();
 return <SystemLabelImport/>;
}
