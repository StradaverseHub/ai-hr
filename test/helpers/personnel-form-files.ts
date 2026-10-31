import ts from 'typescript';
import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
/** Generic primitives do not declare Personnel facts. Their callers must supply the binding. */
const GENERIC_BOUNDARIES:Record<string,string>={
  'components/ui.tsx':'Generic layout and control styles; Personnel bindings are checked at each caller.',
  'components/profile-option-select.tsx':'Generic catalog/legacy-value renderer; the owning Personnel widget supplies its descriptor.',
  'components/personnel-field.tsx':'Shared descriptor caption renderer; the owning form supplies the stable field ID.',
  'components/ic-dob-autofill.tsx':'Generic input/autofill primitive; IdentityNumberField supplies the canonical binding.',
  'components/currency-select.tsx':'Generic currency catalog primitive; its Personnel caller supplies the owner binding.',
};
export const PERSONNEL_FORM_ROOTS=['app/(app)/admin/personnel/[employmentId]/page.tsx','app/(app)/admin/personnel/new/wizard.tsx','app/(app)/admin/personnel/new/create-form.tsx'] as const;
/** Discover mounted local JSX modules from the real roots; a newly extracted form cannot disappear. */
export function personnelFormSources(root:string,roots:readonly string[]=PERSONNEL_FORM_ROOTS) {
  const seen=new Set<string>();const files=new Map<string,string>();const boundaries=new Map<string,string>();
  const visit=(file:string)=>{
    if(seen.has(file))return;seen.add(file);
    if(file.startsWith('components/ui/')){boundaries.set(file,'Generic UI primitive; Personnel metadata must be supplied at its caller.');return;}
    if(GENERIC_BOUNDARIES[file]){boundaries.set(file,GENERIC_BOUNDARIES[file]);return;}
    const absolute=path.join(root,file);if(!existsSync(absolute))throw new Error('Personnel source root/import is missing: '+file);
    const text=readFileSync(absolute,'utf8');files.set(file,text);
    const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    for(const node of source.statements)if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
      const spec=node.moduleSpecifier.text;
      if(!spec.startsWith('@/components/')&&!spec.startsWith('./')&&!spec.startsWith('../'))continue;
      const base=spec.startsWith('@/')?spec.slice(2):path.normalize(path.join(path.dirname(file),spec));
      const dependency=[base+'.tsx',base+'/index.tsx'].find(candidate=>existsSync(path.join(root,candidate)));
      if(dependency)visit(dependency);
    }
  };
  for(const file of roots)visit(file);
  return {files,boundaries};
}

/** Source text only: imported descriptor maps are audited without evaluating application modules. */
export function personnelImportSourceReader(root:string){
  const baseRoot=path.resolve(root);
  return (from:string,specifier:string):string|undefined=>{
    if(!specifier.startsWith('@/')&&!specifier.startsWith('./')&&!specifier.startsWith('../'))return undefined;
    const base=specifier.startsWith('@/')?path.resolve(baseRoot,specifier.slice(2)):path.resolve(baseRoot,path.dirname(from),specifier);
    if(!base.startsWith(baseRoot+path.sep))return undefined;
    const file=[base+'.ts',base+'.tsx',path.join(base,'index.ts')].find(candidate=>existsSync(candidate));
    return file?readFileSync(file,'utf8'):undefined;
  };
}
