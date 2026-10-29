/** Opaque raster assets may be read by mail clients without an HR session. No prefix-wide bypass. */
export const isEmailAssetToken=(token:string)=>/^[a-f0-9]{64}$/.test(token);
export const isPublicEmailAssetRead=(path:string,method:string)=>
 (method==='GET'||method==='HEAD')&&/^\/email-assets\/[a-f0-9]{64}$/.test(path);
