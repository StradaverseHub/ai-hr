'use client';
import {CheckCircle2} from 'lucide-react';
import type {ContractSharedLetter} from '@/packs/contracts/service';
import {contractPdfSignatures} from '@/lib/contract-pdf-signatures';
import {validV9SignatureValue} from '@/lib/lifecycle-v9-signature';
import {useContractSharedCopy} from '@/lib/contract-shared-copy';
import {ContractPanel} from './shared-case-ui';
import {contractTimestamp} from './shared';
/** Every mark is the existing canonical contribution, never a newly chosen or recreated signature. */
export function ContractRecordedSignatures({letter}:{letter:ContractSharedLetter}){
 const copy=useContractSharedCopy();let receipts:ReturnType<typeof contractPdfSignatures>;
 try{receipts=contractPdfSignatures(letter);if(receipts.some(receipt=>!validV9SignatureValue(receipt.signature.method,receipt.signature.value)))throw new Error('Unverified signature');}catch{return <p className="v9-notice v9-error">{copy('The recorded signature proof needs review. Refresh this letter before exporting it.')}</p>;}
 if(!receipts.length)return null;
 return <ContractPanel title={copy('Recorded signatures')}><ol className="contract-rail">{receipts.map((receipt,index)=><li key={index}><CheckCircle2 aria-hidden/><div className="contract-recorded-signature"><strong>{receipt.signature.by.name} · {receipt.role}</strong>{receipt.signature.method==='drawn'?<img src={receipt.signature.value} width={300} height={100} alt={copy('Signature of')+' '+receipt.signature.by.name}/>:<div className="v9-signature-mark">{receipt.signature.value}</div>}<p>{copy('Verified AIHR login')} · {contractTimestamp(receipt.signature.at)}</p><small>{copy('Content revision')} {receipt.contentRevision} · {copy('Content fingerprint')} {receipt.contentHash.slice(0,12)}…</small></div></li>)}</ol></ContractPanel>;
}
