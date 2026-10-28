/** Client-safe Payroll display surface. The formatter has type-only schema dependencies;
 * never import the database-backed service facade into a browser component. */
export {formatPayRule} from '../../core/pay-rule';
