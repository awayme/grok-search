# BlueOcean `grok-search` X Search 参数改造计划

> 历史计划：本文记录 2026-07-31 基于 `2f6fee5` 的方案。后续 `main` 已采用 `--source web|x|both`、`--x-from-date` / `--x-to-date`，并支持 `--x-images` / `--x-videos`。当前行为以 README 和 `references/x-search.md` 为准。

## 1. 文档信息

- 目标项目：`BlueOcean223/grok-search`
- 审计基线：commit `2f6fee5ea90420282a85871aff036ad616a314f6`
- 文档日期：2026-07-31
- 目标：为 X Search 增加 `from_date`、`to_date`，修复已发现的参数校验缺陷，并对暂不支持的图片、视频理解参数给出明确、可测试的错误。
- 非目标：本计划不实现 `enable_image_understanding`、`enable_video_understanding`，不改变 Grok Responses 结果解析、Tavily/Firecrawl 检索、正文抓取或 benchmark 评分逻辑。

## 2. 背景与现状

当前 direct xAI Responses 请求能够加入 `x_search`，并支持：

- `allowed_x_handles`
- `excluded_x_handles`

当前尚未支持的 xAI `x_search` 参数：

- `from_date`
- `to_date`
- `enable_image_understanding`
- `enable_video_understanding`

现有 `directXSearchTool()` 只写入 handle filters。CLI、配置文件、环境变量、diagnostics 和测试也没有日期或媒体理解参数。OpenRouter 分支使用顶层 `x_search_filter`，但仓库内没有证据证明该接口接受日期和媒体理解字段。

## 3. 成功标准

完成后必须满足：

1. direct xAI `/responses` 请求可在 `x_search` tool 中正确传递 `from_date`、`to_date`。
2. CLI、环境变量和 JSON 配置文件均可设置日期，且优先级保持现有规则：CLI > environment/config 解析结果。
3. 只设置日期而未显式设置 `--responses-x-search` 时，自动启用 `x_search`。
4. 日期必须为真实的 ISO 8601 calendar date：`YYYY-MM-DD`；起始日期不得晚于结束日期。
5. 未提供日期时，生成的 payload 与改造前完全一致。
6. `allowed_x_handles` 和 `excluded_x_handles` 分别最多接受 20 个去重后的 handle。
7. 用户尝试启用图片或视频理解时，在发送网络请求前返回稳定、明确的 unsupported error，不得静默忽略。
8. diagnostics 回显实际生效的日期窗口和 X Search 开关，便于审计请求行为。
9. `npm test` 全部通过，并新增参数级和 CLI 级回归测试。

## 4. 对外参数设计

### 4.1 CLI

新增：

```text
--responses-x-from-date YYYY-MM-DD
--responses-x-to-date YYYY-MM-DD
--responses-x-enable-image-understanding
--responses-x-enable-video-understanding
```

前两个参数正式支持。后两个参数属于 recognized-but-rejected guard：解析器识别参数，但 option resolution 阶段明确报错，防止用户误以为未知参数、relay 或未来兼容层已经支持它们。

同时支持现有 CLI 的 `--name=value` 形式：

```text
--responses-x-from-date=2026-07-01
--responses-x-to-date=2026-07-31
```

### 4.2 环境变量

```text
GROK_RESPONSES_X_FROM_DATE
GROK_RESPONSES_X_TO_DATE
GROK_RESPONSES_X_ENABLE_IMAGE_UNDERSTANDING
GROK_RESPONSES_X_ENABLE_VIDEO_UNDERSTANDING
```

媒体参数只有值为 `true` 时触发 unsupported error；未配置或显式为 `false` 时不影响现有行为。

### 4.3 JSON 配置键

主键及兼容别名：

| 功能 | camelCase | snake_case |
|---|---|---|
| 开始日期 | `responsesXFromDate` | `responses_x_from_date` |
| 结束日期 | `responsesXToDate` | `responses_x_to_date` |
| 图片理解 | `responsesXEnableImageUnderstanding` | `responses_x_enable_image_understanding` |
| 视频理解 | `responsesXEnableVideoUnderstanding` | `responses_x_enable_video_understanding` |

### 4.4 Responses payload

