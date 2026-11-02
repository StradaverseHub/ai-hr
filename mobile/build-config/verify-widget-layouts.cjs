/** Parse the actual locked Expo serializer output before it reaches the widget's JavaScriptCore.
 * Run by hosted verification/build hooks. No native runtime, account props or attendance writes.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const babel = require('@babel/core');
const root = path.resolve(__dirname, '..');
const preset = require.resolve('babel-preset-expo', {paths: [root, require.resolve('expo/package.json')]});
const generate = require('@babel/generator').default;
function layouts(source) {
  const result = babel.transformSync(source, {
    filename: path.join(root, 'lib/attendance-widgets.ios.tsx'), cwd: root,
    babelrc: false, configFile: false, presets: [preset], ast: true,
    caller: {name: 'metro', platform: 'ios', isDev: false, supportsStaticESM: true},
  });
  const found = new Map();
  babel.traverse(result.ast, {VariableDeclarator(p) {
    const node = p.node;
    if (node.id.type !== 'Identifier' || !node.id.name.endsWith('Widget') || node.init?.type !== 'TemplateLiteral') return;
    assert.equal(node.init.expressions.length, 0, 'Widget layout must be a closed serialized function');
    // Evaluate only the closed string literal, exactly as the app does, without running the module.
    const text = vm.runInNewContext(generate(node.init).code, Object.create(null));
    assert.equal(typeof text, 'string');
    found.set(node.id.name, text);
  }});
  return found;
}
const actual = layouts(fs.readFileSync(path.join(root, 'lib/attendance-widgets.ios.tsx'), 'utf8'));
assert.deepEqual([...actual.keys()].sort(), ['ActionsWidget', 'InWidget', 'OutWidget']);
for (const [name, code] of actual) {
  new vm.Script(`(${code})`, {filename: name});
  console.log(`[widget-layout] ${name}: serialized JavaScript parses`);
}
if (process.argv.includes('--self-test')) {
  // Reproduce the SDK57 failure: a template literal consumes the newline escape in widget code.
  const broken = layouts("const BrokenWidget=(props)=>{'widget';return <Text>{props.updated.replace(' · ', '\\n')}</Text>}");
  assert.equal(broken.size, 1);
  const sdk = Number(require(path.join(root, 'node_modules/expo/package.json')).version.split('.')[0]);
  if (sdk < 58) {
    assert.throws(() => new vm.Script(`(${broken.get('BrokenWidget')})`), {name: 'SyntaxError'});
    console.log('[widget-layout] SDK57 regression reproduced: escaped newline becomes invalid serialized JavaScript');
  } else {
    // SDK58 fixes the serializer. Keep the original reproducer and require it to parse,
    // alongside all three real widget layouts above, rather than requiring an old defect.
    assert.doesNotThrow(() => new vm.Script(`(${broken.get('BrokenWidget')})`));
    console.log('[widget-layout] SDK58 regression fixed: escaped newline parses');
  }
}
