'use server';
import {sql} from 'drizzle-orm';
import {withTenant} from '@/db/client';
import {EMAIL_ASSET_MAX_BYTES} from '@/lib/email-design/asset-limits';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {currentProviderSession} from '@/lib/identity/provider';
import {internalSelected} from '@/lib/internal-auth/config';
import {sendInternalMail} from '@/lib/internal-auth/mail';
import {listEmailDesigns,saveEmailDesign,emailDesignHistory,uploadEmailAsset} from '@/core/email-design/service';
import {emailKind,emailLocale,emailDocument,type EmailDocument} from '@/lib/email-design/model';
import {renderEmailDesign} from '@/lib/email-design/render';
import {sampleEmailSystem} from '@/lib/email-design/catalogue';
import {sampleEmailData} from '@/lib/email-design/sample-data';
import {internalConfig} from '@/lib/internal-auth/config';
export async function saveEmailDesignAction(kind:string,locale:string,document:unknown|null,revision:number){
 const ctx=await getSession();const next=await saveEmailDesign(ctx,emailKind.parse(kind),emailLocale.parse(locale),document,revision);
 revalidatePath('/admin/settings/email-templates');return next;
}
export async function loadEmailDesignHistoryAction(kind:string,locale:string){return emailDesignHistory(await getSession(),emailKind.parse(kind),emailLocale.parse(locale));}
export async function uploadEmailDesignAssetAction(form:FormData){
 const file=form.get('image');if(!(file instanceof File)||file.size>EMAIL_ASSET_MAX_BYTES)throw Error('Choose an image.');
 const token=await uploadEmailAsset(await getSession(),file.type,new Uint8Array(await file.arrayBuffer()));
 const origin=internalConfig().origin;return origin+'/email-assets/'+token;
}
export async function sendEmailDesignTestAction(kind:string,locale:string,raw:unknown){
 const ctx=await getSession();await listEmailDesigns(ctx); // Live group-admin database admission.
 const identity=await currentProviderSession();
 if(!internalSelected()||!identity?.emailVerified||!identity.email||!identity.issuer)throw Error('A verified email address and configured mail connection are required.');
 const [principal]=await withTenant(ctx,tx=>tx.execute<{app_user_id:string;tenant_id:string}>(sql`select app_user_id,tenant_id from app.principal_by_identity(${identity.issuer},${identity.subject})`));
 if(principal?.app_user_id!==ctx.userId||principal.tenant_id!==ctx.tenantId)throw Error('The signed-in identity changed.');
 const k=emailKind.parse(kind),l=emailLocale.parse(locale),document:EmailDocument=emailDocument.parse(raw);
 if(document.kind!==k)throw Error('Wrong email design kind.');
 const message=renderEmailDesign(document,k,l,sampleEmailSystem(k,l),sampleEmailData);
 await sendInternalMail({to:identity.email,...message});
 return {sent:true};
}
