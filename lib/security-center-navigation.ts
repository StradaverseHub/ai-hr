/** Destinations are closed constants; no account command accepts a caller-supplied return URL. */
export const SECURITY_CENTER = '/admin/security-center';
export const SECURITY_PAGES = [
 {href:'/admin/users/access',key:'permissions',navKey:'securityPermissions'},
 {href:'/admin/users/function-access',key:'functions',navKey:'functionAccess'},
 {href:'/admin/users/create',key:'create',navKey:'createLogin'},
 {href:'/admin/users/invite',key:'invite',navKey:'inviteUser'},
 {href:'/admin/users',key:'users',navKey:'users'},
] as const;
export type SecurityAvailability = {admin:boolean;configure:boolean;provision:boolean};
export function securityDestinationAllowed(href:string, access:SecurityAvailability):boolean {
 if(href===SECURITY_CENTER)return access.admin||access.configure;
 if(href==='/admin/users/access')return access.configure;
 if(href==='/admin/users/create'||href==='/admin/users/invite')return access.provision;
 return (href==='/admin/users'||href==='/admin/users/function-access')&&access.admin;
}
export function isSecurityDestination(href:string):boolean {
 return href===SECURITY_CENTER||SECURITY_PAGES.some(page=>page.href===href);
}
/** Fragments never reach a server page. Only these two historical targets can hand off. */
export function legacySecurityDestination(hash:string, query:URLSearchParams):string|null {
 const path=hash==='#manual-account-setup'?'/admin/users/create':hash==='#invite-user'?'/admin/users/invite':null;
 if(!path)return null;
 const person=query.get('activate');
 return path+(person&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(person)?`?activate=${encodeURIComponent(person)}`:'');
}
