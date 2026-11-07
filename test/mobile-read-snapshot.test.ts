import { describe, expect, it } from 'vitest';
import { createReadSnapshots } from '../mobile/lib/read-snapshot';

describe('unlocked display snapshots', () => {
  it('expires and bounds snapshots, and isolates complete account/employment keys', () => {
    let now=0;
    const store=createReadSnapshots(()=>now,30_000,2);
    store.put('account-A/employment-A/me',{name:'Synthetic A'});
    expect(store.get('account-B/employment-A/me')).toBeUndefined();
    store.put('B',2);store.put('C',3);
    expect(store.get('account-A/employment-A/me')).toBeUndefined();
    expect(store.get('C')).toBe(3);
    now=30_000;expect(store.get('C')).toBeUndefined();
  });
  it('clears data when the private tree closes and refuses late repopulation', () => {
    const store=createReadSnapshots();store.put('me',{name:'Synthetic'});
    store.dispose();store.put('me',{name:'Late private response'});
    expect(store.get('me')).toBeUndefined();
    expect(createReadSnapshots().get('me')).toBeUndefined();
  });
});
