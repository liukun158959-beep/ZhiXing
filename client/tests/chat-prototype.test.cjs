const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');

function load(name) {
  const base = path.resolve(__dirname, '../src/client', name);
  const filename = fs.existsSync(base + '.tsx') ? base + '.tsx' : base + '.ts';
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = id => id.endsWith('.css') ? {} : id === './startup' ? { startupReady() {} } : id.startsWith('./') ? load(id.slice(2)) : original(id);
  mod._compile(compiled, filename); return mod.exports;
}
const { initialDemo, demoReducer: reduce, restoreDemo, DEMO_STORAGE } = load('chat-prototype-state');
const send = (state, text, rest = {}) => reduce(state, { type: 'send', text, target: '', mode: 'message', ...rest });
const text = node => typeof node === 'string' ? node : (node.children || []).map(text).join('');
const button = (view, label) => view.root.findAllByType('button').find(node => node.props['aria-label'] === label || text(node) === label);

function environment() {
  const saved = new Map(), timers = new Map(); let seq = 0;
  global.localStorage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) };
  global.window = { setInterval(fn) { timers.set(++seq, fn); return seq; }, clearInterval(id) { timers.delete(id); } };
  global.document = { documentElement: { classList: { contains: () => true, toggle() {} } }, activeElement: { focus() {} }, getElementById() {} };
  return { saved, timers };
}

test('chat stays available during work; task supplements are scoped and applied at the next step', () => {
  const first = initialDemo(), original = JSON.stringify(first);
  let state = send(first, '进度如何？');
  assert.equal(state.messages.length, first.messages.length + 2);
  assert.equal(state.runs.length, 2); assert.equal(state.runs[0].step, 0);
  state = send(state, '重点看部署成本', { run: 'r1' });
  assert.deepEqual(state.runs[0].updates, ['重点看部署成本']); assert.equal(state.runs[0].applied, 0);
  assert.deepEqual(state.runs[1].updates, []);
  state = reduce(state, { type: 'advance' }); assert.equal(state.runs[0].applied, 1);
  state = reduce(state, { type: 'select', id: 'dm-writer' });
  const rejected = send(state, '跨会话注入', { run: 'r1' });
  assert.match(rejected.notice, /不属于当前会话/); assert.equal(rejected.messages.length, state.messages.length);
  assert.equal(JSON.stringify(first), original); // Reducer replay must not mutate historical snapshots.
  const rejectedMention = send(state, '@研究员 请帮忙', { mode: 'task' });
  assert.match(rejectedMention.notice, /不在当前会话/); assert.equal(rejectedMention.runs.length, state.runs.length);
});

test('independent runs advance together; stopping one cancels its dependents but preserves other conversations', () => {
  let state = reduce(initialDemo(), { type: 'select', id: 'dm-tebb' });
  state = send(state, '另一个任务', { mode: 'task' }); const independent = state.runs.at(-1).id;
  state = reduce(state, { type: 'advance' });
  assert.equal(state.runs.find(run => run.id === 'r1').step, 1);
  assert.equal(state.runs.find(run => run.id === independent).step, 1);
  state = reduce(state, { type: 'cancel', id: 'r1' });
  assert.equal(state.runs[0].state, 'cancelled'); assert.equal(state.runs[1].state, 'cancelled');
  assert.equal(state.runs.find(run => run.id === independent).state, 'running');
  const count = state.messages.length;
  state = reduce(state, { type: 'cancel', id: 'r1' }); assert.equal(state.messages.length, count);
  state = reduce(state, { type: 'advance' }); assert.equal(state.runs[0].step, 1);
});

