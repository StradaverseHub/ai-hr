/** Remaining original contexts; preserve every write/row/error comparison and independent non-vacuity. */
import {describe,it} from 'vitest';
import {registerR395WriteFixture,compareGenericWriteContext,assertGenericWriteNonVacuity} from './r395-write-fixture';
import {WRITE_CONTEXT_PARTITIONS} from './r395-write-context-partitions.mjs';
registerR395WriteFixture('tertiary');

describe('r395 write path — generic INSERT … RETURNING and UPDATE … RETURNING, every table, every context', () => {
  it.each(WRITE_CONTEXT_PARTITIONS.tertiary)(
    'context #%i: identical outcomes under old and new policies',
    compareGenericWriteContext,
    180_000,
  );

  it.each(WRITE_CONTEXT_PARTITIONS.supplemental)('supplemental non-vacuity control context #%i', compareGenericWriteContext, 180_000);

  it('the generic writes are not vacuous: inserts were both allowed and RLS-refused somewhere, and updates returned rows (third partition)', assertGenericWriteNonVacuity);
});

