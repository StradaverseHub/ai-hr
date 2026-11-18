/** Validate raster signatures and dimensions without interpreting uploaded markup or following URLs. */
import sharp from 'sharp';
import {EMAIL_ASSET_MAX_BYTES,EMAIL_ASSET_MIMES} from './asset-limits';
export {EMAIL_ASSET_MAX_BYTES,EMAIL_ASSET_MIMES} from './asset-limits';
/** Shared raster signature/dimension owner; callers enforce their own purpose-specific byte cap. */
export async function validateEmailRaster(bytes:Uint8Array,mime:string){
 if(!EMAIL_ASSET_MIMES.includes(mime as typeof EMAIL_ASSET_MIMES[number])||!bytes.length)throw Error('Invalid email image.');
 const metadata=await sharp(bytes,{limitInputPixels:16_000_000,animated:false}).metadata();
 const format={png:'image/png',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp'}[metadata.format as 'png'|'jpeg'|'gif'|'webp'];
 if(format!==mime||!metadata.width||!metadata.height||metadata.width>8000||metadata.height>8000)throw Error('Invalid email image.');
 return {width:metadata.width,height:metadata.height};
}

/** Public branding assets retain their existing 2 MB policy. */
export async function validateEmailAsset(bytes:Uint8Array,mime:string){
 if(bytes.length>EMAIL_ASSET_MAX_BYTES)throw Error('Invalid email image.');
 return validateEmailRaster(bytes,mime);
}