test('handoff is visible, completion creates one artifact and delivery decisions cannot duplicate', () => {
  let state = initialDemo();
  for (let i = 0; i < 3; i++) state = reduce(state, { type: 'advance' });
  assert.equal(state.runs[0].state, 'succeeded'); assert.equal(state.runs[1].state, 'waiting');
  state = reduce(state, { type: 'advance' });
  assert.equal(state.runs[1].state, 'running'); assert.equal(state.runs[1].step, 0);
  for (let i = 0; i < 3; i++) state = reduce(state, { type: 'advance' });
  assert.equal(state.runs[1].state, 'succeeded'); assert.match(state.runs[1].artifact, /未进行联网检索/);
  assert.equal(state.messages.filter(message => message.run === 'r2' && message.kind === 'result').length, 1);
  state = reduce(state, { type: 'advance' });
  assert.equal(state.messages.filter(message => message.run === 'r2' && message.kind === 'result').length, 1);
  state = reduce(state, { type: 'request', run: 'r2' }); state = reduce(state, { type: 'request', run: 'r2' });
  assert.equal(state.requests.length, 1);
  const request = state.requests[0].id;
  state = reduce(state, { type: 'decide', id: request, approved: true }); const count = state.messages.length;
  assert.match(state.messages.at(-1).text, /没有实际向飞书发送/);
  state = reduce(state, { type: 'decide', id: request, approved: true }); assert.equal(state.messages.length, count);
});

test('agent identities, group routing and private memory survive restore without leaking into messages', () => {
  let state = initialDemo();
  const privateText = '只属于这个 Agent 的演示记忆';
  state = reduce(state, { type: 'agent', agent: { ...state.agents[1], name: '技术观察员', memory: privateText } });
  assert.equal(state.conversations.find(c => c.id === 'dm-research').title, '技术观察员');
  state = reduce(state, { type: 'group', title: '新研究群', goal: '比较部署方案', members: ['tebb', 'research', 'research'] });
  assert.deepEqual(state.conversations.at(-1).members, ['tebb', 'research']);
  state = send(state, '@技术观察员 单独研究', { mode: 'task' });
  assert.equal(state.runs.at(-1).agent, 'research'); assert.equal(state.runs.at(-1).dependency, undefined);
  assert(!JSON.stringify(state.messages).includes(privateText));
  const restored = restoreDemo(JSON.stringify(state)); assert.deepEqual(restored, JSON.parse(JSON.stringify(state)));
  for (const raw of ['broken', '{}', JSON.stringify({ ...state, agents: [null] }), JSON.stringify({ ...state, runs: [{ ...state.runs[0], agent: 'missing' }] })]) {
    assert.deepEqual(restoreDemo(raw), initialDemo());
  }
});

test('UI sends while running, preserves per-conversation drafts and targets supplements to the selected task', async () => {
  const { saved } = environment(); const { ChatPrototype } = load('chat-prototype'); let view;
  await act(async () => { view = create(React.createElement(ChatPrototype)); });
  const composer = () => view.root.findByProps({ 'aria-label': '原型消息' });
  await act(async () => composer().props.onChange({ target: { value: '运行中也能聊天' } }));
  assert.equal(button(view, '发送↑').props.disabled, false);
  await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert(text(view.toJSON()).includes('当前有 2 项后台任务'));
  await act(async () => composer().props.onChange({ target: { value: '群草稿' } }));
  const dm = () => view.root.findAllByType('button').find(node => node.props.className?.includes('cp-conversation') && text(node).startsWith('R研究员'));
  await act(async () => dm().props.onClick()); assert.equal(composer().props.value, '');
  await act(async () => composer().props.onChange({ target: { value: '私聊草稿' } }));
  const group = () => view.root.findAllByType('button').find(node => node.props.className?.includes('cp-conversation') && text(node).includes('AI 研究室'));
  await act(async () => group().props.onClick()); assert.equal(composer().props.value, '群草稿');
  const run = view.root.findByProps({ 'data-demo-run': 'r1' });
  await act(async () => run.findAllByType('button').find(node => text(node) === '补充要求').props.onClick());
  await act(async () => composer().props.onChange({ target: { value: '优先关注部署成本' } }));
  await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert(text(view.toJSON()).includes('等待下一步'));
  await act(async () => button(view, '推进一步 →').props.onClick());
  const persisted = JSON.parse(saved.get(DEMO_STORAGE));
  assert.equal(persisted.runs[0].applied, 1); assert.equal(persisted.runs[1].updates.length, 0);
  await act(async () => view.unmount());
});

