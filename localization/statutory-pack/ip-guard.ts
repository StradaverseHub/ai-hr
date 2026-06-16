/**
 * Classify an IP literal as publicly routable (ADR-0020 §5 SSRF guard). The remote-pull fetcher resolves a
 * hostname to its addresses and refuses to connect if ANY resolves to a private / loopback / link-local /
 * CGNAT / mapped range — the classic SSRF targets (cloud metadata 169.254.169.254, internal services, the
 * Postgres host). Pure + unit-tested.
 */

/** False for private/loopback/link-local/reserved IPv4 + IPv6 (incl. IPv4-mapped); true for public. */
export function isPublicIp(ip: string): boolean {
  const v4 = ip.includes('.') ? ip.split('.').map(Number) : null;
  if (v4 && v4.length === 4 && v4.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = v4;
    if (a === 10) return false; // 10/8
    if (a === 127) return false; // loopback
    if (a === 0) return false; // 0/8
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12
    if (a === 192 && b === 168) return false; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 CGNAT
    if (a === 192 && b === 0) return false; // 192.0.0/24 + 192.0.2/24 (test-net)
    if (a >= 224) return false; // multicast + reserved (224+)
    return true;
  }
  // IPv6
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return false;
  // IPv4-mapped (::ffff:a.b.c.d) → classify the embedded v4.
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIp(mapped[1]);
  if (v6.startsWith('fe80')) return false; // link-local
  if (v6.startsWith('fc') || v6.startsWith('fd')) return false; // fc00::/7 unique-local
  if (v6.startsWith('ff')) return false; // multicast
  return true;
}
