import {afterAll,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import sharp from 'sharp';
import {withTenant,type SessionContext} from '../db/client';
import {v9Setup,v9Workspace,v9UploadEmailAsset,v9DownloadEmailAsset,v9SaveConfig} from '../packs/lifecycle/service';
import {closeAll,resetDb,seedBase,setModule,entitledCtx,owner} from './harness';
import type {Config,EmailAsset} from '../lib/lifecycle-v9-model';
let admin:SessionContext;
beforeEach(async()=>{await resetDb();const base=await seedBase();await setModule(base.tenantId,'lifecycle','active');admin=await entitledCtx(base);await v9Setup(admin);});
afterAll(closeAll);
const png=()=>sharp({create:{width:2,height:2,channels:4,background:{r:186,g:75,b:15,alpha:1}}}).png().toBuffer();
const body=(image:EmailAsset)=>({type:'doc' as const,content:[{type:'paragraph' as const,content:[{type:'text' as const,text:'Before image'},{type:'image' as const,attrs:{assetId:image.id,alt:image.alt??image.name}},{type:'text' as const,text:'After image'}]}]});
it('acknowledges PNG/JPG/GIF/WebP registry, description and exact body position together and retains prior revisions',async()=>{
 let config=(await v9Workspace(admin)).config!,prior:Config|undefined;
 const image=await png();
 const formats=[{ext:'png',mime:'image/png',bytes:image},{ext:'jpg',mime:'image/jpeg',bytes:await sharp(image).jpeg().toBuffer()},{ext:'gif',mime:'image/gif',bytes:await sharp(image).gif().toBuffer()},{ext:'webp',mime:'image/webp',bytes:await sharp(image).webp().toBuffer()}];
 for(const format of formats){
  const uploaded=await v9UploadEmailAsset(admin,{revision:config.revision,emailId:'e1',kind:'image',name:'Fictional welcome.'+format.ext,content:format.bytes});
  expect(uploaded.mimeType).toBe(format.mime);expect((await v9DownloadEmailAsset(admin,uploaded.id)).content).toEqual(format.bytes);
  const asset={...uploaded,alt:'Connect "safely" & grow <together>'};const next=structuredClone(config),email=next.emails.find(row=>row.id==='e1')!;email.images=[asset];email.bodyDoc=body(asset);
  const receipt=await v9SaveConfig(admin,config.revision,next);expect(receipt.revision).toBe(config.revision+1);
  if(prior){const [retained]=await withTenant(admin,tx=>tx.execute<{data:Config}>(sql`select data from lc_v9_config_revision where tenant_id=${admin.tenantId}::uuid and revision=${prior!.revision}`));expect(retained.data.emails.find(row=>row.id==='e1')).toEqual(prior.emails.find(row=>row.id==='e1'));}
  config=(await v9Workspace(admin)).config!;expect(config.revision).toBe(receipt.revision);expect(config.emails.find(row=>row.id==='e1')).toMatchObject({images:[asset],bodyDoc:body(asset)});prior=structuredClone(config);
 }
});
it('refuses stale revision, altered/missing receipt, wrong template and unknown body nodes without changing saved content/history',async()=>{
 let config=(await v9Workspace(admin)).config!;const asset={...await v9UploadEmailAsset(admin,{revision:config.revision,emailId:'e1',kind:'image',name:'Fictional welcome.png',content:await png()}),alt:'A fictional welcome'};
 config.emails.find(row=>row.id==='e1')!.images=[asset];config.emails.find(row=>row.id==='e1')!.bodyDoc=body(asset);await v9SaveConfig(admin,config.revision,config);config=(await v9Workspace(admin)).config!;
 const history=()=>owner.client`select revision,data from lc_v9_config_revision where tenant_id=${admin.tenantId}::uuid order by revision`;
 const before=await history();
 await expect(v9SaveConfig(admin,config.revision-1,config)).rejects.toThrow('Settings changed');
 for(const replacement of [{...asset,contentHash:'0'.repeat(64)},{...asset,id:randomUUID()}]){const next=structuredClone(config),email=next.emails.find(row=>row.id==='e1')!;email.images=[replacement];email.bodyDoc=body(replacement);await expect(v9SaveConfig(admin,config.revision,next)).rejects.toThrow(asset.name);}
 const wrong=structuredClone(config);wrong.emails.find(row=>row.id==='e2')!.images=[asset];await expect(v9SaveConfig(admin,config.revision,wrong)).rejects.toThrow(asset.name);
 const unknown=structuredClone(config);unknown.emails.find(row=>row.id==='e1')!.bodyDoc=body({...asset,id:randomUUID()});await expect(v9SaveConfig(admin,config.revision,unknown)).rejects.toThrow();
 const fourth=structuredClone(config);fourth.emails.find(row=>row.id==='e1')!.images=Array.from({length:4},()=>({...asset,id:randomUUID()}));await expect(v9SaveConfig(admin,config.revision,fourth)).rejects.toThrow();
 expect((await v9Workspace(admin)).config).toEqual(config);expect(await history()).toEqual(before);
});
