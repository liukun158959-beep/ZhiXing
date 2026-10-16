const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const ts = require('typescript'), React = require('react');
const { act, create } = require('react-test-renderer');
function load(name, mocks={}) {
  const filename=path.resolve(__dirname,'../src/client',name+'.tsx');
  const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));
  const original=mod.require.bind(mod);mod.require=id=>mocks[id]||original(id);
  mod._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,filename);return mod.exports;
}
const text=n=>typeof n==='string'?n:(n.children||[]).map(text).join('');

test('visited pages preserve inputs, and their activity context pauses while hidden',async()=>{
  const {PageStack,usePageActive}=load('page-stack');let mounts=0;
  function Page(){const [draft,setDraft]=React.useState('');const active=usePageActive();React.useEffect(()=>{mounts++;},[]);return React.createElement('input',{value:draft,'data-active':active,onChange:e=>setDraft(e.target.value)});}
  let view;await act(async()=>{view=create(React.createElement(PageStack,{active:'one'},React.createElement(Page)));});
  const input=view.root.findByType('input');await act(async()=>input.props.onChange({target:{value:'保留输入'}}));
  await act(async()=>view.update(React.createElement(PageStack,{active:'two'},React.createElement('p',null,'第二页'))));
  assert.equal(input.props['data-active'],false);assert.equal(input.props.value,'保留输入');
  await act(async()=>view.update(React.createElement(PageStack,{active:'one'},React.createElement(Page))));
  assert.equal(input.props['data-active'],true);assert.equal(input.props.value,'保留输入');assert.equal(mounts,1);
  await act(async()=>view.unmount());
});

test('streaming animates only appended text, then switches to Markdown without a timer clearing content',()=>{
  const {StreamText}=load('stream-text',{'./Markdown':{Markdown:({text})=>React.createElement('article',null,text)}});let view;
  act(()=>{view=create(React.createElement(StreamText,{text:'第一段',active:true}));});
  act(()=>view.update(React.createElement(StreamText,{text:'第一段，新增',active:true})));
  assert.equal(text(view.root.findByProps({className:'tebb-stream-new'})),'，新增');
  act(()=>view.update(React.createElement(StreamText,{text:'第一段，新增',active:false})));
  assert.equal(text(view.root.findByType('article')),'第一段，新增');act(()=>view.unmount());
});

test('floating chat shares real conversation, scopes drafts, handles IME and closes without cancelling',async()=>{
  const windowBus=new EventTarget();windowBus.innerWidth=340;windowBus.innerHeight=420;windowBus.setInterval=()=>1;windowBus.clearInterval=()=>{};global.window=windowBus;
  let callback;const invoked=[],calls=[];
  const state={revision:1,selected:'a',agents:[{id:'tebb',name:'小光'}],conversations:[{id:'a',title:'会话A'},{id:'b',title:'会话B'}],messages:[],runs:[],models:[]};
  const {PetChat}=load('pet-chat',{
    './api':{rpc:async(_i,method,args)=>{calls.push({method,args});return method==='load_task_progress'?{enabled:true}: {state};}},
    './chat-prototype-state':{runActive:r=>r.state==='running',RUN_LABELS:{running:'执行中'}},
    './stream-text':{StreamText:({text})=>React.createElement('p',null,text)},'./companion-ui':{AppIcon:()=>null},
    '@tauri-apps/api/core':{isTauri:()=>true,invoke:async(name,args)=>invoked.push({name,args})},
    '@tauri-apps/api/event':{listen:async(_name,cb)=>{callback=cb;return()=>{};}}
  });let view;await act(async()=>{view=create(React.createElement(PetChat,{backend:{port:1,token:'test'}}));});
  const input=()=>view.root.findByProps({'aria-label':'浮动聊天消息'});const choice=()=>view.root.findByProps({'aria-label':'当前会话'});
  await act(async()=>input().props.onChange({target:{value:'@小光 请帮我验证'}}));
  await act(async()=>input().props.onKeyDown({key:'Enter',nativeEvent:{isComposing:true},preventDefault(){throw Error('IME must not submit');}}));
  assert.equal(calls.filter(c=>c.method==='collaboration_action').length,0);
  await act(async()=>choice().props.onChange({target:{value:'b'}}));assert.equal(input().props.value,'');
  await act(async()=>choice().props.onChange({target:{value:'a'}}));assert.equal(input().props.value,'@小光 请帮我验证');
  await act(async()=>view.root.findByProps({'aria-label':'关闭对话框'}).props.onClick());
  assert.deepEqual(invoked.at(-1),{name:'set_pet_chat_visible',args:{visible:false}});
  await act(async()=>callback({payload:false}));await act(async()=>callback({payload:true}));
  assert.equal(input().props.value,'@小光 请帮我验证');
  await act(async()=>view.root.findByType('form').props.onSubmit({preventDefault(){}}));
  const sent=calls.find(c=>c.method==='collaboration_action').args.action;assert.equal(sent.conversation,'a');assert.equal(sent.mode,'auto');assert(sent.request_id);
  assert(!calls.some(c=>c.args?.action?.type==='cancel'));assert.equal(input().props.value,'');await act(async()=>view.unmount());
});