direct xAI 目标 payload：

```json
{
  "type": "x_search",
  "allowed_x_handles": ["xai"],
  "from_date": "2026-07-01",
  "to_date": "2026-07-31"
}
```

只写入用户实际提供的可选字段，不发送空字符串或 `null`。

## 5. 错误契约

### 5.1 日期格式错误

- code：`RESPONSES_X_DATE_INVALID`
- 示例：

```text
GROK_RESPONSES_X_FROM_DATE must be a valid calendar date in YYYY-MM-DD format; received "2026-02-30".
```

校验必须同时检查格式和真实 calendar date，不能只使用宽松的 `Date.parse()`。

### 5.2 日期窗口倒置

- code：`RESPONSES_X_DATE_RANGE_INVALID`
- 示例：

```text
X Search from_date must not be later than to_date; received 2026-08-01 > 2026-07-31.
```

### 5.3 图片、视频理解不支持

- code：`RESPONSES_X_MEDIA_UNSUPPORTED`
- 图片示例：

```text
X Search parameter enable_image_understanding is not supported by this project yet. Remove --responses-x-enable-image-understanding and use text-only X Search.
```

- 视频示例：

```text
X Search parameter enable_video_understanding is not supported by this project yet. Remove --responses-x-enable-video-understanding and use text-only X Search.
```

若两个参数同时启用，单次错误中列出两个 unsupported parameters。错误必须发生在任何 Grok、Tavily 或 Firecrawl 请求启动之前。

### 5.4 Provider capability 错误

direct xAI 明确支持日期字段。OpenRouter 当前实现使用非 xAI 原生的顶层 `x_search_filter`；在获得其当前 schema 的一手证据并增加 contract test 前，不应猜测支持。

推荐第一阶段行为：

- `apiProvider === "xai"`：支持日期。
- `apiProvider === "openai-compatible"`：允许发送 xAI-compatible tool 字段，但在文档中标为 relay-dependent；上游拒绝时保留原始状态码和错误摘要。
- `apiProvider === "openrouter"` 且配置日期：本地 fail fast。

错误定义：

- code：`RESPONSES_X_DATE_PROVIDER_UNSUPPORTED`
- message：

```text
X Search date filters are not supported for apiProvider=openrouter by this project. Use direct xAI Responses or remove the date filters.
```

后续只有在 OpenRouter 官方 schema 和 mock contract test 同时确认后，才取消该限制。

## 6. 已发现并应同步修复的缺陷

### P1：X handle 数量上限未校验

现有代码校验 Web domain 最多 5 项，但没有调用：

```js
validateMaxItems(allowedXHandles, "responses allowed X handles", 20);
validateMaxItems(excludedXHandles, "responses excluded X handles", 20);
```

这会把错误推迟到上游 API，并产生不一致的本地行为。应在发送请求前返回 `RESPONSES_FILTER_LIMIT`。

### P1：OpenRouter X Search capability 语义不明确

OpenRouter body 始终只声明 `openrouter:web_search` tool，X 相关内容通过顶层 `x_search_filter` 传递。仓库测试只验证 payload shape，没有验证该组合会实际触发 X Search。应完成以下二选一决策：

1. 取得 OpenRouter 官方 contract 并增加真实或可复现的 integration fixture；或
2. 在文档和 diagnostics 中明确标注 `x_search` 支持仅对 direct xAI 有保证。

本次日期改造采用第二种保守策略，避免扩大未经验证的能力声明。

### P2：X handle 缺少规范化和有效性检查

当前列表解析只执行 `trim()`，因此 `@xai`、`xai`、`XAI` 可能作为三个值占用额度。建议：

- 去除单个前导 `@`；
- 按 case-insensitive key 去重，保留首次输入的显示形式；
- 拒绝空值、URL、空白字符和明显不是 handle 的值；
- 在规范化、去重后再执行 20 项上限校验。

不建议在没有官方明确约束时加入过严的长度或字符集规则，以免误拒未来合法 handle。

### P2：自动启用 `x_search` 的触发条件不完整

现有逻辑只在显式开关或 handle filters 存在时启用 X Search。改造后触发条件应为：

```text
explicit include flag
OR allowed/excluded handles 非空
OR from_date 存在
OR to_date 存在
```

