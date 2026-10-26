import {readFileSync} from 'node:fs';
import {LocationCaptureError} from '../mobile/lib/errors';
import {runInNewContext} from 'node:vm';
import {ModuleKind,transpileModule} from 'typescript';
import {expect,it} from 'vitest';
function load(path:string,ports:Record<string,unknown>,globals:Record<string,unknown>={}){
 const module={exports:{} as any};
 runInNewContext(transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ModuleKind.CommonJS,target:99}}).outputText,
  {module,exports:module.exports,Blob,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,require:(id:string)=>{if(id in ports)return ports[id];throw new Error(id);},...globals});
 return module.exports;
}
it('the installed Expo multipart encoder consumes actual file bytes and preserves extensionless document MIME/name',async()=>{
 const bytes=new Uint8Array([37,80,68,70,45,49,46,55]);
 class NativeFormData{_parts:unknown[]=[];}
 const {installFormDataPatch}=load('mobile/node_modules/expo/src/winter/FormData.ts',{});
 installFormDataPatch(NativeFormData);
 const {appendAttachment}=load('mobile/lib/capture.ts',{'expo-location':{},'expo-image-picker':{},'expo-image-manipulator':{},'expo-file-system':{File:class{async bytes(){return bytes;}}},'expo-crypto':{},'react-native':{},'./i18n':{t:()=>''},'./errors':{LocationCaptureError}});
 const {convertFormDataAsync}=load('mobile/node_modules/expo/src/winter/fetch/convertFormData.ts',{'../../utils/blobUtils':{blobToArrayBufferAsync:(blob:Blob)=>blob.arrayBuffer()}});
 const form=new NativeFormData() as unknown as FormData;
 form.append('command','{"requestId":"immutable"}');
 appendAttachment(form,'document',{uri:'file:///private/cache/extensionless-uuid',name:'medical.pdf',mimeType:'application/pdf',size:bytes.length});
 const encoded=await convertFormDataAsync(form,'test-boundary'),text=new TextDecoder().decode(encoded.body);
 expect(text).toContain('name="command"');expect(text).toContain('{"requestId":"immutable"}');
 expect(text).toContain('filename="medical.pdf"');expect(text).toContain('application/pdf');expect(text).toContain('%PDF-1.7');
 expect(text).not.toContain('file:///private/cache');
});
