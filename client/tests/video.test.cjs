const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { act, create } = require('react-test-renderer');

function load(rpc, invoke = async () => {}) {
  const filename = path.resolve(__dirname, '../src/client/video.tsx');
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  const connectionRpc = async (info, method, args) => {
    const result = await rpc(info, method, args);
    if (method === 'load_wiki_connection' && !result.settings) return { settings: { wiki_url: '', video_parent_url: '', profile: '', auto_video_save: false } };
    return result;
  };
  mod.require = id => id === './page-stack' ? { usePageActive: () => true } : id === '@tauri-apps/api/core' ? { invoke } : id === './api' ? { rpc: connectionRpc } : id === './Markdown' ? {
    MdLink: props => React.createElement('a', { href: props.href }, props.children),
    Markdown: props => React.createElement('p', null, props.text) } : original(id);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return mod.exports;
}
global.window = { setInterval: () => 1, clearInterval() {} };

test('video login opens dedicated window, explicitly captures login and clears both stores', async () => {
  const calls = [];
  const cookies = [{ domain: '.bilibili.com', name: 'SESSDATA', value: 'private' }];
  const rows = [{ platform: 'Bilibili', state: 'missing' }, { platform: 'YouTube', state: 'missing' }];
  const rpc = async (_, method, args) => {
    calls.push([method, args]);
    if (method === 'load_video_settings') return { settings: { proxy: 'http://127.0.0.1:7890', cookie_file: '' } };
    if (method === 'save_video_login') rows[0].state = 'saved';
    if (method === 'clear_video_login') rows[0].state = 'missing';
    return { items: rows.map(row => ({ ...row })) };
  };
  const invoke = async (command, args) => { calls.push([command, args]); return cookies; };
  const { VideoLogin } = load(rpc, invoke);
  let renderer;
  const url = 'https://www.bilibili.com/video/BV1ojfDBSEPv';
  await act(async () => { renderer = create(React.createElement(VideoLogin, { info: { port: 1 }, url })); });
  const button = title => renderer.root.findAllByType('button').find(node => node.children.join('') === title);
  await act(async () => button('登录 / 扫码').props.onClick());
  assert.deepEqual(calls.at(-1), ['open_video_login', { platform: 'Bilibili', url, proxy: 'http://127.0.0.1:7890', purpose: 'login' }]);
  assert.equal(calls.filter(call => call[0] === 'capture_video_login').length, 0);
  await act(async () => button('查看视频').props.onClick());
  assert.equal(calls.at(-1)[1].purpose, 'video');
  assert.ok(!calls.some(call => call[0] === 'clear_video_login'));
  await act(async () => button('登录 / 扫码').props.onClick());
  assert.equal(calls.at(-1)[1].purpose, 'login');
  assert.ok(!calls.some(call => call[0] === 'clear_video_login_window'));
  await act(async () => button('使用此登录态').props.onClick());
  assert.deepEqual(calls.at(-2), ['capture_video_login', { platform: 'Bilibili' }]);
  assert.deepEqual(calls.at(-1), ['save_video_login', { platform: 'Bilibili', cookies }]);
  assert.ok(JSON.stringify(renderer.toJSON()).includes('已保存登录态'));
  assert.ok(!JSON.stringify(renderer.toJSON()).includes('private'));
  await act(async () => button('清除登录态').props.onClick());
  assert.deepEqual(calls.at(-2), ['clear_video_login_window', { platform: 'Bilibili' }]);
  assert.deepEqual(calls.at(-1), ['clear_video_login', { platform: 'Bilibili' }]);
  act(() => renderer.unmount());
});

test('video login capture errors never save or claim a usable login', async () => {
  const calls = [];
  const rpc = async (_, method) => { calls.push(method); return { items: [] }; };
  const { VideoLogin } = load(rpc, async () => { throw new Error('请先登录'); });
  let renderer;
  await act(async () => { renderer = create(React.createElement(VideoLogin, { info: { port: 1 } })); });
  const button = renderer.root.findAllByType('button').find(node => node.children.join('') === '使用此登录态');
  await act(async () => button.props.onClick());
  assert.ok(JSON.stringify(renderer.toJSON()).includes('请先登录'));
  assert.ok(!calls.includes('save_video_login'));
  act(() => renderer.unmount());
});

