# 搜索故障诊断与成功率

## 2026-10-16 本机复现

本次直接调用真实搜索接口，没有调用LLM生成答案，也没有向飞书发送内容。天气、Python TaskGroup文档、Qwen Agent仓库、LangGraph文档、DeepMind技术资讯各一个用例；所有连接均保留证书校验。

| 对照 | 本次结果 | 解释 |
|---|---|---|
| 系统代理 → 模型搜索API，每个新进程连续2次 | 0/10；首次0/5，第二次0/5 | TCP与代理CONNECT完成，约6秒后TLS握手提前EOF；没有取得搜索HTTP响应 |
| HTTPX，同一客户端连续3次 | 0/3 | 同样失败在代理后的TLS握手；切换HTTP库未解决 |
| 同一主搜索API，诊断请求直连 | 5/5，约2.9～7.9秒 | TLS正常、HTTP200、结果含来源；不等于五个问题均已回答正确 |
| 修复前完整搜索链路，另测1次 | 0/1 | TLS EOF被归为普通错误，未进入备用搜索 |
| 修复后完整搜索链路 | 5/5取得候选链接 | 主接口仍走系统代理且失败，有限重试后由Bing RSS返回 |

另起全新诊断进程，直连Python官方文档查询连续2次均成功（约5.0秒、4.3秒），再次说明本地程序首请求不是必然失败。该额外验证不计入上表五类用例的5次直连样本。

成对控制还观察到：模型列表接口直连HTTP200、经系统代理TLS失败，Bing/Python官网经系统代理可访问。故障范围是**当前代理到该API域名的TLS路径**，不是“新进程第一搜必败”，也不是关键词导致的搜索服务错误。本地代理节点、分流、DNS还是远端针对代理出口的限制，需要代理端日志进一步区分。

之前的Jev回执中曾有首搜成功、第二搜失败，也有相反情况。旧日志只有超时文本，不能据本次EOF回溯断言它们都发生在同一阶段。本机小样本不代表长期成功率；服务端缓存、真正的服务冷启动没有被控制。

## 已修复的代码缺口

- `ssl.SSLEOFError`、明确的TLS提前EOF、响应不完整、连接重置进入有限重试和备用搜索。证书校验、认证与配置错误仍直接失败。
- 主搜索每次尝试保留耗时、失败类别和阶段：TLS握手、DNS、连接/等待响应头、响应体、服务端返回的上游故障分别记录；普通超时无法进一步分辨时明确标为 `connect_or_response_headers`。
- 来源证据携带 `attempts` 和 `primary_failure`，备用失败时也保留主搜索诊断。凭据不进入这些字段。
- Bing RSS只视为候选链接，不因HTTP200或返回5条URL就判定任务完成。

本次备用结果中，天气查询跑题，TaskGroup查询只得到泛Python页面，Qwen Agent查询返回B2B采购站点，DeepMind资讯查询返回泛Google页面；只有LangGraph明确命中。改变空格编码和市场参数未稳定解决。不能用这些候选链接编写缺少依据的答案。

## 优先提高成功率

1. 优先修正模型API域名的代理分流：对已验证直连正常的**具体API域名**使用直连，公开网页继续遵从原代理。规则应放在更宽泛的代理规则之前；不要因此关闭证书校验。本次未修改用户的全局代理规则。
2. 搜索供应与LLM网关解耦：正式产品应使用可配置、可观测的独立搜索提供商；保留另一供应商兜底。RSS可作候选来源，但不宜作为稳定搜索API的等价替代。
3. 同时评估网络可用性与检索质量：核对实体、主题、日期和一手来源；不相关结果应重写查询或换渠道，不得以链接数量充当成功率。
4. 根据错误阶段处理：TLS提前断开不是单纯加长响应等待能修复的；HTTP429/5xx等才需要相应退避和服务端诊断。当前重试与总预算保持有界。

Mihomo支持按完整域名匹配与从上到下的规则优先级，具体语法见[官方路由规则](https://wiki.metacubex.one/config/rules/)。示例只针对一个API域名：

```yaml
rules:
  - DOMAIN,api.example.com,DIRECT
  # 后续保留已有规则
```

## 可复现诊断

```powershell
# 主接口：新进程中的首请求与连续请求，不自动重试
python scripts/diagnose_search.py --route system --samples 2 --query "Python 3.11 asyncio TaskGroup official documentation"

# 显式对比直连，只影响该独立诊断进程，不改变应用或全局代理配置
python scripts/diagnose_search.py --route direct --samples 2 --query "Python 3.11 asyncio TaskGroup official documentation"

# 实际主搜索重试 + 备用搜索路径
python scripts/diagnose_search.py --route pipeline --samples 1 --query "LangGraph official documentation"
```

默认写入本地 `memory/diagnostics/`；可用 `--output` 指定文件。输出不含Key和HTTP请求头；记录路由、每次请求耗时、错误阶段、渠道及候选URL。`ok`表示取得结构可用的候选结果，不表示内容准确或研究任务完成。公开版v0.2.3尚不含这些改动。
