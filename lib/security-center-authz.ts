import {redirect} from 'next/navigation';
import {getSession} from '@/lib/session';
import {isAdmin,isGroupAdmin,requireAdmin} from '@/lib/authz';
import {canConfigureAccess} from '@/core/access-configuration-editor';
export async function requireSecurityCenter(){
 const session=await getSession();
 const access={admin:isAdmin(session),configure:await canConfigureAccess(session),provision:isGroupAdmin(session)};
 if(!access.admin&&!access.configure)redirect('/');
 return {session,access};
}
export async function requireGroupAdministration(){
 const session=await requireAdmin();
 if(!isGroupAdmin(session))redirect('/admin/security-center');
 return session;
}
