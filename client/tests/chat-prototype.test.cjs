const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');
const markdownModules = {};
test.before(async () => {
  markdownModules['react-markdown'] = await import('react-markdown');
  markdownModules['remark-gfm'] = await import('remark-gfm');
});

function load(name) {
  const base = path.resolve(__dirname, '../src/client', name);
  const filename = fs.existsSync(base + '.tsx') ? base + '.tsx' : base + '.ts';
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = id => markdownModules[id] || (id.endsWith('.css') ? {} : id === './release' ? { CURRENT_RELEASE: {version:'0.2.3'} } : id === './startup' ? { startupReady() {} } : id.startsWith('./') ? load(id.slice(2)) : original(id));
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
  await act(async () => { view = create(React.createElement(ChatPrototype, {standalone:true})); });
  const composer = () => view.root.findByProps({ 'aria-label': '原型消息' });
  await act(async () => composer().props.onChange({ target: { value: '运行中也能聊天' } }));
  assert.equal(button(view, '发送↑').props.disabled, false);
  await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert(text(view.toJSON()).includes('当前有 2 项后台任务'));
  await act(async () => composer().props.onChange({ target: { value: '群草稿' } }));
  const dm = () => view.root.findAllByType('button').find(node => node.props.className?.includes('cp-conversation') && node.props['data-companion'] === 'research');
  await act(async () => dm().props.onClick()); assert.equal(composer().props.value, '');
  await act(async () => composer().props.onChange({ target: { value: '私聊草稿' } }));
  const group = () => view.root.findAllByType('button').find(node => node.props.className?.includes('cp-conversation') && text(node).includes('AI 研究室'));
  await act(async () => group().props.onClick()); assert.equal(composer().props.value, '群草稿');
  await act(async () => button(view, '当前任务').props.onClick());
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
  await act(async () => { view = create(React.createElement(ChatPrototype, {standalone:true})); });
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
  await act(async () => { view = create(React.createElement(ChatPrototype, {standalone:true})); });
  assert.equal(timers.size, 0);
  await act(async () => button(view, '自动演示').props.onClick()); assert.equal(timers.size, 1);
  await act(async () => [...timers.values()][0]());
  await act(async () => button(view, '暂停').props.onClick()); assert.equal(timers.size, 0);
  await act(async () => button(view, '自动演示').props.onClick());
  await act(async () => view.unmount()); assert.equal(timers.size, 0);
});

