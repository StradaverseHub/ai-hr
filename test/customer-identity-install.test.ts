import { describe, expect, it } from 'vitest';
import { customerEmailDatabase, customerSocketGroup } from '../deploy/identity-email/customer-install';
const owner='postgresql://ai_hr_owner:private@db.internal/hr?sslmode=verify-full';
const worker='postgresql://aihr_identity_email:private@db.internal/hr?sslmode=verify-full';
describe('prepared customer identity service connection',()=>{
 it('accepts a distinct role on the same verified remote HR database',()=>{expect(customerEmailDatabase(owner,worker).username).toBe('aihr_identity_email');});
 it.each([worker.replace('verify-full','require'),worker+'&sslmode=disable',worker+'&User=postgres',worker.replace('/hr?','/another?'),worker.replace('db.internal','another.internal'),worker.replace('aihr_identity_email','postgres')])('refuses an unsafe service connection without reflecting secrets',value=>{
   try{customerEmailDatabase(owner,value);throw new Error('did not refuse');}catch(error){expect(String(error)).not.toContain('private');expect(String(error)).not.toContain('did not refuse');}
 });
 it('permits only an OS group identifier in a systemd socket setting',()=>{expect(customerSocketGroup('aihr')).toBe('aihr');expect(()=>customerSocketGroup('aihr\nSocketMode=0666')).toThrow();});
});
