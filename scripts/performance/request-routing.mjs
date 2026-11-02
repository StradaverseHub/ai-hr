/** Development proxy scheduling only. HTTP methods do not grant SQL or business authority.
 * @param {number} workers
 * @param {'round-robin'|'method-split'} mode
 * @returns {(method?: string) => number}
 */
export function createPerformanceRequestRouter(workers, mode) {
  if (![1, 2].includes(workers)) throw new RangeError('Expected one or two app workers.');
  let next = 0;
  return (method) => {
    if (workers === 2 && mode === 'method-split') {
      const normalized = method?.toUpperCase();
      return normalized === 'GET' || normalized === 'HEAD' ? 0 : 1;
    }
    const worker = next;
    next = (next + 1) % workers;
    return worker;
  };
}
