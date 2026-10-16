const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { act, create } = require('react-test-renderer');

function mount(rpc) {
  const filename = path.resolve(__dirname, '../src/client/feishu-agent.tsx');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = (id) => id === './page-stack' ? { usePageActive: () => true } : id === './api' ? { rpc } : id === '@tauri-apps/api/core' ? { isTauri: () => false } : original(id);
  mod._compile(compiled, filename);
  global.window = { setInterval: () => 1, clearInterval() {} };
  let renderer;
  act(() => { renderer = create(React.createElement(mod.exports.FeishuAgentPane, { info: { port: 1, token: 'test' } })); });
  return { renderer, button: (label) => renderer.root.findAllByType('button').find((node) => node.children.join('') === label) };
}
const idle = { ok: true, enabled: false, connected: false, state: 'stopped', error: '', diagnostic: '', last_reply: '', binding: {} };

test('retrying identity exposes schedule and diagnostics without declaring connected', async () => {
  const app = mount(async (_info, method) => method === 'load_feishu_agent' ? {
    ...idle, enabled: true, state: 'reconnecting', connection_attempts: 2, next_retry_at: 1791500000,
    connection_events: [{ at: 1791499998, stage: 'reconnecting', kind: 'network', message: '暂时校验失败', retry_in: 2 }],
  } : { profiles: [] });
  await act(async () => {});
  const output = JSON.stringify(app.renderer.toJSON());
  assert.ok(output.includes('下次重试'));
  assert.ok(output.includes('连接诊断'));
  assert.ok(output.includes('暂时校验失败'));
  assert.equal(app.button('接入飞书').props.disabled, true);
  assert.equal(app.button('停止接入').props.disabled, false);
  app.renderer.unmount();
});

test('Feishu page starts and stops bot connection through the shared API', async () => {
  const calls = [];
  const app = mount(async (_info, method) => {
    calls.push(method);
    return method === 'start_feishu_agent' ? { ...idle, enabled: true, connected: true, state: 'connected',
      binding: { app_id: 'test-app', app_name: '测试应用', owner_name: '测试用户' } } : idle;
  });
  await act(async () => {});
  await act(async () => app.button('接入飞书').props.onClick());
  assert.equal(app.button('接入飞书').props.disabled, true);
  assert.equal(app.button('停止接入').props.disabled, false);
  assert.ok(JSON.stringify(app.renderer.toJSON()).includes('测试用户'));
  await act(async () => app.button('停止接入').props.onClick());
  assert.deepEqual(calls, ['load_feishu_agent', 'list_feishu_agent_profiles', 'start_feishu_agent', 'stop_feishu_agent']);
  assert.equal(app.button('接入飞书').props.disabled, false);
  app.renderer.unmount();
});

const profile = { name: 'original', appId: 'cli_test', brand: 'feishu', effective: true, user: '本人' };
const settings = { profile: 'original', auto_start: true, auto_reconnect: true, retry_min: 2, retry_max: 30 };
test('edited connection settings persist, and unsaved changes prevent connecting', async () => {
  const calls = [];
  const app = mount(async (_info, method, args) => {
    calls.push([method, args]);
    if (method === 'list_feishu_agent_profiles') return { profiles: [profile] };
    if (method === 'save_feishu_agent_settings') return { ...idle, settings: args };
    return { ...idle, settings };
  });
  await act(async () => {});
  const interval = app.renderer.root.findByProps({ 'aria-label': '初始重连间隔' });
  await act(async () => interval.props.onChange({ target: { value: '5' } }));
  assert.equal(app.button('接入飞书').props.disabled, true);
  await act(async () => app.button('保存连接设置').props.onClick());
  assert.equal(calls.find(([name]) => name === 'save_feishu_agent_settings')[1].retry_min, 5);
  assert.equal(app.button('接入飞书').props.disabled, false);
  app.renderer.unmount();
});
test('updating credentials clears the password even on failure and occupancy check reports errors', async () => {
  const app = mount(async (_info, method, args) => {
    if (method === 'list_feishu_agent_profiles') return { profiles: [profile] };
    if (method === 'update_feishu_agent_credentials') {
      assert.equal(args.app_secret, 'test-only-secret');
      throw new Error('更新失败');
    }
    if (method === 'check_feishu_agent_connection') return { ok: false, error: '本机 App Secret 无效' };
    return { ...idle, settings };
  });
  await act(async () => {});
  const password = () => app.renderer.root.findByProps({ 'aria-label': 'App Secret' });
  assert.equal(password().props.type, 'password');
  await act(async () => password().props.onChange({ target: { value: 'test-only-secret' } }));
  await act(async () => app.button('更新应用密钥').props.onClick());
  assert.equal(password().props.value, '');
  assert.ok(JSON.stringify(app.renderer.toJSON()).includes('更新失败'));
  await act(async () => app.button('检查连接占用').props.onClick());
  assert.ok(JSON.stringify(app.renderer.toJSON()).includes('本机 App Secret 无效'));
  app.renderer.unmount();
});
test('remote connection blocker stays visible with retry and stop actions', async () => {
  const app = mount(async () => ({ ...idle, enabled: true, state: 'error', error: '这个应用已有其他服务的长连接。' }));
  await act(async () => {});
  assert.ok(JSON.stringify(app.renderer.toJSON()).includes('其他服务的长连接'));
  assert.equal(app.button('重新接入').props.disabled, false);
  assert.equal(app.button('停止接入').props.disabled, false);
  app.renderer.unmount();
});
test('a failed binding or RPC remains actionable and never declares connected', async () => {
  const app = mount(async (_info, method) => {
    if (method === 'start_feishu_agent') throw new Error('机器人身份不可用');
    return idle;
  });
  await act(async () => {});
  await act(async () => app.button('接入飞书').props.onClick());
  assert.ok(JSON.stringify(app.renderer.toJSON()).includes('机器人身份不可用'));
  assert.equal(app.button('接入飞书').props.disabled, false);
  assert.equal(app.button('停止接入').props.disabled, true);
  app.renderer.unmount();
});
