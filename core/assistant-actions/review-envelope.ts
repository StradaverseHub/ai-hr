/** One envelope owner for installed review protocols. Call only after source/custody authority.
 * Adapters retain exact metadata AAD, wire schemas and commitments; this code grants no permission. */
import type {z} from 'zod';
import {masterKeyAvailable,newDek,newKid,sealUnderDek,unsealUnderDek,unwrapDek,wrapDek} from '../../lib/pii/vault';
export type ReviewEnvelope={formatVersion:1;kid:string;wrappedDek:string;ciphertext:string};
export function createReviewEnvelope<M,B,E extends ReviewEnvelope>(spec:{
 sealed:z.ZodType<E>;maxBytes:number;identity(metadata:M):{wrapAad:string;bodyAad:string};
 checked(metadata:M,value:unknown):B;wire(body:B):unknown;unavailable():never;
}){
 return Object.freeze({
  seal(metadata:M,value:unknown):E{let dek:Buffer|undefined;try{
   if(!masterKeyAvailable())return spec.unavailable();const identity=spec.identity(metadata),body=spec.checked(metadata,value),text=JSON.stringify(spec.wire(body));
   if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>spec.maxBytes)return spec.unavailable();dek=newDek();const kid=newKid();
   return spec.sealed.parse({formatVersion:1,kid,wrappedDek:wrapDek(dek,identity.wrapAad),ciphertext:sealUnderDek(dek,kid,text,identity.bodyAad)});
  }catch{return spec.unavailable();}finally{dek?.fill(0);}},
  unseal(metadata:M,value:unknown):B{let dek:Buffer|undefined;try{
   if(!masterKeyAvailable())return spec.unavailable();const identity=spec.identity(metadata),sealed=spec.sealed.parse(value);dek=unwrapDek(sealed.wrappedDek,identity.wrapAad);
   if(dek.length!==32)return spec.unavailable();const text=unsealUnderDek(dek,sealed.ciphertext,identity.bodyAad);if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>spec.maxBytes)return spec.unavailable();return spec.checked(metadata,JSON.parse(text));
  }catch{return spec.unavailable();}finally{dek?.fill(0);}},
 });
}
