/** Immutable upload receipts; bytes and their ownership remain with the native email asset store. */
import {z} from 'zod';
export const automationEmailAssetSchema=z.object({
 id:z.uuid(),kind:z.enum(['file','image']),name:z.string().min(1).max(180).regex(/^[^\u0000-\u001f\u007f/\\:]+$/u),
 mimeType:z.string().min(1).max(150),size:z.number().int().positive().max(10485760),contentHash:z.string().regex(/^[a-f0-9]{64}$/),
 at:z.iso.datetime(),by:z.string().min(1).max(500),alt:z.string().max(300).optional(),
}).strict();
export type AutomationEmailAsset=z.infer<typeof automationEmailAssetSchema>;
export const automationEmailSlotSchema=z.object({id:z.uuid(),label:z.string().trim().min(1).max(500),required:z.boolean()}).strict();
export type AutomationEmailSlot=z.infer<typeof automationEmailSlotSchema>;
export const automationEmailAttachmentSettingsSchema=z.object({
 assets:z.array(automationEmailAssetSchema).max(20),slots:z.array(automationEmailSlotSchema).max(50),documentIds:z.array(z.uuid()).max(20),
}).strict().superRefine((value,ctx)=>{
 if(new Set(value.assets.map(a=>a.id)).size!==value.assets.length||new Set(value.slots.map(a=>a.id)).size!==value.slots.length||new Set(value.documentIds).size!==value.documentIds.length)ctx.addIssue({code:'custom',message:'Choose each file, slot and document once.'});
 if(value.assets.filter(a=>a.kind==='image').length>3)ctx.addIssue({code:'custom',message:'Use at most three email images.'});
 if(value.assets.some(a=>a.kind==='image'&&(a.size>1048576||!a.mimeType.startsWith('image/'))))ctx.addIssue({code:'custom',message:'Use email images of at most 1 MB.'});
 if(value.assets.reduce((sum,a)=>sum+a.size,0)>20000000)ctx.addIssue({code:'custom',message:'Keep email attachments within 20 MB.'});
});