test('UI creates groups and Agent settings; reset is explicit and does not touch unrelated storage', async () => {
  const { saved } = environment(); saved.set('real-chat-sentinel', 'keep');
  const { ChatPrototype } = load('chat-prototype'); let view;
  await act(async () => { view = create(React.createElement(ChatPrototype)); });
  await act(async () => button(view, '新建协作群').props.onClick());
  let modal = view.root.findByProps({ role: 'dialog' });
  await act(async () => modal.findAllByType('input').find(node => node.props.type !== 'checkbox').props.onChange({ target: { value: '技术观察' } }));
  await act(async () => modal.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert(view.root.findByType('h1').children.includes('技术观察'));
  await act(async () => button(view, '创建 Agent').props.onClick());
  modal = view.root.findByProps({ role: 'dialog' });
  await act(async () => modal.findAllByType('input').find(node => node.props.maxLength === 24).props.onChange({ target: { value: '审阅者' } }));
  await act(async () => modal.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert(JSON.parse(saved.get(DEMO_STORAGE)).agents.some(agent => agent.name === '审阅者'));
  await act(async () => button(view, '重置演示').props.onClick());
  assert.equal(JSON.parse(saved.get(DEMO_STORAGE)).agents.length, 4);
  await act(async () => button(view, '确认重置原型').props.onClick());
  assert.equal(JSON.parse(saved.get(DEMO_STORAGE)).agents.length, 3); assert.equal(saved.get('real-chat-sentinel'), 'keep');
  await act(async () => view.unmount());
});

test('automatic simulation is opt-in and timers stop when the view closes', async () => {
  const { timers } = environment(); const { ChatPrototype } = load('chat-prototype'); let view;
  await act(async () => { view = create(React.createElement(ChatPrototype)); });
  assert.equal(timers.size, 0);
  await act(async () => button(view, '自动演示').props.onClick()); assert.equal(timers.size, 1);
  await act(async () => [...timers.values()][0]());
  await act(async () => button(view, '暂停').props.onClick()); assert.equal(timers.size, 0);
  await act(async () => button(view, '自动演示').props.onClick());
  await act(async () => view.unmount()); assert.equal(timers.size, 0);
});

test('Chinese IME Enter and Shift+Enter do not submit a draft', async () => {
  const { saved } = environment(); const { ChatPrototype } = load('chat-prototype'); let view;
  await act(async () => { view = create(React.createElement(ChatPrototype)); });
  const composer = () => view.root.findByProps({ 'aria-label': '原型消息' });
  await act(async () => composer().props.onChange({ target: { value: '中文输入' } }));
  const before = JSON.parse(saved.get(DEMO_STORAGE)).messages.length;
  for (const rest of [{ nativeEvent: { isComposing: true } }, { keyCode: 229 }, { shiftKey: true }]) {
    await act(async () => composer().props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: {}, preventDefault() { throw new Error('must not submit'); }, ...rest }));
    assert.equal(JSON.parse(saved.get(DEMO_STORAGE)).messages.length, before);
  }
  let prevented = false;
  await act(async () => composer().props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() { prevented = true; } }));
  assert.equal(prevented, true); assert.equal(JSON.parse(saved.get(DEMO_STORAGE)).messages.length, before + 2);
  await act(async () => view.unmount());
});

test('standalone preview loads no real App; normal startup still loads the real App', async () => {
  for (const preview of [true, false]) {
    environment(); global.window.location = { search: preview ? '?preview=chat' : '' };
    global.document.getElementById = () => ({});
    const filename = path.resolve(__dirname, '../src/client/main.tsx');
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
    const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
    const original = mod.require.bind(mod); let element, appLoads = 0, previewLoads = 0, receivedProps;
    mod.require = id => {
      if (id.endsWith('.css')) return {};
      if (id === 'react-dom/client') return { createRoot: () => ({ render(value) { element = value; } }) };
      if (id === './App') { appLoads++; return { App: () => React.createElement('div', { 'data-real-app': '' }) }; }
      if (id === './chat-prototype') { previewLoads++; return { ChatPrototype: props => { receivedProps = props; return React.createElement('div', { 'data-preview': '' }); } }; }
      return original(id);
    };
    mod._compile(compiled, filename); let view;
    await act(async () => { view = create(element); });
    assert.equal(appLoads, preview ? 0 : 1); assert.equal(previewLoads, preview ? 1 : 0);
    if (preview) assert.equal(receivedProps.standalone, true);
    await act(async () => view.unmount());
  }
});
