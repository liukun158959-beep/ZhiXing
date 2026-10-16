const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');
const text = node => typeof node === 'string' ? node : (node.children || []).map(text).join('');
const button = (view,label) => view.root.findAllByType('button').find(b => text(b)===label || b.props['aria-label']===label);
function load(rpc) {
 const filename = path.resolve(__dirname,'../src/client/project-panel.tsx');
 const code = ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const mod = new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));const original=mod.require.bind(mod);
 mod.require=id=>id==='./api'?{rpc}:id==='./Markdown'?{Markdown:({text})=>React.createElement('article',{'data-markdown':''},text)}:original(id);
 mod._compile(code,filename);return mod.exports;
}
const config={revision:'workspace-one',primary:'E:/fixture',references:['E:/reference'],edit:true,commands:true};
function backend() {
 const files={'a.py':{text:'value = 1\n',revision:'hash-one'},'b.md':{text:'# B',revision:'b-one'}};
 const calls=[];let conflict=false;
 const rpc=async(_info,_method,args)=>{
  calls.push(args);
  if(args.operation==='load')return {ok:true,workspace:config};
  if(args.operation==='tree')return {ok:true,entries:Object.keys(files).map(name=>({name,path:name,directory:false,size:10}))};
  if(args.operation==='read')return {ok:true,...files[args.relative],root:args.root_id,path:args.relative,name:args.relative,kind:'text',editable:args.root_id==='main',workspace_revision:config.revision};
  if(args.operation==='write'){
   if(conflict){files['a.py']={text:'value = 5\n',revision:'external-hash'};throw Error('文件已被其他操作修改');}
   assert.equal(args.workspace_revision,config.revision);files[args.relative]={text:args.text,revision:'hash-saved'};return {ok:true,revision:'hash-saved',diff:'-value = 1\n+value = 2'};
  }
  throw Error('Unexpected operation');
 };
 return {rpc,calls,files,setConflict:value=>conflict=value};
}
const info={port:1,token:'fixture'};

test('dirty drafts survive file switches and save conflicts; reload preserves edits for merging',async()=>{
 const api=backend();const {ProjectPanel}=load(api.rpc);let view;let dirty=false;
 await act(async()=>{view=create(React.createElement(ProjectPanel,{info,onQuote(){},onDirty:value=>dirty=value}));});
 await act(async()=>button(view,'· a.py').props.onClick());
 await act(async()=>button(view,'编辑').props.onClick());
 await act(async()=>view.root.findByProps({'aria-label':'文件编辑内容'}).props.onChange({target:{value:'value = 2\n'}}));
 assert.equal(dirty,true);
 await act(async()=>button(view,'· b.md').props.onClick());
 assert.equal(view.root.findByProps({'data-markdown':''}).children[0],'# B');
 await act(async()=>button(view,'a.py *').props.onClick());
 await act(async()=>button(view,'编辑').props.onClick());
 assert.equal(view.root.findByProps({'aria-label':'文件编辑内容'}).props.value,'value = 2\n');
 api.setConflict(true);await act(async()=>button(view,'保存').props.onClick());
 assert(text(view.toJSON()).includes('文件已被其他操作修改'));
 assert.equal(view.root.findByProps({'aria-label':'文件编辑内容'}).props.value,'value = 2\n');
 await act(async()=>button(view,'读取最新版本').props.onClick());
 assert(text(view.toJSON()).includes('编辑草稿保留'));
 api.setConflict(false);await act(async()=>button(view,'保存').props.onClick());
 assert.equal(api.calls.filter(c=>c.operation==='write').at(-1).revision,'external-hash');
 assert.equal(api.files['a.py'].text,'value = 2\n');assert.equal(dirty,false);
 await act(async()=>view.unmount());
});

test('reference files stay readonly and quoting only adds a draft',async()=>{
 const api=backend(),quoted=[];const {ProjectPanel}=load(api.rpc);let view;
 await act(async()=>{view=create(React.createElement(ProjectPanel,{info,onQuote:text=>quoted.push(text)}));});
 await act(async()=>view.root.findByProps({'aria-label':'文件根目录'}).props.onChange({target:{value:'ref-0'}}));
 await act(async()=>button(view,'· b.md').props.onClick());
 assert.equal(button(view,'编辑'),undefined);assert.equal(button(view,'保存'),undefined);
 await act(async()=>button(view,'引用文件到草稿').props.onClick());
 assert.equal(quoted[0],'文件：ref-0/b.md\n\n# B');assert(!api.calls.some(c=>c.operation==='write'));
 await act(async()=>view.unmount());
});