test('video settings wait for existing values before save and keep optional network fields', async () => {
  const calls = [];
  const rpc = async (_, method, args) => { calls.push([method, args]); return { settings: { proxy: 'http://127.0.0.1:7890', cookie_file: 'C:/user/cookies.txt' } }; };
  const { VideoSettings } = load(rpc);
  let renderer;
  await act(async () => { renderer = create(React.createElement(VideoSettings, { info: { port: 1 } })); });
  assert.equal(renderer.root.findAllByType('input')[0].props.value, 'http://127.0.0.1:7890');
  await act(async () => renderer.root.findByType('button').props.onClick());
  assert.deepEqual(calls.at(-1), ['save_video_settings', { proxy: 'http://127.0.0.1:7890', cookie_file: 'C:/user/cookies.txt' }]);
  act(() => renderer.unmount());
});

test('video evidence states subtitle limits and saves only completed selected task', async () => {
  const calls = [];
  const source = { source_id: 'a'.repeat(24), title: 'Video', author: 'Author', url: 'https://youtu.be/abcdefghijk',
    platform: 'YouTube', subtitle_notice: '自动字幕可能有误', subtitle_language: 'en', segment_count: 4, chapters: [] };
  const rpc = async (_, method, args) => { calls.push([method, args]); return method === 'list_task_videos' ? { items: [source] } : { url: 'https://example.feishu.cn/docx/note' }; };
  const { TaskVideos } = load(rpc);
  let renderer;
  await act(async () => { renderer = create(React.createElement(TaskVideos, { info: { port: 1 }, taskId: 'task-a', state: 'running' })); });
  assert.ok(JSON.stringify(renderer.toJSON()).includes('自动字幕可能有误'));
  assert.equal(renderer.root.findByType('button').props.disabled, true);
  await act(async () => renderer.update(React.createElement(TaskVideos, { info: { port: 1 }, taskId: 'task-a', state: 'succeeded' })));
  await act(async () => renderer.root.findByType('button').props.onClick());
  assert.deepEqual(calls.at(-1), ['export_task_video', { task_id: 'task-a', source_id: source.source_id }]);
  assert.ok(JSON.stringify(renderer.toJSON()).includes('打开视频笔记'));
  act(() => renderer.unmount());
});

test('dedicated video page submits separate jobs, follows selected context and leaves tasks running on navigation', async () => {
  const calls = [];
  const old = { id: 'old', channel: 'feishu', text: '视频问题', state: 'succeeded', answer: '旧字幕总结',
    created: 1, elapsed: 5, source: {}, events: [] };
  const next = { ...old, id: 'new', channel: 'video', state: 'running', answer: '正在读取', source: { video_url: 'https://youtu.be/abcdefghijk' } };
  let rows = [old];
  const rpc = async (_, method, args) => {
    calls.push([method, args]);
    if (method === 'list_video_tasks') return { items: rows };
    if (method === 'get_agent_task') return { task: args.task_id === 'old' ? old : next };
    if (method === 'list_task_videos') return { items: [] };
    if (method === 'load_video_settings') return { settings: { proxy: '', cookie_file: '' } };
    if (method === 'load_video_login') return { items: [] };
    if (method === 'start_video_task') { rows = [next, old]; return { ok: true, task_id: 'new' }; }
    if (method === 'cancel_agent_task') { next.state = 'cancelled'; return { ok: true, task: next }; }
    if (method === 'continue_video_task') return { ok: true, task_id: 'new' };
    return { ok: true };
  };
  const { VideoPane } = load(rpc);
  let renderer;
  await act(async () => { renderer = create(React.createElement(VideoPane, { info: { port: 1 } })); });
  const button = text => renderer.root.findAllByType('button').find(node => node.children.join('') === text);
  assert.ok(JSON.stringify(renderer.toJSON()).includes('旧字幕总结'));
  assert.equal(calls.find(call => call[0] === 'get_agent_task')[1].focus, false);
  act(() => renderer.root.findByType('textarea').props.onChange({ target: { value: '展开 03:20' } }));
  await act(async () => button('继续追问').props.onClick());
  assert.deepEqual(calls.find(call => call[0] === 'continue_video_task')[1], { task_id: 'old', text: '展开 03:20' });
  assert.equal(button('继续追问').props.disabled, true);
  act(() => renderer.root.findByProps({ id: 'video-url' }).props.onChange({ target: { value: ' https://youtu.be/abcdefghijk ' } }));
  await act(async () => button('读取并分析').props.onClick());
  assert.deepEqual(calls.find(call => call[0] === 'start_video_task')[1], { url: 'https://youtu.be/abcdefghijk' });
  await act(async () => button('停止任务').props.onClick());
  assert.deepEqual(calls.find(call => call[0] === 'cancel_agent_task')[1], { task_id: 'new' });
  const stops = calls.filter(call => call[0] === 'cancel_agent_task').length;
  act(() => renderer.unmount());
  assert.equal(calls.filter(call => call[0] === 'cancel_agent_task').length, stops);
});

