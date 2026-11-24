import type { ComponentProps } from 'react';

/**
 * An uncontrolled filter <select> that follows the value the server chose.
 *
 * Transaction View's filters are plain GET-form selects with `defaultValue`. A client navigation (the employee
 * panel, a tab, a filter link) re-renders them in place, and React does not move an uncontrolled select to a new
 * `defaultValue`: it keeps whatever the DOM holds. On staging (24 Nov 2026) choosing an employee left History's
 * Year / Month on the previous view's 2027 / 01 while the rows showed that employee's 2026-12, so Apply filters
 * would have asked for the wrong month. Keying the element by its default remounts it whenever the server's value
 * changes, and leaves a value the user is choosing alone otherwise.
 */
export function ResettingSelect({ defaultValue, ...props }: Omit<ComponentProps<'select'>, 'defaultValue'> & { defaultValue: string }) {
  return <select key={defaultValue} defaultValue={defaultValue} {...props} />;
}
