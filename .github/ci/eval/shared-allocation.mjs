import {closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, writeFileSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';

const cap = 15_000_000_000n;
const attemptPattern = /^[a-zA-Z0-9_-]{1,100}$/;

function nanos(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,10}$/.test(value) || BigInt(value) > cap)
    throw Error('Invalid shared eval reservation amount');
  return BigInt(value);
}

/** Operator-owned, pre-existing directory on one durable filesystem.
 * Holds the full admitted bound for the campaign lifetime. A crash can leave the lock
 * in place. Recovery requires operator inspection and must preserve every reservation.
 */
export function reserveSharedEvalAllocation(directory, attemptId, allocationNanos) {
  if (typeof attemptId !== 'string' || !attemptPattern.test(attemptId) || !isAbsolute(directory))
    throw Error('Invalid shared eval reservation identity');
  const amount = nanos(allocationNanos);
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.uid !== process.getuid() || (root.mode & 0o077) !== 0)
    throw Error('Shared eval allocation directory must be private and operator-owned');

  const lock = join(directory, '.lock');
  mkdirSync(lock, {mode: 0o700});
  try {
    let held = 0n;
    for (const name of readdirSync(directory)) {
      if (name === '.lock') continue;
      const path = join(directory, name);
      const entry = lstatSync(path);
      if (!attemptPattern.test(name) || !entry.isFile() || entry.size > 11)
        throw Error('Invalid shared eval allocation ledger');
      if (name === attemptId) throw Error('Eval attempt already reserved');
      held += nanos(readFileSync(path, 'utf8'));
    }
    if (held + amount > cap) throw Error('Shared eval allocation exhausted');

    const receipt = openSync(join(directory, attemptId), 'wx', 0o600);
    try {
      writeFileSync(receipt, allocationNanos);
      fsyncSync(receipt);
    } finally {
      closeSync(receipt);
    }
    const parent = openSync(directory, 'r');
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    return Object.freeze({attemptId, allocationNanos});
  } finally {
    rmdirSync(lock);
  }
}
