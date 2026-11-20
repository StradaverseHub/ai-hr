import {requireAdmin} from '@/lib/authz';
import {SystemLabelImport} from './system-label-import';
export async function SystemLabelImportTools({criteriaHelp}:{criteriaHelp?:string}={}){
 await requireAdmin();
 return <SystemLabelImport criteriaHelp={criteriaHelp}/>;
}
