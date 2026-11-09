/** Exact current-root pressure diagnostic. The actual semantic check is the stock CLI. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {isAbsolute, join, parse, relative, resolve, sep} from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const orderSeal = rows => ({count: rows.length, sha256: digest(rows.join('\n') + '\n')});
const inventory = {
  run: '42622447268', artifactSha256: '3d04b526646ca45c9a0e48b2e49f060f9649bcdab0e71c5a17491272bd1d4c6c',
  original: {count: 9213, sha256: '4985e950cd4e517650db3b6667126a5ea2a2495183c4a21b2a83362321d364a9'},
  build: {count: 5025, sha256: '424c024160e5ec43e9457fdd711d6ae33fd68515b1750c6756733bd506e71e1f'},
  'test-tooling-first': {count: 2094, sha256: 'fa6cadcb858a986aa50d0a2c0d2aadfa50ca07f358d249009d30498649b9d34e'},
  'test-tooling-second': {count: 2094, sha256: '48e72ca8875891261b568986d83ae661fb0a3d34da6593f5f8fc4c5ad5ea557a'},
};
const localContext = {
  '.next/types/cache-life.d.ts': '87384ad5954f65285fc17ba8ed39d010a8ef111edba114e493b0431d677e5faa',
  '.next/types/routes.d.ts': '52aeb68060ebdc801316e0a6880c848ee0fbc87542c452b65d963c1dafbb7432',
  'next-env.d.ts': '1862ac4bbbc5192d4bf562161df66ea547ed3e67173100656ab606ae9797db2b',
  'scripts/feedback-plan.ts': 'ae931dc997528695a4d62d6fc75d3597451b49bd3d0eab58c46047a69925f9f1',
  'test/browser-setup.ts': '68470a79ae343d0cda79d3a4a779742ef8834d91acb929d6ea7253b465e3de8a',
  'types/fontkit.d.ts': 'f630880cb7f3ceeb04aafc975b18ca4bace078589bb15def4dc2f109e4dfd771',
};
const otherGenerated = {
  '.next/types/root-params.d.ts': 'f3387dd7800eec3c34273f7a8efad13e864598c7e8f788d321e407390989bb59',
  '.next/types/validator.ts': '860b54f3461834c458201cb58dbf3915fcafc89647b9a76abbe8d56242968124',
};
const automaticTypes = {
  'node_modules/.pnpm/@types+leaflet@1.9.22/node_modules/@types/leaflet/index.d.ts': 'e8242377a293dd0b1d47394f589c1e3a3d1c8e34ef86fc2e50688b4e8fdfea08',
  'node_modules/.pnpm/@types+node@20.19.41/node_modules/@types/node/index.d.ts': 'b1810689b76fd473bd12cc9ee219f8e62f54a7d08019a235d07424afbf074d25',
  'node_modules/.pnpm/@types+qrcode@1.5.6/node_modules/@types/qrcode/index.d.ts': '006d8ff9a051d61b0887b594b1e76c73314bb1a6fe39026867418937ea2259b3',
  'node_modules/.pnpm/@types+react@19.2.16/node_modules/@types/react/index.d.ts': '2577e7e800bdece2956ca027cb5c17aa359abd968eb9355760110c853f4fb9da',
  'node_modules/.pnpm/@types+react-dom@19.2.3_@types+react@19.2.16/node_modules/@types/react-dom/index.d.ts': 'be1cc4d94ea60cbe567bc29ed479d42587bf1e6cba490f123d329976b0fe4ee5',
};
const cells = ['build', 'test-tooling-first', 'test-tooling-second'];
const [cell, source, directory] = process.argv.slice(2);
assert(process.argv.length === 5 && cells.includes(cell) && source === process.cwd());
assert(isAbsolute(source) && isAbsolute(directory) && realpathSync(source) === source && realpathSync(directory) === directory);
assert(lstatSync(directory).isDirectory() && (lstatSync(directory).mode & 0o777) === 0o700);
assert(process.versions.node === '22.23.3');
const require = createRequire(join(source, 'package.json'));
const compilerApi = require.resolve('typescript');
const compilerCli = require.resolve('typescript/lib/_tsc.js');
assert([compilerApi, compilerCli].every(path => path.startsWith(join(source, 'node_modules') + sep) && realpathSync(path) === path));
assert(digest(readFileSync(compilerApi)) === '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675');
assert(digest(readFileSync(compilerCli)) === 'e8f349eabd48486bdb2bf9dc1a00c89d58297270c54b745838879e2859194419');
const ts = require('typescript');
assert(ts.version === '5.9.3');

function readConfig(path) {
  const config = ts.getParsedCommandLineOfConfigFile(path, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => { throw Error('Native config parse refused'); },
  });
  assert(config && config.errors.length === 0 && !config.projectReferences?.length);
  const roots = config.fileNames.map(file => {
    const name = relative(source, file);
    assert(name && !name.startsWith('..' + sep) && !isAbsolute(name) && !/[\x00-\x1f]/.test(name));
    assert(resolve(source, name) === file);
    return name;
  });
  assert(new Set(roots).size === roots.length);
  return {roots, options: config.options};
}

function optionsForComparison(options) {
  const {configFilePath, typeRoots, ...rest} = options;
  return rest;
}

const original = readConfig(join(source, 'tsconfig.json'));
const build = readConfig(join(source, 'tsconfig.build.json'));
assert.deepEqual(orderSeal(original.roots), inventory.original);
assert.deepEqual(orderSeal(build.roots), inventory.build);
assert.deepEqual(optionsForComparison(build.options), optionsForComparison(original.options));
assert(original.options.strict === true && original.options.noEmit === true && original.options.pathsBasePath === source);
assert(original.options.types === undefined && original.options.typeRoots === undefined && !original.options.composite);
const originalSet = new Set(original.roots);
const buildSet = new Set(build.roots);
assert(build.roots.every(root => originalSet.has(root)));
const complement = original.roots.filter(root => !buildSet.has(root));
assert(complement.length === 4188);
const byCell = {build: build.roots, 'test-tooling-first': complement.slice(0, 2094), 'test-tooling-second': complement.slice(2094)};
for (const key of cells) assert.deepEqual(orderSeal(byCell[key]), inventory[key]);
const ownership = cells.flatMap(key => byCell[key]);
assert(ownership.length === originalSet.size && new Set(ownership).size === originalSet.size && ownership.every(root => originalSet.has(root)));

for (const [name, expected] of Object.entries({...localContext, ...otherGenerated, ...automaticTypes})) {
  const path = join(source, name);
  const stat = lstatSync(path);
  assert(realpathSync(path) === path && stat.isFile() && stat.size > 0 && stat.size <= 4 * 1024 ** 2);
  assert.equal(digest(readFileSync(path)), expected, name);
}
assert(Object.keys(localContext).every(name => originalSet.has(name)));
const typeRoots = ts.getEffectiveTypeRoots(original.options, ts.sys);
const expectedTypeRoots = [];
for (let current = source;; current = resolve(current, '..')) {
  expectedTypeRoots.push(join(current, 'node_modules/@types'));
  if (current === parse(current).root) break;
}
assert.deepEqual(typeRoots, expectedTypeRoots);
assert.deepEqual(typeRoots.filter(root => ts.sys.directoryExists(root)), [join(source, 'node_modules/@types')]);

const owned = new Set(byCell[cell]);
const context = new Set(Object.keys(localContext));
const roots = original.roots.filter(root => owned.has(root) || context.has(root));
const project = join(directory, 'partition.tsconfig.json');
writeFileSync(project, JSON.stringify({
  extends: join(source, 'tsconfig.json'), files: roots.map(root => join(source, root)), include: [], exclude: [],
  compilerOptions: {typeRoots},
}), {flag: 'wx', mode: 0o600});
const generated = readConfig(project);
assert.deepEqual(generated.roots, roots);
assert.deepEqual(generated.options.typeRoots, typeRoots);
assert.deepEqual(optionsForComparison(generated.options), optionsForComparison(original.options));
const plan = {cell, inventory, owned: orderSeal(byCell[cell]), configured: orderSeal(roots), localContext, automaticTypes, roots,
  originalRootOwnershipExact: true, externalAmbientGlobalParityProven: false};
writeFileSync(join(directory, 'partition-plan.json'), JSON.stringify(plan) + '\n', {flag: 'wx', mode: 0o600});
