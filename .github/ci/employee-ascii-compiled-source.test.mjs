import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {employeeAsciiCompiledSource,employeeAsciiSourceWitness,EMPLOYEE_ASCII_TEMPLATE_SHA256,EMPLOYEE_ASCII_COMPILED_SHA256} from './employee-ascii-compiled-source.mjs';
const template=()=>readFileSync(new URL('../../test/fixtures/employee-choice-exact-ascii-purpose.sql',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
test('reconstructs the independent whole historical compiled SQL while binding the distinct current committed template',()=>{
 const raw=template(),compiled=employeeAsciiCompiledSource(raw);assert.equal(hash(raw),EMPLOYEE_ASCII_TEMPLATE_SHA256);assert.equal(hash(compiled),EMPLOYEE_ASCII_COMPILED_SHA256);assert.notEqual(hash(raw),hash(compiled));assert(!compiled.includes('/* EMPLOYEE_CHOICE_ASCII_'));
 assert.deepEqual(employeeAsciiSourceWitness({templateSha256:hash(raw),sourceSha256:hash(compiled)},raw),compiled);
});
test('refuses altered omitted duplicated or already compiled template bytes before native log replay',()=>{
 const raw=template(),compiled=employeeAsciiCompiledSource(raw);
 for(const invalid of [Buffer.alloc(0),Buffer.concat([raw,Buffer.from(' ')]),Buffer.from(raw.toString().replace('/* EMPLOYEE_CHOICE_ASCII_NAME */','')),Buffer.from(raw.toString().replace('/* EMPLOYEE_CHOICE_ASCII_CODE */','/* EMPLOYEE_CHOICE_ASCII_NAME */')),compiled])assert.throws(()=>employeeAsciiCompiledSource(invalid));
});
test('refuses a swapped or candidate-claimed compiled source identity independently of correct committed template bytes',()=>{
 const raw=template();for(const witness of [{},{templateSha256:EMPLOYEE_ASCII_COMPILED_SHA256,sourceSha256:EMPLOYEE_ASCII_TEMPLATE_SHA256},{templateSha256:EMPLOYEE_ASCII_TEMPLATE_SHA256,sourceSha256:EMPLOYEE_ASCII_TEMPLATE_SHA256},{templateSha256:'a'.repeat(64),sourceSha256:EMPLOYEE_ASCII_COMPILED_SHA256}])assert.throws(()=>employeeAsciiSourceWitness(witness,raw));
});
