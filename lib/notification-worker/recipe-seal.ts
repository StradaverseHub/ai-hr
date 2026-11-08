/** Pure closed recipe bytes only. Neither a digest nor this descriptor grants
 * installation/admission authority. Native sealing remains a separate owner. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
function closedRecord(value:unknown,required:readonly string[],optional:readonly string[]):value is Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
 const keys=Reflect.ownKeys(value);return required.every(key=>Object.hasOwn(value,key))&&keys.every(key=>typeof key==='string'&&[...required,...optional].includes(key)&&Object.getOwnPropertyDescriptor(value,key)?.enumerable===true&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)!,'value'));
}
const guardSchema=z.unknown().superRefine((value,context)=>{
 if(!closedRecord(value,['field','equals'],['not'])||(value&&typeof value==='object'&&Object.hasOwn(value,'not')&&Object.getOwnPropertyDescriptor(value,'not')?.value!==true))context.addIssue({code:'custom',message:'Exact guard keys and absent-or-true not required'});
}).pipe(z.object({field:z.enum(['overtime','supersededByAdminCancellation','notify']),equals:z.literal(true),not:z.literal(true).optional()}).strict());
const text=z.string().min(1).refine(value=>Buffer.byteLength(value)<=1024*1024&&!value.includes('\0')&&Buffer.from(value).toString('utf8')===value,'Native UTF8 text without NUL required');
const rowSchema=z.unknown().superRefine((value,context)=>{if(!closedRecord(value,['eventType','kind','category','recipientPort','implemented','audience','guard'],[]))context.addIssue({code:'custom',message:'Exact owned recipe keys required'});})
 .pipe(z.object({eventType:text,kind:text,category:text.nullable(),recipientPort:text.nullable(),implemented:z.boolean(),audience:z.enum(['subject','reader','none']),guard:guardSchema.nullable()}).strict())
 .superRefine((value,context)=>{if(value.audience==='reader'?value.recipientPort===null:value.recipientPort!==null)context.addIssue({code:'custom',message:'Explicit audience/port shape required'});});
export type NotificationRecipeSealRow=z.infer<typeof rowSchema>;
export const notificationRecipeSealFormat=Object.freeze({version:1,maximumBytes:1024*1024,maximumRows:10000,header:'AIHR_NOTIFICATION_RECIPE_SEAL\0'});
/** UTF8 byte order is the native COLLATE C order. No trimming, folding, JSON
 * whitespace removal, OID replacement or business implementation decision. */
export function notificationRecipeSealBytes(input:unknown,apiVersion:2|3){
 z.union([z.literal(2),z.literal(3)]).parse(apiVersion);
 // Bound plain source data BEFORE Zod walks/clones every row or UTF8 checks
 // allocate per-string buffers. Do not invoke array/row/guard accessors.
 if(!Array.isArray(input)||Object.getPrototypeOf(input)!==Array.prototype||input.length<1||input.length>notificationRecipeSealFormat.maximumRows)throw Error('Recipe seal row bound refused');
 const arrayKeys=Reflect.ownKeys(input);
 if(arrayKeys.length!==input.length+1||arrayKeys.some(key=>key!=='length'&&(typeof key!=='string'||!(/^(?:0|[1-9][0-9]*)$/).test(key)||Number(key)>=input.length)))throw Error('Exact source recipe array required');
 let sourceTextBytes=0;
 for(let index=0;index<input.length;index++){
  const descriptor=Object.getOwnPropertyDescriptor(input,String(index));
  if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw Error('Exact source recipe element required');
  const row:unknown=descriptor.value;if(!closedRecord(row,['eventType','kind','category','recipientPort','implemented','audience','guard'],[]))throw Error('Exact owned source recipe row required');
  const guard:unknown=Object.getOwnPropertyDescriptor(row,'guard')!.value;
  if(guard!==null&&!closedRecord(guard,['field','equals'],['not']))throw Error('Exact owned source guard required');
  for(const value of [...Object.values(Object.getOwnPropertyDescriptors(row)).map(field=>field.value),...(guard===null?[]:Object.values(Object.getOwnPropertyDescriptors(guard)).map(field=>field.value))]){
   if(typeof value==='string')sourceTextBytes+=Buffer.byteLength(value);
   if(sourceTextBytes>notificationRecipeSealFormat.maximumBytes)throw Error('Recipe seal byte bound refused');
  }
 }
 const rows=z.array(rowSchema).min(1).max(notificationRecipeSealFormat.maximumRows).parse(input);
 // Refuse total wire size before sorting can allocate repeated key buffers.
 const textSize=(value:string)=>5+Buffer.byteLength(value),nullableSize=(value:string|null)=>value===null?1:textSize(value);
 let expectedSize=Buffer.byteLength(notificationRecipeSealFormat.header)+12;
 for(const row of rows){expectedSize+=1+textSize(row.eventType)+textSize(row.kind)+nullableSize(row.category)+nullableSize(row.recipientPort)+1+textSize(row.audience)
  +(row.guard===null?1:1+textSize(row.guard.field)+1+(Object.hasOwn(row.guard,'not')?2:1));
  if(expectedSize>notificationRecipeSealFormat.maximumBytes)throw Error('Recipe seal byte bound refused');}
 rows.sort((a,b)=>Buffer.compare(Buffer.from(a.eventType),Buffer.from(b.eventType))||Buffer.compare(Buffer.from(a.kind),Buffer.from(b.kind)));
 const seen=new Map<string,Set<string>>();
 for(const row of rows){const kinds=seen.get(row.eventType)??new Set<string>();if(kinds.has(row.kind))throw Error('Duplicate canonical recipe identity');kinds.add(row.kind);seen.set(row.eventType,kinds);}
 const parts:Buffer[]=[];let size=0;
 const append=(bytes:Buffer)=>{if(bytes.length>notificationRecipeSealFormat.maximumBytes-size)throw Error('Recipe seal byte bound refused');size+=bytes.length;parts.push(bytes);};
 const unsigned=(value:number)=>{const bytes=Buffer.alloc(4);bytes.writeUInt32BE(value);append(bytes);};
 const string=(value:string)=>{const length=Buffer.byteLength(value);if(length>notificationRecipeSealFormat.maximumBytes)throw Error('Recipe seal text byte bound refused');append(Buffer.from('T'));unsigned(length);append(Buffer.from(value));};
 const nullable=(value:string|null)=>value===null?append(Buffer.from('N')):string(value);
 const boolean=(value:boolean)=>append(Buffer.from(value?'Y':'F'));
 append(Buffer.from(notificationRecipeSealFormat.header));unsigned(notificationRecipeSealFormat.version);unsigned(apiVersion);unsigned(rows.length);
 for(const row of rows){
  append(Buffer.from('R'));string(row.eventType);string(row.kind);nullable(row.category);nullable(row.recipientPort);boolean(row.implemented);string(row.audience);
  if(row.guard===null)append(Buffer.from('N'));
  else{append(Buffer.from('G'));string(row.guard.field);boolean(row.guard.equals);if(Object.hasOwn(row.guard,'not')){append(Buffer.from('P'));boolean(true);}else append(Buffer.from('A'));}
 }
 if(size!==expectedSize)throw Error('Recipe seal framing size differs');const bytes=Buffer.concat(parts,size);return{formatVersion:notificationRecipeSealFormat.version,apiVersion,recipeCount:rows.length,byteLength:size,sha256:createHash('sha256').update(bytes).digest('hex'),bytes};
}
