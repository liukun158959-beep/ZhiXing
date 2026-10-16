const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { act, create } = require('react-test-renderer');

function load(relative, mocks = {}) {
  const file = path.resolve(__dirname, '../src', relative);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(file, module); mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file));
  const original = mod.require.bind(mod); mod.require = id => mocks[id] || original(id);
  mod._compile(code, file); return mod.exports;
}
const pets = load('builtin-pet.ts');
const text = node => typeof node === 'string' ? node : (node.children || []).map(text).join('');

test('appearance saves only after a successful RPC and missing models remain disabled', async () => {
  const calls = []; let fail = false;
  const { PetSettings } = load('client/pet-settings.tsx', { '../builtin-pet': pets,
    '@tauri-apps/api/core': { isTauri: () => false }, './api': { rpc: async (_i, method, args) => {
      calls.push({ method, args });
      if (method === 'save_pet_preferences' && fail) throw Error('save failed');
      return { ok: true, skin: args?.skin || 'paper', live2d_available: false };
    } } });
  let view; await act(async () => { view = create(React.createElement(PetSettings, { info: { port: 1, token: 'test' } })); });
  const button = label => view.root.findAllByType('button').find(n => text(n).includes(label));
  assert.equal(button('凯尔希').props.disabled, true);
  await act(async () => button('鼠尾草').props.onClick());
  assert.equal(button('鼠尾草').props['aria-pressed'], true);
  assert.deepEqual(calls.at(-1), { method: 'save_pet_preferences', args: { skin: 'sage', size: 48 } });
  fail = true; await act(async () => button('墨黑').props.onClick());
  assert.equal(button('鼠尾草').props['aria-pressed'], true);
  assert(text(view.root.findByProps({ role: 'alert' })).includes('save failed'));
  await act(async () => view.unmount());
});

test('built-in rendering has live hit bounds, click feedback and cleanup without Core or WebGL', () => {
  const nodes = [];
  const make = () => ({ style: {}, appendChild(node) { nodes.push(node); }, remove() { this.removed = true; },
    getBoundingClientRect: () => ({ x: 20, y: 40, width: 48, height: 48 }),
    setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; } });
  global.document = { createElement: make };
  const canvas = { style: {}, parentElement: { appendChild(node) { nodes.push(node); } } };
  const pet = pets.mountBuiltinPet(canvas, 'sage');
  const host = nodes.find(n => n.className === 'builtin-pet');
  assert(host.innerHTML.includes('鼠尾草'));
  assert.equal(canvas.style.visibility, 'hidden');
  assert.deepEqual(pet.bounds(), { x: 20, y: 40, w: 48, h: 48 });
  pet.play('Tap'); assert.equal(host['data-reacting'], '');
  pet.destroy(); assert.equal(host.removed, true); assert.equal(canvas.style.visibility, '');
  assert.equal(pets.isBuiltinSkin('__proto__'), false);
});