test('switching video history ignores late detail from the previously selected task', async () => {
  const a = { id: 'a', channel: 'video', text: 'A', state: 'succeeded', answer: 'A 的答案', created: 1, elapsed: 1, source: {} };
  const b = { ...a, id: 'b', text: 'B', answer: 'B 的答案' };
  let resolveA;
  const pendingA = new Promise(resolve => { resolveA = resolve; });
  const rpc = async (_, method, args) => {
    if (method === 'list_video_tasks') return { items: [a, b] };
    if (method === 'get_agent_task') return args.task_id === 'a' ? pendingA : { task: b };
    if (method === 'load_video_settings') return { settings: { proxy: '', cookie_file: '' } };
    return { items: [] };
  };
  const { VideoPane } = load(rpc);
  let renderer;
  await act(async () => { renderer = create(React.createElement(VideoPane, { info: { port: 1 } })); });
  const row = renderer.root.findAllByType('button').find(node => node.findAllByType('span').some(span => span.children.join('') === 'B'));
  await act(async () => row.props.onClick());
  await act(async () => resolveA({ task: a }));
  const rendered = JSON.stringify(renderer.toJSON());
  assert.ok(rendered.includes('B 的答案'));
  assert.ok(!rendered.includes('A 的答案'));
  act(() => renderer.unmount());
});

test('wiki connection loads persisted destination and saves explicit automatic archive settings', async () => {
  const calls = [];
  const settings = { wiki_url: 'https://example.feishu.cn/wiki/home', video_parent_url: 'https://example.feishu.cn/wiki/video', profile: 'my-app', auto_video_save: true };
  let saved = 0;
  const { WikiConnectionSettings } = load(async (_, method, args) => {
    calls.push([method, args]);
    return { ok: true, settings: method === 'save_wiki_connection' ? args.payload : settings };
  });
  let renderer;
  await act(async () => { renderer = create(React.createElement(WikiConnectionSettings, { info: { port: 1 }, onSaved: () => { saved++; } })); });
  assert.equal(renderer.root.findByProps({ 'aria-label': '视频笔记父文档链接' }).props.value, settings.video_parent_url);
  assert.equal(renderer.root.findByProps({ 'aria-label': '读取完成后自动保存视频笔记' }).props.checked, true);
  act(() => renderer.root.findByProps({ 'aria-label': '读取完成后自动保存视频笔记' }).props.onChange({ target: { checked: false } }));
  await act(async () => renderer.root.findByType('button').props.onClick());
  assert.deepEqual(calls.at(-1), ['save_wiki_connection', { payload: { ...settings, auto_video_save: false } }]);
  assert.equal(saved, 1);
  act(() => renderer.unmount());
});

test('wiki connection waits for load and reports rejected destination without claiming success', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const { WikiConnectionSettings } = load(async (_, method) => method === 'load_wiki_connection' ? pending : { ok: false, error: '视频父文档不属于这个知识库' });
  let renderer;
  await act(async () => { renderer = create(React.createElement(WikiConnectionSettings, { info: { port: 1 } })); });
  assert.equal(renderer.root.findByType('button').props.disabled, true);
  await act(async () => resolve({ settings: { wiki_url: 'https://example.feishu.cn/wiki/root', video_parent_url: '', profile: '', auto_video_save: false } }));
  await act(async () => renderer.root.findByType('button').props.onClick());
  const text = JSON.stringify(renderer.toJSON());
  assert.ok(text.includes('视频父文档不属于这个知识库'));
  assert.ok(!text.includes('知识库已连接'));
  act(() => renderer.unmount());
});

test('automatically saved source exposes link and disables duplicate manual creation', async () => {
  const source = { source_id: 'a'.repeat(24), title: '概念视频', author: '作者', platform: 'Bilibili', url: 'https://www.bilibili.com/video/BV1ojfDBSEPv',
    subtitle_notice: '完整可用字幕', chapters: [], export_state: 'saved', document_url: 'https://example.feishu.cn/wiki/note' };
  const { TaskVideos } = load(async () => ({ items: [source] }));
  let renderer;
  await act(async () => { renderer = create(React.createElement(TaskVideos, { info: { port: 1 }, taskId: 'task', state: 'succeeded' })); });
  assert.equal(renderer.root.findByType('button').props.disabled, true);
  assert.ok(JSON.stringify(renderer.toJSON()).includes('已保存到飞书'));
  assert.ok(renderer.root.findAllByType('a').some(link => link.props.href === source.document_url));
  act(() => renderer.unmount());
});
