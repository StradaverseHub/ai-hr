import {canConfigureAccess,readAccessConfigurationEditor} from '@/core/access-configuration-editor';
import {readDataPermissions} from '@/core/data-permissions';
import type {SessionContext} from '@/db/client';
import {DataPermissionEditor} from '@/app/admin/security-center/data-permissions/editor';
/** Separate from account provisioning: the current configure owner reauthorizes each assignment. */
export async function DataPermissionAssignments({session}:{session:SessionContext}){
 if(!await canConfigureAccess(session))return null;
 const data=await readAccessConfigurationEditor(session),state=await readDataPermissions(session);
 return <DataPermissionEditor key={state.revision} state={state} users={data.users} assignmentsOnly/>;
}
