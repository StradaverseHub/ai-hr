/** MEASUREMENT ONLY (branch claude/bank-import-memory-measure-20261114, never merged): isolated-process peak RSS of the
 * previous whole-file Bank decode at the maximum CSV and workbook. See test/helpers/bank-decode-rss.ts. */
import {describe,expect,it} from 'vitest';
import {hostLine} from './helpers/worker-stall-measure';
import {measureDecodes} from './helpers/bank-decode-rss';
describe('MEASUREMENT: isolated Bank decode memory (old)',()=>{
 it('decodes the maximum CSV and workbook in fresh processes',async()=>{
  hostLine();
  const results=await measureDecodes('old');
  expect(results.map(r=>r.rows)).toEqual([250000,250000]);
 },1_080_000);
});
