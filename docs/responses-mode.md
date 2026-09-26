# Responses 搜索协议

`search.js` 的唯一生产搜索协议是 Responses API：

```bash
./scripts/search.js "query"
```

它不支持 Chat Completions，也没有模式切换或 Chat fallback。

## Direct xAI / openai-compatible

请求发送到：

```text
{GROK_API_URL}/responses
```

核心 body：

```json
{
  "model": "grok-4.3",
  "input": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "tools": [{ "type": "web_search" }],
  "max_turns": 3,
  "reasoning": { "effort": "low", "summary": "concise" },
  "stream": false
}
```

域名过滤放在 tool 的 `filters`：

```json
{
  "type": "web_search",
  "filters": { "allowed_domains": ["docs.x.ai"] }
}
```

X 搜索：

```bash
./scripts/search.js --responses-x-search "query"
./scripts/search.js --responses-x-search --responses-allowed-x-handles xai,OpenAI "query"
./scripts/search.js --responses-x-from-date 2026-07-01 --responses-x-to-date 2026-07-31 "query"
```

日期使用严格 `YYYY-MM-DD`，起止边界 inclusive，只过滤 X posts，不影响并行的 Web Search、Tavily 或 Firecrawl。只配置 `from_date` 或 `to_date` 也会自动启用 `x_search`。direct xAI 明确支持日期字段；`openai-compatible` relay 是否支持取决于其 Responses tool 实现。

X handle filters 会移除一个前导 `@`、按大小写不敏感去重，并在规范化后限制 allowed/excluded 各最多 20 个。图片、视频理解参数当前仅被识别并 fail fast，不会进入请求 payload。

固定推理模型或名称包含 `non-reasoning` 的模型不会发送可配置 reasoning 字段。

## OpenRouter

OpenRouter 使用：

```json
{
  "tools": [
    {
      "type": "openrouter:web_search",
      "parameters": {
        "engine": "auto",
        "max_results": 5,
        "max_total_results": 10
      }
    }
  ]
}
```

可选 engine：

```text
auto | native | exa | firecrawl | parallel | perplexity
```

```bash
./scripts/search.js --responses-openrouter-engine exa "query"
```

模型名不会自动追加 `:online`。

本项目当前不支持 OpenRouter X Search 日期过滤。为 OpenRouter 配置日期会在网络请求前返回 `RESPONSES_X_DATE_PROVIDER_UNSUPPORTED`，不会静默丢弃字段。

## Responses sources

解析器收集：

- output text annotations 与 top-level citations；
- `web_search_call`、`x_search_call` 的 action/query/url/source；
- usage 与费用字段。

结果进入 `sources.grok`：

```json
{
  "provider": "grok-responses",
  "source_type": "citation",
  "tool": "web_search",
  "url": "https://example.com"
}
```

同一 URL 同时是 `citation` 和 `searched` 时，citation 优先。

## Tavily 与 Firecrawl

它们与 Responses 请求并行，但不进入 `input`：

```text
Grok Responses ──────────────┐
Tavily Search（有 key）───────┼─ sources.merged
Firecrawl Search（Keyless/key）┘
```

默认合计 6 条；两家可用时 3/3。Firecrawl provider attempt 会包含 `auth_mode`，可能包含 `credits_used`。

## 额度错误

只有明确额度信号触发 degraded success：

- HTTP 402；
- HTTP 429 且正文包含 quota、credit、balance、billing、rate limit 等信号；
- `insufficient_quota`、`credits_exhausted` 等错误码。

降级输出同时包含人类可见警告和结构化 `diagnostics.grok_error`。`--no-extra` 时返回 `GROK_QUOTA_EXHAUSTED`。401/403、404/422、5xx、超时和空响应仍是普通错误。

## Diagnostics

重点字段：

- `grok_endpoint: responses`
- `responses_max_turns`
- `responses_web_search_calls`
- `responses_x_search_calls`
- `responses_x_from_date` / `responses_x_to_date`
- `responses_tool_calls`
- `extra_allocation`
- `firecrawl_auth_mode`
- `degraded` / `grok_error`
- `usage` / `cost_usd`
