/** Run with the installed, locked Metro resolver on hosted verification/builders. No native UI or HR data. */
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {resolve}=require('metro-resolver');
const {getDefaultConfig}=require('expo/metro-config');
const root=path.resolve(__dirname,'..'),config=getDefaultConfig(root),pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const context={
 originModulePath:path.join(root,'lib/widget-launch.tsx'),sourceExts:config.resolver.sourceExts,
 assetExts:new Set(config.resolver.assetExts),preferNativePlatform:true,mainFields:config.resolver.resolverMainFields??['react-native','browser','main'],
 resolveRequest:null,nodeModulesPaths:[],unstable_enablePackageExports:true,unstable_conditionNames:[],unstable_conditionsByPlatform:{},unstable_logWarning:()=>{},
 getPackageForModule:p=>p.startsWith(root+path.sep)?{rootPath:root,packageJson:pkg,packageRelativePath:path.relative(root,p)}:null,
 getPackage:p=>fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):null,
 doesFileExist:p=>fs.existsSync(p)&&fs.statSync(p).isFile(),
 fileSystemLookup:p=>{try{const s=fs.statSync(p);return {exists:true,type:s.isDirectory()?'d':'f',realPath:fs.realpathSync(p)};}catch{return {exists:false};}},
 redirectModulePath:p=>p,resolveAsset:()=>null,resolveHasteModule:()=>null,resolveHastePackage:()=>null,
};
const expected={ios:path.join(root,'lib/attendance-widgets.ios.tsx'),android:path.join(root,'lib/attendance-widgets.tsx')};
for(const platform of ['ios','android']){
 const r=resolve(context,'./attendance-widgets',platform);assert.equal(r.type,'sourceFile');assert.equal(r.filePath,expected[platform],`Incorrect ${platform} widget entry: ${r.filePath}`);
 console.log(`[widget-entry] ${platform}: ${path.relative(root,r.filePath)}`);
}
if(process.argv.includes('--self-test')){
 // Reproduce the shipped failure without creating a file: Metro tries generic .ts before iOS .tsx.
 const oldStub=path.join(root,'lib/attendance-widgets.ts'),shadow={...context,fileSystemLookup:p=>p===oldStub?{exists:true,type:'f',realPath:p}:context.fileSystemLookup(p)};
 const old=resolve(shadow,'./attendance-widgets','ios');assert.equal(old.type,'sourceFile');assert.equal(old.filePath,oldStub);assert.notEqual(old.filePath,expected.ios);
 console.log('[widget-entry] regression reproduced: generic .ts would shadow the iOS renderer');
}

// The serialized widget is parsed again by JavaScriptCore in the native extension.
require('./verify-widget-layouts.cjs');
