import { BlockList, isIP } from 'node:net';

// Conservative egress policy: reject internal, non-public special-use and transition addresses.
// IANA special-purpose registries; IPv6 is limited to native global unicast.
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',16],['192.88.99.0',24],
  ['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3],
] as const) blocked.addSubnet(address,prefix,'ipv4');
for (const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const)
  blocked.addSubnet(address,prefix,'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::',3,'ipv6');

export function isPublicIp(address:string):boolean {
  if(address.includes('%')) return false;
  const family=isIP(address);
  if(family===4) return !blocked.check(address,'ipv4');
  return family===6 && globalV6.check(address,'ipv6') && !blocked.check(address,'ipv6');
}
