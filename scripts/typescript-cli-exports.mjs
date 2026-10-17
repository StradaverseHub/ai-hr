/**
 * Node/tsx exposes these CommonJS-transformed TypeScript owners under `default`, while
 * Vitest/native ESM exposes their namespace. Preserve the owner's complete inferred type.
 * This adapter resolves the module boundary only; it never replaces a missing domain export.
 * @template {object} T
 * @param {T & {readonly default?: T}} namespace
 * @returns {T}
 */
export function typescriptCliExports(namespace) {
  const selected=namespace.default??namespace;
  if(selected===null||typeof selected!=='object'||Array.isArray(selected))throw new Error('TypeScript CLI owner namespace required.');
  return selected;
}
