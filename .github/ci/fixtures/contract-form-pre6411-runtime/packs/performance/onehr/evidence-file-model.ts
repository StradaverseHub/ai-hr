export const evidenceFileExtensions=['pdf','png','jpg','jpeg','gif','webp','doc','docx','xls','xlsx','csv','txt'] as const;
export const evidenceFileLimit=4;
export const evidenceFileMaxBytes=2*1024*1024;
export function validateEvidenceFile(fileName:string,sizeBytes:number) {
 if(!fileName.trim()||fileName.length>200)throw Error('Choose a file with a name of at most 200 characters.');
 const extension=fileName.includes('.')?fileName.split('.').pop()!.toLowerCase():'';
 if(!evidenceFileExtensions.some(ext=>ext===extension))throw Error('Choose a PDF, image, Word, Excel, CSV or text file.');
 if(!Number.isInteger(sizeBytes)||sizeBytes<=0||sizeBytes>evidenceFileMaxBytes)throw Error('Choose a non-empty file no larger than 2 MB.');
}
