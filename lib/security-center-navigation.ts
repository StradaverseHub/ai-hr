/** Destinations are closed constants; no account command accepts a caller-supplied return URL. */
export const SECURITY_CENTER = '/admin/security-center';
export const SECURITY_PAGES = [
 {href:'/admin/users/access',key:'permissions',navKey:'securityPermissions'},
 {href:'/admin/users/function-access',key:'functions',navKey:'functionAccess'},
 {href:'/admin/users/create',key:'create',navKey:'createLogin'},
 {href:'/admin/users/invite',key:'invite',navKey:'inviteUser'},
 {href:'/admin/users',key:'users',navKey:'users'},
 {href:'/admin/security-center/password-policy',key:'passwordPolicy',navKey:'passwordPolicy'},
] as const;
/**
 * Board 8fa0a31d — the main menu's Security Center section lists the pages in the reporter's order. The overview
 * (SECURITY_CENTER) is not a menu row: it is the section's breadcrumb landing and keeps its route and Back links.
 * The overview's own cards keep SECURITY_PAGES order. Every page appears here exactly once
 * (test/security-center-navigation.test.ts), so a new page must be placed deliberately.
 */
export const SECURITY_MENU_ORDER = ['permissions','passwordPolicy','functions','users','create','invite'] as const satisfies readonly (typeof SECURITY_PAGES)[number]['key'][];
export const SECURITY_MENU_PAGES = SECURITY_MENU_ORDER.map(key=>SECURITY_PAGES.find(page=>page.key===key)!);
export type SecurityAvailability = {admin:boolean;configure:boolean;provision:boolean;passwordPolicy?:boolean};
export function securityDestinationAllowed(href:string, access:SecurityAvailability):boolean {
 if(href==='/admin/security-center/password-policy')return access.passwordPolicy===true;
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
