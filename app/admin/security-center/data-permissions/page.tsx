import {getTranslations} from 'next-intl/server';
import {requireAccessConfiguration} from '@/lib/access-configuration-authz';
import {readDataPermissions} from '@/core/data-permissions';
import {pageWideCls} from '@/components/ui';
import {SecurityPageHeader} from '@/app/admin/users/security-page';
import {DataPermissionEditor} from './editor';
export default async function DataPermissionsPage(){
 const {session,data}=await requireAccessConfiguration(),state=await readDataPermissions(session),t=await getTranslations('dataPermissions');
 return <div className={pageWideCls}><SecurityPageHeader title={t('title')}/><DataPermissionEditor key={state.revision} state={state} users={data.users}/></div>;
}
