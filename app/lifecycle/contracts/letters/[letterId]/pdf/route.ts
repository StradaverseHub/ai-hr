import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {readContractSharedLetter,renderContractSharedLetter} from '@/packs/contracts/service';
import {renderV9DocumentPdf} from '@/lib/lifecycle-v9-pdf';
export async function GET(_request:Request,{params}:{params:Promise<{letterId:string}>}){
 try{const session=await requireScopedLifecycleModule();if(!session)return new Response(null,{status:401});const letter=await readContractSharedLetter(session,(await params).letterId),document=renderContractSharedLetter(letter);if(!document)return new Response(null,{status:404});const file=await renderV9DocumentPdf(document,`Contract · ${letter.id} · ${letter.contentHash}`);return new Response(new Uint8Array(file.bytes),{headers:{'Content-Type':'application/pdf','Content-Disposition':'inline; filename="contract-letter.pdf"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});}
 catch{return new Response(null,{status:404,headers:{'Cache-Control':'private, no-store'}});}
}
