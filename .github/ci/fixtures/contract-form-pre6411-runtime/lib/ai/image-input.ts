/** Ephemeral exact image input binding. Bytes never enter persistence or outward errors. */
import {createHash} from 'node:crypto';
import {AiImageReadError,validImageBytes} from './image-protocol';
import type {ImageReadArgs} from './types';
type ImageInput=Pick<ImageReadArgs,'data'|'mimeType'>&Partial<Pick<ImageReadArgs,'signal'|'timeoutMs'>>;
export function captureImageInput(input:ImageInput){
 const data=input.data,mimeType=input.mimeType,signal=input.signal,requestedTimeout=input.timeoutMs;
 if(!validImageBytes(data,mimeType))throw new AiImageReadError(false);
 const timeoutMs=Math.min(20000,Math.max(1,Number.isFinite(requestedTimeout)?requestedTimeout!:20000));
 return Object.freeze({data:new Uint8Array(data),mimeType,signal,timeoutMs});
}
export function imageInputDigest(input:Pick<ImageReadArgs,'data'|'mimeType'|'timeoutMs'>):string{
 return createHash('sha256').update(JSON.stringify([1,input.mimeType,input.timeoutMs,input.data.length])).update(input.data).digest('hex');
}
