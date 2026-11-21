import {describe, expect, it} from 'vitest';
import {movementExitVersion} from '../lib/movement-exit-version';
const exit = '2026-10-13';
const version = (id: string, validFrom: string, validTo: string | null = exit) => ({id, validFrom, validTo});
const event = (id: string, sequence: number, eventType = 'employment.assignment.changed') => ({aggregateId:id, sequence, eventType});
describe('exit-boundary version selection', () => {
  it('includes the retained version closed on the exit date and never reaches back across a gap', () => {
    expect(movementExitVersion([version('saved','2025-05-01')],exit,20,[])?.id).toBe('saved');
    expect(movementExitVersion([version('gap','2025-05-01','2026-10-12')],exit,20,[])).toBeNull();
    expect(movementExitVersion([version('future','2026-10-14',null)],exit,20,[])).toBeNull();
  });
  it('handles hire on the exit date without inventing an earlier day', () => {
    expect(movementExitVersion([version('hire',exit)],exit,20,[])?.id).toBe('hire');
  });
  it('uses ledger sequence for same-day changes and excludes a later same-day replacement', () => {
    const versions=[version('hire',exit),version('first',exit),version('second',exit),version('later',exit,null)];
    const events=[event('first',5),event('second',10),event('later',30)];
    expect(movementExitVersion(versions,exit,20,events)?.id).toBe('second');
    expect(movementExitVersion([...versions].reverse(),exit,20,[...events].reverse())?.id).toBe('second');
  });
  it('does not guess when same-day historical versions lack lineage', () => {
    expect(movementExitVersion([version('a',exit),version('b',exit)],exit,20,[])).toBeNull();
  });
  it('uses administrative reporting version lineage with the same boundary', () => {
    expect(movementExitVersion([version('old',exit),version('new',exit)],exit,20,[event('old',3,'reporting-line.set'),event('new',12,'reporting-line.set')])?.id).toBe('new');
  });
});
