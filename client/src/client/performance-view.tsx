export type Stage={label:string;duration_ms:number;start_ms?:number;state?:string;phase?:string;kind?:string};
export type CallTiming={spans:Stage[];marks:Record<string,number>;total_ms:number;network_mode?:string};
export type TaskTiming={stages:Stage[];longest?:Stage;total_ms:number;state:string};
export type PerformanceSummary={samples:number;completed:number;successes:number;failed:number;timeouts:number;failure_rate:number|null;duration_ms:{n:number;p50:number|null;p95:number|null;p99:number|null};first_text_ms:{n:number;p99:number|null};note:string};
export const duration=(ms:number|null|undefined)=>ms==null?'未测得':`${(ms/1000).toFixed(ms>=10000?1:3)} 秒`;

export function httpStages(timing:CallTiming):Stage[]{
  const rows=timing.spans.filter(s=>s.phase!=='receive_response_body');
  const {headers,first_text,body_end}=timing.marks;
  if(headers!=null && first_text!=null)rows.push({label:'响应头后等待首段文字',duration_ms:Math.max(0,first_text-headers),start_ms:headers});
  if(first_text!=null)rows.push({label:'首段文字后的输出与传输',duration_ms:Math.max(0,(body_end??timing.total_ms)-first_text),start_ms:first_text});
  else if(headers!=null)rows.push({label:'等待可见文字（尚未收到）',duration_ms:Math.max(0,(body_end??timing.total_ms)-headers),start_ms:headers,state:'incomplete'});
  return rows.sort((a,b)=>(a.start_ms||0)-(b.start_ms||0));
}
function Stages({rows,label}:{rows:Stage[];label:string}){
  const longest=rows.length?Math.max(...rows.map(r=>r.duration_ms)):0;
  return <table className="w-full text-left text-xs" aria-label={label}><thead><tr className="border-b border-border text-muted-foreground"><th className="p-2">阶段</th><th className="p-2">耗时</th><th className="p-2">相对长度</th></tr></thead><tbody>{rows.map((row,i)=><tr key={i} className={`border-b border-border/40 ${row.duration_ms===longest?'text-primary':''}`}><td className="p-2">{row.label}{row.duration_ms===longest&&' · 最耗时'}{row.state==='incomplete'&&'（未完成）'}</td><td className="whitespace-nowrap p-2 font-mono">{duration(row.duration_ms)}</td><td className="w-1/3 p-2"><div className="h-1.5 rounded bg-primary/10"><div className="h-full rounded bg-primary/60" style={{width:`${longest?row.duration_ms/longest*100:0}%`}}/></div></td></tr>)}</tbody></table>;
}
export function PerformanceView({timing,chain}:{timing?:CallTiming|null;chain?:TaskTiming|null}){
  const rows=timing?httpStages(timing):[];
  return <div className="space-y-6"><p className="text-xs leading-6 text-muted-foreground">根据实际任务事件和网络边界测量。连接耗时合并 DNS 与 TCP；等待响应头和首段文字包含网络、中转及服务端处理，客户端无法继续拆分服务端内部耗时。下方任务与网络属于不同层级，不相加。</p>
    {chain?<section><h2 className="mb-3 text-sm">完整任务链 · {duration(chain.total_ms)}</h2><Stages rows={chain.stages} label="任务各阶段耗时"/></section>:<p className="text-sm text-muted-foreground">未找到关联任务，或这是旧版调用记录。</p>}
    {timing?<section><h2 className="mb-3 text-sm">所选模型请求 · {duration(timing.total_ms)} · {({system:'系统代理',direct:'直连',custom:'自定义代理'} as Record<string,string>)[timing.network_mode||'']||'连接方式未知'}</h2><p className="mb-3 text-xs text-muted-foreground">响应头 {duration(timing.marks.headers)} · 首个响应体 {duration(timing.marks.first_body)} · 首段可见文字 {duration(timing.marks.first_text)}</p><Stages rows={rows} label="模型网络各阶段耗时"/>{!rows.length&&<p className="text-xs">当前传输未提供连接阶段记录。</p>}</section>:<p className="text-sm text-muted-foreground">此记录没有阶段耗时；新调用会自动采集，暂停记录时不采集。</p>}
  </div>;
}
export function PerformanceStats({value}:{value:PerformanceSummary}){
  return <div className="border-b border-border p-3 text-[11px] leading-6 text-muted-foreground" aria-label="模型调用性能统计"><p>最近 {value.completed} 个已结束请求（含失败） · P50 {duration(value.duration_ms.p50)} · P95 {value.duration_ms.p95==null?'样本不足20':duration(value.duration_ms.p95)} · P99 {value.duration_ms.p99==null?'样本不足100':duration(value.duration_ms.p99)}</p><p>失败 {value.failed} · 超时 {value.timeouts} · 失败率 {value.failure_rate==null?'未测得':`${(value.failure_rate*100).toFixed(1)}%`} · 首段文字样本 {value.first_text_ms.n}</p><p>统计为 HTTP 请求耗时；任务排队与进程准备见所选调用的「耗时分析」。</p></div>;
}
