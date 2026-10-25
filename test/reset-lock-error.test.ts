import {describe,expect,it} from 'vitest';
import {DrizzleQueryError} from 'drizzle-orm/errors';
import {isResetLockError} from './reset-lock-error';

describe('fixture reset retry recognizes the underlying PostgreSQL failure',()=>{
  it.each(['40P01','55P03','57014'])('retries intended SQLSTATE %s inside the actual Drizzle wrapper',code=>{
    const cause=Object.assign(new Error('Localized PostgreSQL message'),{code});
    const wrapped=new DrizzleQueryError('TRUNCATE fixture RESTART IDENTITY CASCADE',[],cause);
    expect(/lock_timeout|deadlock detected|canceling statement/i.test(wrapped.message)).toBe(false);
    expect(isResetLockError(wrapped)).toBe(true);
  });
  it('follows a nested error without relying on English text',()=>{
    expect(isResetLockError(new Error('outer',{cause:new DrizzleQueryError('TRUNCATE fixture',[],Object.assign(new Error('Localized PostgreSQL message'),{code:'40P01'}))}))).toBe(true);
  });
  it.each(['42501','42P01','23503','53200'])('does not retry unrelated SQLSTATE %s even when query text contains lock words',code=>{
    const wrapped=new DrizzleQueryError('TRUNCATE lock_timeout_log',[],Object.assign(new Error('unrelated'),{code}));
    expect(isResetLockError(wrapped)).toBe(false);
  });
  it('preserves direct legacy lock/deadlock/cancel messages without a SQLSTATE',()=>{
    for(const message of ['lock_timeout','deadlock detected','canceling statement due to lock timeout'])expect(isResetLockError(new Error(message))).toBe(true);
  });
  it('never treats a missing-cause wrapper SQL string as a lock error',()=>{
    expect(isResetLockError(new DrizzleQueryError('TRUNCATE lock_timeout_log',[],undefined))).toBe(false);
  });
  it('bounds cyclic and excessively nested causes',()=>{
    const cycle:{cause?:unknown}={};cycle.cause=cycle;expect(isResetLockError(cycle)).toBe(false);
    let deep:unknown={code:'40P01'};for(let i=0;i<9;i++)deep={cause:deep};expect(isResetLockError(deep)).toBe(false);
  });
  it('does not throw or retry when metadata is unreadable or absent',()=>{
    const bad=Object.defineProperty({},'cause',{get(){throw Error('unreadable');}});
    for(const error of [bad,null,undefined,42,new Error('permission denied')])expect(isResetLockError(error)).toBe(false);
  });
});
