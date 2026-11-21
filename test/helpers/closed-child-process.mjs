import {execFileSync,spawn,spawnSync} from 'node:child_process';

// Node accepts an explicit environment without NODE_ENV. Keep the fixture's
// exact environment at this boundary despite Next's app-specific augmentation.
/** @typedef {Record<string,string|undefined>} ClosedChildEnvironment */
/** @typedef {{env:ClosedChildEnvironment}} ClosedEnvironmentOption */
/** @typedef {Omit<import('node:child_process').ExecFileSyncOptionsWithStringEncoding,'env'> & ClosedEnvironmentOption} ExecTextOptions */
/** @typedef {Omit<import('node:child_process').ExecFileSyncOptionsWithBufferEncoding,'env'> & ClosedEnvironmentOption} ExecBufferOptions */

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {Omit<import('node:child_process').SpawnOptions,'env'> & ClosedEnvironmentOption} options
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnClosed(command,args,options){return spawn(command,args,options);}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {Omit<import('node:child_process').SpawnSyncOptionsWithStringEncoding,'env'> & ClosedEnvironmentOption} options
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
export function spawnClosedTextSync(command,args,options){return spawnSync(command,args,options);}

/**
 * @overload
 * @param {string} command
 * @param {readonly string[]} args
 * @param {ExecTextOptions} options
 * @returns {string}
 */
/**
 * @overload
 * @param {string} command
 * @param {readonly string[]} args
 * @param {ExecBufferOptions} options
 * @returns {Buffer}
 */
/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {ExecTextOptions | ExecBufferOptions} options
 * @returns {string | Buffer}
 */
export function execFileClosedSync(command,args,options){return execFileSync(command,args,options);}
