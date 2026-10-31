import {NextRequest,NextResponse} from 'next/server';
import {verifyPublicLetter} from '@/core/letter-verification';
import {letterVerificationWords} from '@/lib/letter-verification';
export const runtime='nodejs';
export async function GET(request:NextRequest,context:{params:Promise<{token:string}>}){
 const {token}=await context.params,lang=request.nextUrl.searchParams.get('lang')??'en',language=Object.hasOwn(letterVerificationWords,lang)?lang as keyof typeof letterVerificationWords:'en',words=letterVerificationWords[language];
 let text:string=words.unavailable,status=503;
 try{const result=await verifyPublicLetter(token);text=result==='limited'?words.limited:words[result];status=result==='limited'?429:200;}catch{/* The public response never includes database diagnostics. */}
 return new NextResponse(`<!doctype html><html lang="${language}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${words.title}</title><body><main><h1>${words.title}</h1><p role="status">${text}</p></main></body></html>`,{status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-robots-tag':'noindex, nofollow','content-security-policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",...(status===429?{'retry-after':'60'}:{})}});
}
