/** The sole closed five-selector registry. These descriptors grant no native capability. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {COMPILER_NATIVE_NODB_PROFILES} from './diagnostics/compiler-normal-profile.mjs';
import {CLASSIFIER_WITNESS_PROFILES} from './diagnostics/classifier-witness-profile.mjs';
export const NATIVE_NODB_PROFILES=Object.freeze([...COMPILER_NATIVE_NODB_PROFILES,...CLASSIFIER_WITNESS_PROFILES]);
export const NATIVE_NODB_FILES=Object.freeze(NATIVE_NODB_PROFILES.map(row=>row.file));
assert.equal(NATIVE_NODB_PROFILES.length,5);assert.equal(new Set(NATIVE_NODB_FILES).size,5);
const units=new Map(),profiles=new Map(),byFile=new Map(NATIVE_NODB_PROFILES.map(row=>[row.file,row]));
for(const row of NATIVE_NODB_PROFILES){
 const descriptor=Object.freeze({version:1,profile:row.profile,workers:1,isolation:'job-host'});
 const hash=createHash('sha256').update(JSON.stringify({file:row.file,descriptor})).digest('hex');
 const unit=Object.freeze({id:'nodb-'+hash.slice(0,16),kind:'nodb',files:Object.freeze([row.file]),pdfTools:false,singleton:descriptor});
 assert(!units.has(unit.id),'Native NoDB unit identity collision');units.set(unit.id,unit);profiles.set(unit.id,row);
}
/** Complete deterministic normal-unit shape, or undefined for unrelated identity. */
export const nativeNoDbUnitForId=id=>units.get(id);
/** Exact selector lookup for the pre-Git admission frontier; metadata is not a live proof. */
export const nativeNoDbFile=file=>byFile.get(file);
/** Known-file/profile intent must match the ENTIRE sole normal descriptor or refuse. */
export function nativeNoDbProfile(unit){
 const files=unit?.files,known=Array.isArray(files)&&files.some(file=>byFile.has(file));
 const profile=unit?.singleton?.profile;
 const profileIntent=typeof profile==='string'&&profile.startsWith('linux-owned-');
 if(!known&&!profileIntent&&!units.has(unit?.id))return undefined;
 const expected=units.get(unit?.id);assert(expected&&isDeepStrictEqual(unit,expected),'Malformed/unknown normal native NoDB capability');
 return profiles.get(expected.id);
}
export const nativeNoDbUnit=unit=>nativeNoDbProfile(unit)!==undefined;
