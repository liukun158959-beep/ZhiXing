"""Folder identity and reviewable history classification, without model inference."""
import hashlib
import json
import os
import sqlite3
from contextlib import closing
from pathlib import Path

from . import project_workspace as workspace


def identity(path):
    return os.path.normcase(str(Path(path).resolve()))


def matching(state, primary):
    key = identity(primary)
    return next((p for p in state['projects'] if (cfg := workspace.load(p['id'])).get('primary') and identity(cfg['primary']) == key), None)


def attach(state, primary, make_id, bind_id=''):
    main = str(workspace.clean_root(primary))
    existing = matching(state, main)
    if existing:
        if bind_id and bind_id != existing['id']: raise ValueError('该文件夹已属于另一个项目，请直接打开已有项目')
        return existing
    project = next((p for p in state['projects'] if p['id']==bind_id), None)
    if bind_id and not project: raise ValueError('待绑定项目不存在')
    if not project:
        name = Path(main).name[:40]
        used = {p['name'].casefold() for p in state['projects']}
        number = 2
        while name.casefold() in used:
            name = Path(main).name[:32] + f' ({number})'; number += 1
        project = dict(id=make_id(), name=name)
    old = workspace.load(project['id'])
    if old.get('primary') and identity(old['primary']) != identity(main): raise ValueError('请在项目目录设置中重新定位文件夹')
    workspace.save(main, project_id=project['id'])
    if project not in state['projects']: state['projects'].append(project)
    return project


def preview(state):
    rows = []
    for chat in state['conversations']:
        runs = [r for r in state['runs'] if r['conversation']==chat['id']]
        paths = sorted({identity(r['workspace']['primary']) for r in runs if r.get('workspace',{}).get('primary')})
        busy = any(r['state'] in {'pending','queued','running','waiting','cancelling'} for r in runs)
        target = matching(state, paths[0]) if len(paths)==1 else None
        status = 'busy' if busy else 'none' if not paths else 'multiple' if len(paths)>1 else 'matched'
        if status == 'matched':
            try: workspace.clean_root(paths[0])
            except (ValueError,OSError): status = 'missing'
        if status == 'matched' and target and chat.get('project_id')==target['id']: status = 'assigned'
        rows.append(dict(id=chat['id'], title=chat['title'], paths=paths, status=status, project_id=(target or {}).get('id',''), project_name=(target or {}).get('name', Path(paths[0]).name if len(paths)==1 else '')))
    token = hashlib.sha256(json.dumps(rows,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    return dict(ok=True, token=token, rows=rows)


def migrate(state, ids, token, make_id):
    current = preview(state)
    if not isinstance(token,str) or token != current['token']: raise ValueError('归类依据已变化，请重新预览后确认')
    if not isinstance(ids,list) or not ids or len(ids)>500 or not all(isinstance(i,str) for i in ids) or len(set(ids))!=len(ids): raise ValueError('请选择1至500条待归类对话')
    selected = [r for r in current['rows'] if r['id'] in ids]
    if len(selected)!=len(ids) or any(r['status']!='matched' for r in selected): raise ValueError('仅可迁移路径明确且没有运行任务的对话')
    for row in selected: workspace.clean_root(row['paths'][0])
    for row in selected:
        project = attach(state,row['paths'][0],make_id)
        next(c for c in state['conversations'] if c['id']==row['id'])['project_id'] = project['id']
    return len(selected)


def search_chats(path, project_id, current_run, query):
    if not isinstance(query,str) or not query.strip() or len(query)>120: raise ValueError('请提供1至120字的检索关键词')
    with closing(sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro',uri=True)) as db:
        state=json.loads(db.execute('SELECT data FROM workspace WHERE id=1').fetchone()[0])
    if not project_id or not any(p['id']==project_id for p in state['projects']): raise ValueError('当前项目不可用')
    current=next((r.get('conversation') for r in state['runs'] if r['id']==current_run),'')
    chats={c['id']:c for c in state['conversations'] if c.get('project_id')==project_id and c['id']!=current}
    terms=query.strip().casefold().split()
    rows=[]
    for message in reversed(state['messages']):
        chat=chats.get(message['conversation'])
        if not chat or message.get('kind')=='notice' or not message.get('text'): continue
        content=message['text'];hay=(chat['title']+'\n'+content).casefold()
        if not all(t in hay for t in terms): continue
        start=max(0,content.casefold().find(terms[0])-160)
        rows.append(dict(conversation=chat['id'],title=chat['title'],sender=message['sender'],text=content[start:start+800],truncated=start>0 or len(content)>start+800))
        if len(rows)>=6: break
    return dict(matches=rows,note='仅为本项目其他聊天的记录片段，不代表已核实事实；引用时注明会话来源。')
