import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {contractDocument} from '@/packs/contracts/service';
export async function GET(_request:Request,{params}:{params:Promise<{caseId:string;documentId:string}>}){
 const session=await requireScopedLifecycleModule();if(!session)return new Response(null,{status:401});
 try{const {caseId,documentId}=await params,document=await contractDocument(session,caseId,documentId);return new Response(new Uint8Array(document.bytes),{headers:{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="'+document.name.replace(/[^a-zA-Z0-9._-]/g,'_')+'"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});}catch{return new Response(null,{status:404});}
}
