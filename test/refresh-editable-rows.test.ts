import { describe, expect, it } from 'vitest';
import { refreshEditableRows } from '@/lib/refresh-editable-rows';

describe('catalogue refresh after Excel import', () => {
  it('shows new and changed records while preserving unsaved edits and drafts', () => {
    const row = (id: string, value: string, dirty = false, isNew = false) => ({ id, value, dirty, isNew });
    const current = [row('updated', 'old'), row('editing', 'unsaved', true), row('removed', 'old'), row('draft', 'new draft', true, true)];
    const incoming = [row('updated', 'imported update'), row('editing', 'persisted'), row('added', 'imported addition')];
    expect(refreshEditableRows(current, incoming)).toEqual([
      row('updated', 'imported update'), row('editing', 'unsaved', true), row('added', 'imported addition'), row('draft', 'new draft', true, true),
    ]);
  });
});