媒体参数由于当前明确不支持，先报错，不参与自动启用。

### P2：diagnostics 不包含日期窗口

新增：

```json
{
  "responses_x_from_date": "2026-07-01",
  "responses_x_to_date": "2026-07-31"
}
```

未配置时保持 `null` 或空字符串需要统一。建议使用 `null`，便于 JSON consumer 区分“未配置”和合法字符串。

### P3：usage 文本没有列出已有 Responses filters

当前 `usage()` 只展示 `GROK_RESPONSES_MAX_TURNS`，没有系统列出 domain/X filters。此次改造应同步补齐相关 CLI 与环境变量，降低 README 与实际 CLI 漂移。

## 7. 文件级实施方案

### `scripts/search.js`

1. 在 `parseArgs()` 增加四个 CLI 参数及返回字段。
2. 增加严格日期工具函数，例如 `normalizeIsoDate(name, value)`。
3. 在 `resolveSearchOptions()` 中完成 CLI/config 合并、日期校验、倒序校验和 media unsupported 校验。
4. 补 X handle 规范化、去重和最多 20 项校验。
5. 扩展 `includeXSearch` 的隐式启用条件。
6. 在 `responsesDiagnosticOptions()` 回显日期。
7. 扩展 `usage()`。

建议将可独立测试的日期和 handle 校验提取到 `scripts/lib/` 中；若只在 `search.js` 内使用且保持短小，也可维持当前项目风格，避免过度抽象。

### `scripts/lib/config.js`

1. 使用 `envOrFile()` 读取两个日期字符串。
2. 使用 `envOrFileBool()` 读取两个 media guard 参数。
3. 返回统一的 camelCase options。
4. 不在 config loader 中静默修复非法日期；严格校验集中在 `resolveSearchOptions()`，确保 CLI 和 config 使用同一规则。

### `scripts/lib/grok-responses.js`

1. 在 `directXSearchTool()` 中按需写入 `from_date`、`to_date`。
2. 不写入两个 media 字段，因为当前产品契约明确不支持。
3. OpenRouter builder 不写日期；provider gate 应在进入 builder 前拒绝，防止丢参。
4. `baseOptions` 和调用链统一补充 `xFromDate`、`xToDate`。

### `tests/responses.test.js`

增加纯 payload 测试：

- 无日期：payload 回归不变；
- 只有 `from_date`；
- 只有 `to_date`；
- 同时有起止日期；
- 日期与 handles 同时存在；
- media 字段永远不进入 payload；
- OpenRouter 日期由上层 capability gate 拒绝，不测试静默丢弃。

### `tests/argv.test.js`

增加端到端 mock-server 测试：

- CLI 空格形式和 `--name=value` 形式；
- config/environment 日期生效；
- CLI 覆盖 config；
- 日期隐式启用 `x_search`；
- 非法格式、无效 calendar date、倒序日期均在网络请求前失败；
- handles 超过 20 项失败；
- allowed/excluded 互斥行为保持不变；
- 图片、视频、同时启用两者分别返回明确 unsupported error；
- OpenRouter + 日期返回 provider unsupported error。

### `README.md`、`SKILL.md`

1. 增加 CLI、环境变量和 JSON 配置示例。
2. 明确日期只过滤 X posts，不过滤 Web Search 结果。
3. 明确日期格式和边界为 inclusive，具体以 xAI contract 为准。
4. 明确图片、视频理解当前不支持，且尝试启用会 fail fast。
5. 标注 OpenRouter 日期过滤暂不支持。
6. 给出 Codex 使用示例：

```bash
./scripts/search.js \
  --responses-x-search \
  --responses-x-from-date 2026-07-01 \
  --responses-x-to-date 2026-07-31 \
  --responses-allowed-x-handles xai,OpenAI \
  "official announcements about new reasoning models"
```

## 8. 测试矩阵

