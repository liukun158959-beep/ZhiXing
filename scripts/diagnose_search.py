"""Search availability probe; explicit direct mode affects this process only."""
import argparse
from datetime import datetime,timezone
import json
from pathlib import Path
import sys
import time
import urllib.request
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from desk_companion.model_catalog import require_active
from desk_companion.paths import data_root
from desk_companion.web_search import _post_once,format_search,search_endpoint,search_sources,SearchFailure


def main():
    parser=argparse.ArgumentParser(description='真实搜索可用性诊断：不调用LLM，不改全局代理，不打印密钥。返回来源不代表内容准确。')
    parser.add_argument('--route',choices=['system','direct','pipeline'],default='system',help='system/direct单次主接口；pipeline为实际重试与备用搜索链路')
    parser.add_argument('--query',action='append',help='每条最多200字符，最多5条')
    parser.add_argument('--samples',type=int,choices=range(1,6),default=2)
    parser.add_argument('--timeout',type=int,choices=range(1,31),default=30,help='仅作用于system/direct单次请求')
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    queries=args.query or ['Python 3.11 asyncio TaskGroup official documentation']
    if len(queries)>5 or any(not q.strip() or len(q)>200 for q in queries):parser.error('查询数量或长度超出限制')
    model=require_active();endpoint=search_endpoint(model['base_url'])
    output=args.output or data_root()/'memory/diagnostics'/('search-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json')
    output.parent.mkdir(parents=True,exist_ok=True)
    results=[]
    for query in queries:
        for sample in range(1,args.samples+1):
            start=time.monotonic();row=dict(query=query,sample=sample,route=args.route,started_at=datetime.now(timezone.utc).isoformat())
            try:
                if args.route=='pipeline':payload=search_sources(endpoint,model['api_key'],query)
                elif args.route=='direct':
                    # Scoped patch in this standalone single-threaded process.
                    direct=urllib.request.build_opener(urllib.request.ProxyHandler({}))
                    with patch.object(urllib.request,'urlopen',direct.open):payload=_post_once(endpoint,model['api_key'],query,args.timeout)
                else:payload=_post_once(endpoint,model['api_key'],query,args.timeout)
                format_search(payload)
                row.update(ok=True,provider=payload.get('provider','model-api'),results=len(payload['results']),
                    attempts=payload.get('attempts',[]),primary_failure=payload.get('primary_failure'),
                    sample_urls=[r.get('link') for r in payload['results'][:3]])
            except Exception as exc:
                row.update(ok=False,error=type(exc).__name__,message=str(exc).replace(model['api_key'],'[密钥已隐藏]')[:400])
                if isinstance(exc,SearchFailure):row['diagnostic']=exc.diagnostic()
            row['elapsed_ms']=int((time.monotonic()-start)*1000);results.append(row)
            output.write_text(json.dumps(dict(route=args.route,results=results),ensure_ascii=False,indent=2),'utf-8')
            print(json.dumps(row,ensure_ascii=False),flush=True)
    print(json.dumps(dict(output=str(output),succeeded=sum(r['ok'] for r in results),total=len(results))),flush=True)


if __name__=='__main__':main()