test('Chinese IME Enter and Shift+Enter do not submit a draft', async () => {
  const { saved } = environment(); const { ChatPrototype } = load('chat-prototype'); let view;
  await act(async () => { view = create(React.createElement(ChatPrototype, {standalone:true})); });
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


const contextEvent = (rest = {}) => ({ preventDefault() {}, currentTarget: { getBoundingClientRect: () => ({ right: 200, top: 100 }), focus() {} }, clientX: 120, clientY: 100, ...rest });

test('normal context menu manages conversations; private memory appears only in developer mode', async () => {
  const { saved } = environment(); const { ChatPrototype } = load('chat-prototype'); let view;
  await act(async () => { view = create(React.createElement(ChatPrototype, {standalone:true})); });
  const dm = () => view.root.findByProps({ 'data-companion': 'research' });
  await act(async () => dm().props.onContextMenu(contextEvent()));
  assert(button(view, '删除对话')); assert(!button(view, '调试伙伴记忆'));
  await act(async () => view.root.findByProps({ role: 'menu' }).props.onKeyDown({ key: 'Escape', preventDefault() {} }));
  assert.equal(view.root.findAllByProps({ role: 'menu' }).length, 0);
  for(let i=0;i<5;i++) await act(async () => view.root.findByProps({'data-product-version':true}).props.onClick());
  assert.equal(saved.get('tebb.developer-mode'), 'true');
  await act(async () => dm().props.onContextMenu(contextEvent()));
  await act(async () => button(view, '调试伙伴记忆').props.onClick());
  let modal = view.root.findByProps({ role: 'dialog' });
  assert(text(modal).includes('伙伴私有记忆'));
  await act(async () => modal.findByType('textarea').props.onChange({ target: { value: '只给阿探的偏好' } }));
  await act(async () => modal.findByType('form').props.onSubmit({ preventDefault() {} }));
  const state = JSON.parse(saved.get(DEMO_STORAGE));
  assert.equal(state.agents[1].memory, '只给阿探的偏好');
  assert(!JSON.stringify(state.messages).includes('只给阿探的偏好'));
  for(let i=0;i<5;i++) await act(async () => view.root.findByProps({'data-product-version':true}).props.onClick());
  await act(async () => dm().props.onKeyDown(contextEvent({ key: 'F10', shiftKey: true })));
  assert(!button(view, '调试伙伴记忆'));
  await act(async () => view.root.findByProps({ className: 'cp-menu-dismiss' }).props.onMouseDown());
  assert.equal(view.root.findAllByProps({ role: 'menu' }).length, 0);
  await act(async () => view.unmount());
});

test('delete inactive DM removes history, preserves companions and opens a fresh conversation', async () => {
  const { saved } = environment(); const { ChatPrototype } = load('chat-prototype'); let view;
  await act(async () => { view = create(React.createElement(ChatPrototype, {standalone:true})); });
  let dm = view.root.findByProps({ 'data-companion': 'writer' });
  await act(async () => dm.props.onClick());
  await act(async () => view.root.findByProps({ 'aria-label': '原型消息' }).props.onChange({ target: { value: '待删除消息' } }));
  await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  await act(async () => dm.props.onContextMenu(contextEvent()));
  await act(async () => button(view, '删除对话').props.onClick());
  await act(async () => button(view, '确认删除').props.onClick());
  let state = JSON.parse(saved.get(DEMO_STORAGE));
  assert(!state.messages.some(m => m.text === '待删除消息'));
  assert.equal(state.agents.length, 3);
  await act(async () => view.root.findByProps({ 'data-companion': 'writer' }).props.onClick());
  state = JSON.parse(saved.get(DEMO_STORAGE));
  assert.notEqual(state.selected, 'dm-writer');
  assert.equal(view.root.findByType('h1').children[0], '墨墨');
  await act(async () => view.unmount());
});

test('active conversation deletion is disabled and normal companion settings hide memory', async () => {
  environment(); const { ChatPrototype } = load('chat-prototype'); let view;
  await act(async () => { view = create(React.createElement(ChatPrototype, {standalone:true})); });
  const group = view.root.findAllByType('button').find(b => b.props.className?.includes('cp-conversation') && text(b).includes('AI 研究室'));
  await act(async () => group.props.onContextMenu(contextEvent()));
  await act(async () => button(view, '删除对话').props.onClick());
  assert.equal(button(view, '确认删除').props.disabled, true);
  await act(async () => button(view, '取消').props.onClick());
  await act(async () => button(view, '创建 Agent').props.onClick());
  const modal = view.root.findByProps({ role: 'dialog' });
  assert(!text(modal).includes('Agent 私有记忆'));
  assert.equal(modal.findAllByType('svg').length, 4);
  await act(async () => view.unmount());
});

test('Markdown formats messages, tables, fenced code and artifacts, and rejects executable links and HTML', async () => {
  environment(); const { ChatPrototype } = load('chat-prototype'); let state = initialDemo();
  const md = '# 标题\n\n**重点**\n\n| 项目 | 结果 |\n| --- | --- |\n| A | B |\n\n```js\nconst a = 1;\n```\n\n[来源](https://example.org) [危险](javascript:alert%281%29)\n\n<script>alert(1)</script>';
  state.messages = [{ id: 'md1', conversation: state.selected, sender: 'writer', text: md, kind: 'result', run: 'r1' }];
  state.runs[0].state = 'succeeded';
  state.runs[0].artifact = md;
  let view; await act(async () => { view = create(React.createElement(ChatPrototype, { standalone: true, live: { state, busy: false, error: '', act: async () => true } })); });
  assert.equal(view.root.findAllByType('table').length, 1);
  assert(view.root.findAllByType('strong').some(n => text(n) === '重点'));
  assert(view.root.findAllByType('code').some(n => text(n).includes('const a = 1;')));
  assert.equal(view.root.findAllByType('script').length, 0);
  assert(!view.root.findAllByType('a').some(n => /^javascript:/i.test(n.props.href || '')));
  const link = view.root.findAllByType('a').find(n => n.props.href === 'https://example.org/');
  assert.equal(link.props.target, '_blank');
  await act(async () => button(view, '当前任务').props.onClick());
  assert(view.root.findByProps({ 'data-demo-run': 'r1' }));
  await act(async () => view.root.findByProps({ className: 'cp-artifact-link' }).props.onClick());
  const artifact = view.root.findByProps({ role: 'dialog' });
  assert.equal(artifact.findAllByType('table').length, 1);
  assert.equal(artifact.findAllByType('script').length, 0);
  assert(artifact.findAllByType('code').some(n => text(n).includes('const a = 1;')));
  await act(async () => view.unmount());
});

test('Markdown preview never submits, formatting preserves drafts, and an inserted source stays in this conversation', async () => {
  const { saved } = environment(); const { ChatPrototype } = load('chat-prototype'); let view;
  await act(async () => { view = create(React.createElement(ChatPrototype, {standalone:true})); });
  const composer = () => view.root.findByProps({ 'aria-label': '原型消息' });
  const before = JSON.parse(saved.get(DEMO_STORAGE)).messages.length;
  await act(async () => composer().props.onChange({ target: { value: '**草稿重点**' } }));
  await act(async () => button(view, '预览 Markdown').props.onClick());
  assert.equal(composer().props.hidden, true);
  assert(view.root.findByProps({ 'aria-label': 'Markdown 草稿预览' }).findByType('strong'));
  assert.equal(JSON.parse(saved.get(DEMO_STORAGE)).messages.length, before);
  await act(async () => button(view, '继续编辑').props.onClick());
  assert.equal(composer().props.value, '**草稿重点**');
  await act(async () => button(view, '插入代码').props.onClick());
  assert(composer().props.value.includes('`文字`'));
  await act(async () => view.update(React.createElement(ChatPrototype, { composeRequest: { id: 1, text: 'https://example.org/source' } })));
  assert(composer().props.value.endsWith('https://example.org/source'));
  assert.equal(JSON.parse(saved.get(DEMO_STORAGE)).messages.length, before);
  await act(async () => view.unmount());
});

test('restoring legacy companion names keeps custom names, model, permissions and private preferences', () => {
  const state = initialDemo(); delete state.companionVersion;
  state.agents[0].name = 'tebb'; state.agents[1].name = '我自己的伙伴'; state.agents[1].memory = '私有偏好';
  state.agents[2].name = '写作者'; delete state.agents[2].avatar;
  const next = restoreDemo(JSON.stringify(state));
  assert.deepEqual(next.agents.map(a => a.name), ['小缇', '我自己的伙伴', '墨墨']);
  assert.equal(next.agents[1].memory, '私有偏好');
  assert.equal(next.agents[2].avatar, 'cat');
  next.agents[2].name = '写作者';
  assert.equal(restoreDemo(JSON.stringify(next)).agents[2].name, '写作者');
});


test('normal App starts in core chat and keeps its draft mounted across settings and source previews', async () => {
  environment(); global.window.addEventListener = () => {}; global.window.removeEventListener = () => {};
  let sideProps, liveProps, mounts = 0, unmounts = 0;
  const Empty = () => null;
  function LiveStub(props) {
    liveProps = props;
    const [value, setValue] = React.useState('');
    React.useEffect(() => { mounts++; return () => unmounts++; }, []);
    return React.createElement('div', null, React.createElement('input', { 'data-core-draft': true, value, onChange: e => setValue(e.target.value) }), props.navigation);
  }
  const defaultModule = new Proxy({}, { get(_o, key) { return key === '__esModule' ? true : Empty; } });
  const modules = {
    './companion-ui': load('companion-ui'),
    './workspace-shell': load('workspace-shell'),
    './page-stack': load('page-stack'),
    './live-collaboration': { LiveCollaboration: LiveStub },
    './debug': { debugPane: () => null, debugRequested: () => false, installDeskDebug() {} },
    './settings': { readStoredBackground: () => ({ url: '', error: '' }), SettingsPane: Empty },
    './release': { useReleaseIntro: () => ({ open: false }), ReleaseSettings: Empty },
    './memory': { splitIndex: () => -1, modelVerbatim: () => [], MemoryPane: Empty },
    './sampling': { DEFAULT_SAMPLING: { effort: '', temperature: 1, top_p: 1 } },
    './slash-menu': { slashQuery: () => null, filterSlash: items => items, SLASH_PARENTS: [], NEED_REPO: new Set() },
    './api': { backendInfo: () => new Promise(() => {}) },
    './side-workspace': { SideWorkspace: props => { sideProps = props; return React.createElement('div', null, props.children); } },
    './startup': { startupStatus() {}, startupReady() {}, startupFailed() {} },
    'reend-components': { Button: props => React.createElement('button', props), GlitchText: props => React.createElement('span', null, props.children) },
    'framer-motion': { AnimatePresence: props => props.children, motion: { section: props => React.createElement('section', null, props.children) } },
    '@tauri-apps/api/core': { isTauri: () => false },
    '@tauri-apps/api/event': {},
  };
  const filename = path.resolve(__dirname, '../src/client/App.tsx');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod); mod.require = id => modules[id] || (id.endsWith('.css') ? {} : id.startsWith('./') ? defaultModule : original(id));
  mod._compile(compiled, filename); let view;
  await act(async () => { view = create(React.createElement(mod.exports.App)); });
  const root = () => view.root.findAllByType('div').find(n => n.props['data-pane']);
  assert.equal(root().props['data-pane'], 'collaboration'); assert.equal(mounts, 1);
  const draft = () => view.root.findByProps({ 'data-core-draft': true });
  await act(async () => draft().props.onChange({ target: { value: '跨页保留的草稿' } }));
  await act(async () => sideProps.onRequest());
  assert.equal(root().props['data-pane'], 'collaboration');
  await act(async () => sideProps.onLink('https://example.org/source'));
  assert.equal(liveProps.composeRequest.text, 'https://example.org/source');
  await act(async () => sideProps.onTerminalDraft('可引用的终端输出'));
  assert.equal(liveProps.composeRequest.text, '可引用的终端输出');
  assert.equal(root().props['data-pane'], 'collaboration');
  await act(async () => button(view, '设置').props.onClick());
  assert.equal(root().props['data-pane'], 'settings');
  const slot = view.root.findByProps({'data-content-slot': true});
  const route = () => view.root.findByProps({className: 'tebb-route-page'});
  assert.equal(route().props.hidden, false); assert.equal(route().findAllByType('section').length, 1);
  assert.equal(route().findByType('section').props.initial, undefined);
  assert.equal(draft().props.value, '跨页保留的草稿'); assert.equal(unmounts, 0);
  const rail = view.root.findByProps({'aria-label':'工作区快捷栏'});
  await act(async () => rail.findAllByType('button').find(n => n.props['aria-label'] === '伙伴聊天').props.onClick());
  assert.equal(root().props['data-pane'], 'collaboration'); assert.equal(draft().props.value, '跨页保留的草稿');
  assert.equal(mounts, 1);
  assert.equal(view.root.findByProps({'data-content-slot': true}), slot);
  assert.equal(route().props.hidden, true); assert.equal(route().findAllByType('section').length, 1);
  assert.equal(view.root.findByProps({'data-page-panel': 'settings'}).props.hidden, true);
  await act(async () => view.unmount()); assert.equal(unmounts, 1);
});


test('@ member picker supports filtering, keyboard selection, multiple mentions and IME without submitting', async () => {
  const { saved } = environment(); const { ChatPrototype } = load('chat-prototype'); let view;
  await act(async()=>{view=create(React.createElement(ChatPrototype,{standalone:true}));});
  const composer=()=>view.root.findByProps({'aria-label':'原型消息'});
  const before=JSON.parse(saved.get(DEMO_STORAGE)).messages.length;
  await act(async()=>composer().props.onChange({target:{value:'@',selectionStart:1}}));
  assert.equal(view.root.findAllByProps({role:'option'}).length,3);
  await act(async()=>composer().props.onKeyDown({key:'ArrowDown',nativeEvent:{},preventDefault(){}}));
  await act(async()=>composer().props.onKeyDown({key:'Enter',nativeEvent:{},preventDefault(){}}));
  assert.equal(composer().props.value,'@阿探 ');
  assert.equal(JSON.parse(saved.get(DEMO_STORAGE)).messages.length,before);
  await act(async()=>composer().props.onChange({target:{value:'@阿探 @墨',selectionStart:7}}));
  assert.equal(view.root.findAllByProps({role:'option'}).length,1);
  await act(async()=>composer().props.onKeyDown({key:'Enter',nativeEvent:{isComposing:true},preventDefault(){throw Error('IME must stay active');}}));
  assert.equal(composer().props.value,'@阿探 @墨');
  await act(async()=>composer().props.onKeyDown({key:'Enter',nativeEvent:{},preventDefault(){}}));
  assert.equal(composer().props.value,'@阿探 @墨墨 ');
  assert.equal(JSON.parse(saved.get(DEMO_STORAGE)).messages.length,before);
  await act(async()=>view.unmount());
});

test('unified send carries chosen skill, model and scoped attachments without leaking them to another conversation', async () => {
  environment();const {ChatPrototype}=load('chat-prototype');const state=initialDemo();state.messages=[];
  state.skills=[{id:'code-review',description:'review code'}];state.models=[{id:'model-one',model:'test-model'}];
  const files=[{id:'file-one',name:'source.md',kind:'file',path:'E:/fixture/source.md',chars:20}];
  const actions=[];const live={state,busy:false,error:'',act:async action=>{actions.push(action);return true;}};let view;
  await act(async()=>{view=create(React.createElement(ChatPrototype,{live,attachments:files,onDetach(){}}));});
  const composer=()=>view.root.findByProps({'aria-label':'协作消息'});
  await act(async()=>composer().props.onChange({target:{value:'/code',selectionStart:5}}));
  await act(async()=>view.root.findByProps({role:'option'}).props.onClick());
  await act(async()=>view.root.findByProps({'aria-label':'本轮模型'}).props.onChange({target:{value:'model-one'}}));
  await act(async()=>composer().props.onChange({target:{value:'检查这个文件',selectionStart:6}}));
  assert.equal(view.root.findAllByProps({'aria-label':'消息类型'}).length,0);
  await act(async()=>view.update(React.createElement(ChatPrototype,{live:{...live,state:{...state,selected:'dm-research'}},attachments:files,onDetach(){}})));
  await act(async()=>composer().props.onChange({target:{value:'另一个会话',selectionStart:5}}));
  await act(async()=>view.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.deepEqual(actions[0].attachments,[]);assert.deepEqual(actions[0].skills,[]);assert.equal(actions[0].mode,'auto');
  await act(async()=>view.update(React.createElement(ChatPrototype,{live,attachments:files,onDetach(){}})));
  await act(async()=>view.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.deepEqual(actions[1].attachments,['file-one']);assert.deepEqual(actions[1].skills,['code-review']);assert.equal(actions[1].model_id,'model-one');
  await act(async()=>view.unmount());
});
