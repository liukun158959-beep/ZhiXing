"""Measured timing only: monotonic HTTP spans, task phases, nearest-rank tails."""
import json
import math
import re
import sqlite3
import time
from contextlib import closing

from .paths import data_root

NETWORK_LABELS = {'connect_tcp':'DNS / TCP 连接', 'connect_unix_socket':'本地套接字连接', 'start_tls':'TLS 握手',
                  'send_request_headers':'发送请求头', 'send_request_body':'发送请求体',
                  'receive_response_headers':'等待响应头', 'receive_response_body':'接收响应流'}


class HttpTiming:
    def __init__(self, clock=time.perf_counter):
        self.clock=clock; self.start=clock(); self.open={}; self.spans=[]; self.marks={}

    def trace(self, name, info):
        # Never retain info: it can contain auth headers, proxy URLs or exceptions.
        base, _, event=name.rpartition('.')
        phase=base.rsplit('.',1)[-1]
        if phase not in NETWORK_LABELS: return
        now=self.clock()
        if event=='started': self.open[base]=(phase,now)
        elif event in {'complete','failed'} and base in self.open:
            phase,started=self.open.pop(base)
            self.spans.append(dict(phase=phase,label=NETWORK_LABELS[phase],start_ms=round((started-self.start)*1000,2),
                                   duration_ms=round((now-started)*1000,2),state=event))

    def mark(self, name):
        self.marks.setdefault(name, round((self.clock()-self.start)*1000,2))

    def payload(self):
        now=self.clock()
        pending=[dict(phase=phase,label=NETWORK_LABELS[phase],start_ms=round((start-self.start)*1000,2),
                      duration_ms=round((now-start)*1000,2),state='incomplete') for phase,start in self.open.values()]
        return dict(spans=self.spans+pending,marks=self.marks,total_ms=round((now-self.start)*1000,2))


def percentile(values, fraction):
    values=sorted(v for v in values if isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) and v>=0)
    return round(values[max(0,math.ceil(len(values)*fraction)-1)],2) if values else None


def summarize(samples):
    completed=[s for s in samples if s.get('state') in {'complete','succeeded','failed','timed_out','cancelled','interrupted','recording_failed'}]
    success=[s for s in completed if s['state'] in {'complete','succeeded'}]
    def stats(rows, key):
        values=[s[key] for s in rows if isinstance(s.get(key),(int,float)) and not isinstance(s[key],bool) and math.isfinite(s[key]) and s[key]>=0]
        return dict(n=len(values),p50=percentile(values,.5),p95=percentile(values,.95) if len(values)>=20 else None,
                    p99=percentile(values,.99) if len(values)>=100 else None,max=percentile(values,1))
    return dict(samples=len(samples),completed=len(completed),successes=len(success),failed=len(completed)-len(success),
                timeouts=sum(s.get('state')=='timed_out' or 'Timeout' in s.get('error','') for s in completed),
                failure_rate=round((len(completed)-len(success))/len(completed),4) if completed else None,
                duration_ms=stats(completed,'duration_ms'),first_text_ms=stats(success,'first_text_ms'),
                worker_prepare_ms=stats(completed,'worker_prepare_ms'),
                note='最近已结束请求耗时含失败和超时；首段文字仅统计成功且有测量的请求。P99至少需要100个对应样本，P95至少20个。')


def task_snapshot(task_id):
    if not isinstance(task_id,str) or not re.fullmatch('[a-f0-9]{32}',task_id): return None
    for relative in ('memory/tasks.sqlite3','memory/collaboration/chat/tasks.sqlite3','memory/collaboration/work/tasks.sqlite3'):
        path=data_root()/relative
        if not path.is_file(): continue
        with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=3)) as db:
            db.row_factory=sqlite3.Row
            row=db.execute('SELECT id,state,text,answer,error,created,started,ended FROM tasks WHERE id=?',(task_id,)).fetchone()
            if row:
                return dict(row) | dict(events=[dict(e) | dict(data=json.loads(e['data'])) for e in db.execute(
                    'SELECT seq,kind,data,ts FROM events WHERE task=? ORDER BY seq',(task_id,))])
    return None


def task_timing(task, now=None):
    if not task: return None
    end=task['ended'] or (time.time() if now is None else now)
    created=task['created']; started=task['started'] or end
    stages=[]
    def add(label,begin,finish,kind):
        stages.append(dict(label=label,kind=kind,start_ms=round(max(0,begin-created)*1000,2),duration_ms=round(max(0,finish-begin)*1000,2)))
    add('排队',created,started,'queue')
    cursor=started; current=None; calls=0; began=False
    for event in task.get('events',[]):
        kind,ts=event['kind'],event['ts']
        if kind in {'llm_start','tool_start'}:
            if ts>cursor: add('进程启动 / 上下文准备' if not began else '调度 / 上下文整理',cursor,ts,'prepare' if not began else 'orchestration')
            began=True
            if kind=='llm_start': calls+=1
            data=event.get('data') or {}
            label=f'模型调用 {calls}' if kind=='llm_start' else '工具 · '+str(data.get('tool','未知'))
            current=(label,ts,'model' if kind=='llm_start' else 'tool')
        elif kind in {'llm_end','tool_end'} and current:
            add(current[0],current[1],ts,current[2]);cursor=ts;current=None
    if current: add(current[0]+'（未结束或中断）',current[1],end,current[2])
    elif end>cursor: add('结果落盘 / 任务收尾' if began else '进程启动 / 上下文准备',cursor,end,'finalize' if began else 'prepare')
    longest=max(stages,key=lambda s:s['duration_ms']) if stages else None
    return dict(stages=stages,longest=longest,total_ms=round(max(0,end-created)*1000,2),state=task['state'],
                prewarmed=any(e['kind']=='worker_pool' and e['data'].get('prewarmed') for e in task.get('events',[])))
