/** Pure launch-shape classification, NOT runtime authority or a qualification setter. */
export const exactAsciiKernel=Object.freeze({bytes:124827920,sha256:'fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48',scalarSha256:'ff6936b6d5ff8edf886c317df3428816a2b70781dfb101498beda8dad1fa6acb',preloadBytes:862,preloadSha256:'a5012da3d2027007781baecda154d343d8c7ad2327b79bec65b1b60a41f42dd1',packageBytes:5918,packageSha256:'7514764431c71b6145ac008c36bdb8995d1998dfefe9f7bbbe3ca2da96716f3d',entryBytes:1918,entrySha256:'b4d080c701a3363b6f3386fe8e0da8796ecd64b90f8c39695379b68c3ccb6aa2'});
export const exactAsciiForbiddenEnvironment=Object.freeze(['NODE_ICU_DATA','ICU_DATA','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','LD_AUDIT','DYLD_INSERT_LIBRARIES','DYLD_LIBRARY_PATH','DYLD_FRAMEWORK_PATH']);
export function exactAsciiHeapOnly(value:string){return value===''||value==='--max-old-space-size=4096'||value==='--max-old-space-size=6144';}
/** A path is only a verification obligation here. The actual owner must resolve
 * and hash the exact locked Vitest preload; this parser cannot qualify it. */
export function exactAsciiLaunchShape(argv:readonly string[]):Readonly<{preload:string}>|null{
 let preload:string|undefined,meta=false;
 for(let index=0;index<argv.length;index++){
  const flag=argv[index];
  if(flag==='--experimental-import-meta-resolve'&&!meta){meta=true;continue;}
  if((flag==='--require'||flag==='-r')&&preload===undefined){const path=argv[++index];if(!path||!path.startsWith('/')||path.includes('\0'))return null;preload=path;continue;}
  if(flag==='--conditions=node'||flag==='--conditions=development'||flag==='--max-old-space-size=4096'||flag==='--max-old-space-size=6144')continue;
  return null;
 }
 return meta&&preload?Object.freeze({preload}):null;
}
export type ExactAsciiFileIdentity=Readonly<{device:bigint;inode:bigint;bytes:bigint;mtime:bigint;ctime:bigint}>;
export function exactAsciiFileIdentityEqual(a:ExactAsciiFileIdentity,b:ExactAsciiFileIdentity){return a.device===b.device&&a.inode===b.inode&&a.bytes===b.bytes&&a.mtime===b.mtime&&a.ctime===b.ctime;}
export function exactAsciiBinaryMatch(bytes:number,sha256:string){return bytes===exactAsciiKernel.bytes&&sha256===exactAsciiKernel.sha256;}
type Intrinsics=Readonly<{lower:unknown;trim:unknown;includes:unknown;fromCodePoint:unknown}>;
export function exactAsciiIntrinsicIdentity(a:Intrinsics,b:Intrinsics){return a.lower===b.lower&&a.trim===b.trim&&a.includes===b.includes&&a.fromCodePoint===b.fromCodePoint;}
