import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {Script} from 'node:vm';
import {describe,it,expect} from 'vitest';
const root=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');
type PhotoApi={CLOCK_PHOTO_MAX_BYTES:number;ClockPhotoError:new(...args:unknown[])=>Error;decodeClockPhoto:(bytes:Buffer,mime:string)=>Promise<unknown>};
describe('attendance photo dependency stays dormant in bundled read-only consumers',()=>{
 it('loads the actual esbuild CJS module and cheap refusals without initialising bundled Sharp',async()=>{
  const result=await build({absWorkingDir:root,entryPoints:['lib/attendance-photo.ts'],bundle:true,platform:'node',target:'node22',format:'cjs',write:false,logLevel:'silent',metafile:true});
  // Keep the genuine Sharp code in the compilation: no external package, native stub or loader mock.
  expect(Object.keys(result.metafile!.inputs).some(path=>/(?:^|\/)sharp\/dist\/sharp\.mjs$/.test(path))).toBe(true);
  const filename=fileURLToPath(new URL('../lib/attendance-photo.cjs',import.meta.url)),output={exports:{} as unknown};
  new Script(result.outputFiles![0].text,{filename}).runInNewContext({module:output,exports:output.exports,require:createRequire(import.meta.url),Buffer,process,console,__filename:filename,__dirname:dirname(filename)},{timeout:3000});
  const api=output.exports as PhotoApi;
  expect(api.CLOCK_PHOTO_MAX_BYTES).toBe(2*1024*1024);expect(typeof api.ClockPhotoError).toBe('function');expect(typeof api.decodeClockPhoto).toBe('function');
  for(const [bytes,mime] of [[Buffer.alloc(0),'image/jpeg'],[Buffer.alloc(api.CLOCK_PHOTO_MAX_BYTES+1),'image/png'],[Buffer.from('not a permitted type'),'image/gif']] as const){
   const attempt=api.decodeClockPhoto(bytes,mime);await expect(attempt).rejects.toBeInstanceOf(api.ClockPhotoError);await expect(attempt).rejects.toThrow('Use a JPEG or PNG photo no larger than 2 MB');
  }
  // Real JPEG/PNG processing, limits, digest and thumbnail remain exercised by r378-attendance-evidence.
 });
});
