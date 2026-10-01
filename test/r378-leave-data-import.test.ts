import { describe, expect, it } from 'vitest';
import { LEAVE_HISTORY_COLUMNS } from '../lib/leave-history-import-schema';
import { LEAVE_BF_COLUMNS } from '../lib/leave-bf-import-schema';
import { leaveDataImportType, requireLeaveImportHeaders } from '../lib/leave-data-import';
const history = LEAVE_HISTORY_COLUMNS.map(column => column.header);
const bf = LEAVE_BF_COLUMNS.map(column => column.header);
describe('selected leave import contract', () => {
  it('has no default and accepts only explicit recognized types', () => {
    for (const value of [undefined, null, '', 'balance', [], { type: 'bf' }]) expect(leaveDataImportType(value)).toBeNull();
    expect(leaveDataImportType('history')).toBe('history'); expect(leaveDataImportType('bf')).toBe('bf');
  });
  it('accepts both actual supplied template headers', () => {
    expect(() => requireLeaveImportHeaders('history', history)).not.toThrow();
    expect(() => requireLeaveImportHeaders('bf', bf)).not.toThrow();
  });
  it('refuses wrong and conflicting files before any writes', () => {
    expect(() => requireLeaveImportHeaders('history', bf)).toThrow('Step 1');
    expect(() => requireLeaveImportHeaders('bf', history)).toThrow('Step 1');
    expect(() => requireLeaveImportHeaders('history', [...history, 'B/F Days'])).toThrow();
    expect(() => requireLeaveImportHeaders('bf', [...bf, 'Leave Start Date'])).toThrow();
    expect(() => requireLeaveImportHeaders('unknown', bf)).toThrow('Step 1');
  });
  it('preserves accepted aliases, any order and unrelated extra columns', () => {
    const aliases = history.map(header => header === 'Employee No.' ? 'Employee Code' : header === 'Leave Reference' ? 'Leave Ref' : header === 'Number of Day' ? 'No of Days' : header).reverse();
    expect(() => requireLeaveImportHeaders('history', [...aliases, 'External Note'])).not.toThrow();
    const bfAliases = bf.map(header => header === 'Employee ID' ? 'Employee Number' : header === 'B/F Days' ? 'Brought Forward Days' : header === 'Entitlement Year' ? 'Year' : header);
    expect(() => requireLeaveImportHeaders('bf', [...bfAliases, 'External Note'])).not.toThrow();
  });
});