| 场景 | 期望结果 |
|---|---|
| 未设置任何 X 参数 | 只有 `web_search` tool，行为不变 |
| 仅显式启用 X | 加入裸 `{type: "x_search"}` |
| 仅设置 `from_date` | 自动加入 X tool 和 `from_date` |
| 仅设置 `to_date` | 自动加入 X tool 和 `to_date` |
| 设置完整窗口 | 两个日期均出现在 X tool |
| `2026-2-1` | `RESPONSES_X_DATE_INVALID` |
| `2026-02-30` | `RESPONSES_X_DATE_INVALID` |
| `from_date > to_date` | `RESPONSES_X_DATE_RANGE_INVALID` |
| allowed 与 excluded handles 同时设置 | `RESPONSES_FILTER_CONFLICT` |
| 21 个去重后 handles | `RESPONSES_FILTER_LIMIT` |
| 21 个输入但规范化后为 20 个 | 接受，以去重后数量为准 |
| `@xai,xai,XAI` | 规范化为一个 handle |
| 启用图片理解 | `RESPONSES_X_MEDIA_UNSUPPORTED` |
| 启用视频理解 | `RESPONSES_X_MEDIA_UNSUPPORTED` |
| OpenRouter + 日期 | `RESPONSES_X_DATE_PROVIDER_UNSUPPORTED` |
| direct xAI + 日期 | 正常发出 Responses 请求 |
| 上游 relay 拒绝字段 | 保留上游 HTTP 状态与错误摘要，不伪装为搜索成功 |

## 9. 验收检查清单

- [ ] CLI、environment、JSON config 三条输入路径均已覆盖。
- [ ] 日期格式和真实 calendar date 均被校验。
- [ ] 日期范围顺序被校验。
- [ ] 日期能隐式启用 X Search。
- [ ] direct xAI payload 与官方 `x_search` schema 一致。
- [ ] 无日期请求保持向后兼容。
- [ ] X handles 互斥、规范化、去重和 20 项上限已覆盖。
- [ ] 图片、视频参数返回稳定错误码和明确提示。
- [ ] unsupported error 在任何网络调用前发生。
- [ ] OpenRouter capability 不被未经证据地扩大声明。
- [ ] diagnostics 可审计实际日期和 provider。
- [ ] README、SKILL 和 CLI usage 保持一致。
- [ ] `npm test` 通过。
- [ ] 至少一次 direct xAI staging/sandbox 请求验证日期窗口确实改变 X 搜索范围；若无法执行，发布说明中明确该验证缺口。

## 10. 建议实施顺序与 commit 边界

### Commit 1：补齐 X filter 校验

- handle 规范化、去重、互斥和 20 项上限；
- 对应 unit/argv tests；
- 不改变 payload schema。

### Commit 2：实现 X date filters

- CLI/config/environment；
- 日期验证和自动启用 X Search；
- direct Responses payload；
- diagnostics；
- unit/argv tests。

### Commit 3：增加 media unsupported guard 与 provider gate

- recognized-but-rejected media options；
- OpenRouter date capability fail-fast；
- 稳定错误码和测试。

### Commit 4：文档与使用示例

- README、SKILL、CLI usage；
- 支持矩阵和限制说明。

## 11. 风险与后续工作

### 当前范围内风险

- Responses-compatible relay 可能只实现部分 xAI tool schema。通过 provider gate 和保留上游错误控制风险。
- 过度严格的 handle 字符校验可能误拒合法账号。首版只处理前导 `@`、空白、URL、去重和数量上限。
- 日期过滤只约束 X Search，不应被描述为同时约束 Web Search 或 Tavily/Firecrawl。

### 后续独立项目

以下能力不应混入本次日期改造：

- 正式支持 `enable_image_understanding`；
- 正式支持 `enable_video_understanding`；
- 为图片、视频证据增加输出 schema 和 citation 展示；
- 验证 OpenRouter 是否真实执行 X Search；
- 增加 claim-level citation coverage 和第二阶段 evidence verification；
- 扩充 X-specific benchmark，包括时间窗、账号限定、删除帖、转帖和 thread fetch 场景。

## 12. 完成定义

只有在代码、测试、文档和 provider 行为说明同时完成后，才能宣称支持 `from_date`、`to_date`。媒体理解参数在本阶段的完成定义是“明确拒绝且可测试”，不是“接受但忽略”。任何 relay 无法确认的能力都必须标为 provider-dependent 或 fail fast，不能通过 README 文案推断为已支持。
