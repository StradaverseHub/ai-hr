import {expect,it} from 'vitest';
import {admissionFailureMarkers} from '../scripts/performance/admission-failure-log.mjs';

it('publishes only closed counters from private server logs',()=>{
 const value=admissionFailureMarkers(`DatabaseAdmissionError: private@example.invalid
  code: 'queue-full'
  code: "queue-timeout"
  query: 'select private_column from private_table'
  canceling statement due to lock timeout
  canceling statement due to statement timeout`);
 expect(value).toEqual({queueFull:1,queueTimeout:1,admissionError:1,statementTimeout:1,lockTimeout:1});
 expect(JSON.stringify(value)).not.toMatch(/private|select/);
 expect(admissionFailureMarkers('')).toEqual({queueFull:0,queueTimeout:0,admissionError:0,statementTimeout:0,lockTimeout:0});
});