test('late file responses cannot replace the selected preview',async()=>{
 const api=backend();let finish;
 const rpc=async(i,m,args)=>args.operation==='read'&&args.relative==='a.py'?new Promise(resolve=>finish=resolve):api.rpc(i,m,args);
 const {ProjectPanel}=load(rpc);let view;
 await act(async()=>{view=create(React.createElement(ProjectPanel,{info,onQuote(){}}));});
 act(()=>{button(view,'· a.py').props.onClick();});
 await act(async()=>button(view,'· b.md').props.onClick());
 await act(async()=>finish({ok:true,root:'main',path:'a.py',name:'a.py',kind:'text',text:'late',revision:'old',workspace_revision:config.revision,editable:true}));
 assert.equal(view.root.findByProps({'data-markdown':''}).children[0],'# B');assert(!text(view.toJSON()).includes('late'));
 await act(async()=>view.unmount());
});

test('browser capabilities cannot invoke local file RPC and code preview never executes HTML',async()=>{
 let called=0;const {ProjectPanel,CodePreview}=load(async()=>{called++;throw Error('must not call');});let view;
 await act(async()=>{view=create(React.createElement(ProjectPanel,{info:{...info,scope:'collaboration'},onQuote(){}}));});
 assert.equal(called,0);assert(text(view.toJSON()).includes('请在桌面客户端'));
 await act(async()=>view.unmount());
 await act(async()=>{view=create(React.createElement(CodePreview,{text:'<script>alert(1)</script>\nconst value = "safe";'}));});
 assert.equal(view.root.findAllByType('script').length,0);assert(text(view.toJSON()).includes('<script>'));
 await act(async()=>view.unmount());
});


test('opening a folder saves it immediately, clears old grants, and cancel preserves current config',async()=>{
 const events=[];global.window={dispatchEvent:event=>events.push(event)};global.CustomEvent=class {constructor(type,options){this.type=type;this.detail=options.detail;}};
 let current={...config};let selected=['E:/new-project'];const calls=[];
 const api=backend();const rpc=async(i,m,args)=>{
  calls.push(args);
  if(args.operation==='load')return {ok:true,workspace:current};
  if(args.operation==='pick')return {ok:true,paths:selected};
  if(args.operation==='save'){current={...args,revision:'new-revision'};return {ok:true,workspace:current};}
  return api.rpc(i,m,args);
 };
 const {ProjectPanel}=load(rpc);let view;
 await act(async()=>{view=create(React.createElement(ProjectPanel,{info,folderRequest:1,onQuote(){}}));});
 assert.equal(current.primary,'E:/new-project');assert.equal(current.edit,false);assert.equal(current.commands,false);assert.deepEqual(current.references,[]);
 assert.equal(calls.filter(c=>c.operation==='pick').length,1);assert.equal(events.length,1);
 assert(text(view.toJSON()).includes('只读浏览'));assert(text(view.toJSON()).includes('文件夹已打开'));
 const checks=view.root.findAllByType('input').filter(node=>node.props.type==='checkbox');
 await act(async()=>checks[0].props.onChange({target:{checked:true}}));
 await act(async()=>view.root.findAllByType('input').filter(node=>node.props.type==='checkbox')[1].props.onChange({target:{checked:true}}));
 await act(async()=>view.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(current.edit,true);assert.equal(current.commands,true);
 selected=[];
 await act(async()=>button(view,'切换文件夹').props.onClick());
 assert.equal(calls.filter(c=>c.operation==='save').length,2);assert.equal(current.primary,'E:/new-project');
 await act(async()=>view.unmount());
});

test('empty workspace offers folder picker and dirty files prevent changing directories',async()=>{
 const empty={revision:'',primary:'',references:[],edit:false,commands:false};let pickCount=0;
 const {ProjectPanel}=load(async(_i,_m,args)=>{if(args.operation==='load')return {ok:true,workspace:empty};if(args.operation==='pick'){pickCount++;return {ok:true,paths:[]};}throw Error('unexpected');});let view;
 await act(async()=>{view=create(React.createElement(ProjectPanel,{info,onQuote(){}}));});
 assert(text(view.toJSON()).includes('像 VS Code'));assert.equal(view.root.findAllByProps({'aria-label':'文件根目录'}).length,0);
 await act(async()=>button(view,'选择并打开文件夹').props.onClick());assert.equal(pickCount,1);
 await act(async()=>view.unmount());
 const api=backend();const Panel=load(api.rpc).ProjectPanel;
 await act(async()=>{view=create(React.createElement(Panel,{info,onQuote(){}}));});
 await act(async()=>button(view,'· a.py').props.onClick());await act(async()=>button(view,'编辑').props.onClick());
 await act(async()=>view.root.findByProps({'aria-label':'文件编辑内容'}).props.onChange({target:{value:'unsaved'}}));
 await act(async()=>button(view,'切换文件夹').props.onClick());
 assert(!api.calls.some(c=>c.operation==='pick'));assert(text(view.toJSON()).includes('请先保存或撤销'));
 await act(async()=>view.unmount());
});
