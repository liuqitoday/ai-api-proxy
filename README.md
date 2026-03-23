# ai-api-proxy

一个面向 AI 接口调试、观测和协议适配的轻量代理服务。

当前仓库提供两套独立代理入口：

- `server-anthropic.js`: 面向 Anthropic 风格 `POST /v1/messages`
- `server-openai.js`: 面向 OpenAI 风格 `POST /v1/responses`

它的目标不是成为重型 API 网关，而是作为一个足够简单、易读、易改的代理层，方便你在本地开发或小规模服务中完成这些事情：

- 统一转发请求到指定上游 AI 服务
- 保留完整请求与响应日志，便于排查问题
- 在不破坏流式体验的前提下解析 SSE 事件
- 作为后续做鉴权、限流、脱敏、协议转换的基础骨架

## 特性

- 极简实现，核心逻辑集中在两个入口文件
- 支持 Anthropic `messages` 协议
- 支持 OpenAI `responses` 协议
- 支持非流式响应与 SSE 流式响应
- 记录请求体、响应体和异常信息
- 对流式事件做可读性更高的日志整理
- 尽量透明转发请求头和响应头

## 适用场景

- 本地调试 AI SDK / CLI / 前端调用
- 观察模型流式输出的真实事件序列
- 复盘工具调用参数、文本输出、异常响应
- 作为企业内部网关或更复杂代理的原型项目

## 项目结构

```text
.
├── server-anthropic.js   # Anthropic /v1/messages 代理
├── server-openai.js      # OpenAI /v1/responses 代理
├── config.anthropic.json.example
├── config.openai.json.example
├── config.json
├── package.json
├── package-lock.json
├── LICENSE
└── README.md
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动 Anthropic 版代理

从示例文件复制一份配置：

```bash
cp config.anthropic.json.example config.json
```

然后按需编辑 `config.json`：

```json
{
  "port": 3000,
  "upstream": "https://your-anthropic-compatible-upstream",
  "logFile": "proxy.log"
}
```

启动：

```bash
npm run start:anthropic
```

默认监听：

```text
http://localhost:3000/v1/messages
```

### 3. 启动 OpenAI 版代理

从示例文件复制一份配置：

```bash
cp config.openai.json.example config.openai.json
```

然后按需编辑 `config.openai.json`：

```json
{
  "port": 3001,
  "apiBase": "https://api.openai.com",
  "apiKey": "sk-xxxx",
  "organization": "org_xxx",
  "project": "proj_xxx",
  "logFile": "proxy-openai.log",
  "timeoutMs": 300000
}
```

启动：

```bash
npm run start:openai
```

默认监听：

```text
http://localhost:3001/v1/responses
```

## 调用示例

### Anthropic 风格

```bash
curl http://localhost:3000/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: YOUR_KEY" \
  -d '{
    "model": "claude-opus-4-1",
    "messages": [
      {
        "role": "user",
        "content": "你好，介绍一下你自己"
      }
    ],
    "stream": false
  }'
```

### OpenAI Responses 风格

```bash
curl http://localhost:3001/v1/responses \
  -H "content-type: application/json" \
  -H "authorization: Bearer sk-xxxx" \
  -d '{
    "model": "gpt-5",
    "input": "你好，介绍一下你自己",
    "stream": false
  }'
```

## 关键原理

### 1. 透明转发优先

这个项目默认不做复杂协议重写，而是尽量把调用方请求直接转发给上游，只在代理层修正必须修正的信息，例如：

- `Host`
- `Content-Length`
- OpenAI 代理中的可选鉴权头注入

这样做有几个好处：

- 调用方接入成本低
- 代理层不容易引入额外字段映射错误
- 更适合作为调试代理和基础设施原型

### 2. SSE 一边转发，一边记录

流式响应不能等全部结束再返回给客户端，否则就失去了“流式”的价值。

当前实现采用的是：

1. 从上游按块读取 SSE 数据
2. 每读到一个 chunk 就立即写给客户端
3. 同时把原始 chunk 暂存下来
4. 在流结束后，再把完整 SSE 数据解析成更可读的日志

这意味着代理同时满足两个目标：

- 客户端仍然获得实时输出
- 服务端仍然获得完整可复盘的日志

### 3. 为什么要解析流式事件

无论是 Anthropic 还是 OpenAI，原始 SSE 事件通常都比较碎，例如：

- 文本输出按 delta 分段发送
- 工具调用参数按增量 JSON 发送
- 状态信息和 token usage 分布在多个事件里

如果直接把原始 `data: {...}` 写进日志，调试体验会很差。这个项目会在日志层把这些事件整理成更接近人类阅读的形式，例如：

- `[Text]`
- `[Tool Call]`
- `[Tool Arguments]`
- `[Usage]`
- `[Error]`

### 4. 为什么过滤部分响应头

代理从上游拿到响应后，并不是把底层连接原封不动透传，而是由当前 Node/Express 进程重新输出响应，因此下面这些头不能简单照搬：

- `content-length`
- `transfer-encoding`
- `content-encoding`

否则容易出现长度不一致、传输方式不一致、客户端解码异常等问题。

### 5. 为什么日志使用同步写入

当前实现使用 `fs.appendFileSync()`。

这不是高并发场景最优方案，但对一个“小而清晰”的调试代理来说有现实优势：

- 逻辑简单
- 不引入额外日志依赖
- 日志顺序更直观

如果你要把它用于更高并发或长期运行环境，建议替换为标准日志系统。

## 两个入口的区别

### `server-anthropic.js`

- 路由：`POST /v1/messages`
- 上游配置：`config.json` 中的 `upstream`
- 适合对接 Anthropic 兼容接口
- 会把 Anthropic 风格 SSE 事件整理为可读日志

### `server-openai.js`

- 路由：`POST /v1/responses`
- 上游配置：优先读取 `config.openai.json`
- 默认上游：`https://api.openai.com`
- 支持 `Authorization`、`OpenAI-Organization`、`OpenAI-Project`
- 会把 OpenAI Responses API 的常见流式事件整理为可读日志

## 配置说明

### Anthropic 版

参考 `config.anthropic.json.example`，运行时使用 `config.json`：

```json
{
  "port": 3000,
  "upstream": "https://your-upstream-host",
  "logFile": "proxy.log"
}
```

字段说明：

- `port`: 本地监听端口
- `upstream`: 上游服务根地址
- `logFile`: 日志文件路径

### OpenAI 版

参考 `config.openai.json.example`，运行时使用 `config.openai.json`：

```json
{
  "port": 3001,
  "apiBase": "https://api.openai.com",
  "apiKey": "sk-xxxx",
  "organization": "org_xxx",
  "project": "proj_xxx",
  "logFile": "proxy-openai.log",
  "timeoutMs": 300000,
  "bodyLimit": "10mb"
}
```

字段说明：

- `port`: 本地监听端口
- `apiBase`: OpenAI API 根地址
- `apiKey`: 默认 API Key，可选
- `organization`: 可选组织头
- `project`: 可选项目头
- `logFile`: 日志文件路径
- `timeoutMs`: 上游请求超时时间
- `bodyLimit`: JSON body 大小限制

## 运行要求

- Node.js 18+

原因：

- 使用了 Node 内置 `fetch`
- 当前依赖的 `express@5` 需要较新 Node 版本

## 日志

日志默认会记录：

- 请求体
- 响应体
- 流式响应整理结果
- 异常信息

请注意：

- 日志可能包含敏感数据
- 当前不做脱敏
- 当前不做日志轮转

如果用于真实业务环境，建议优先补充日志脱敏、轮转和请求 ID。

## 已知限制

- 当前仍是“轻量代理”，不是生产级 API 网关
- 只覆盖两个明确路由：`/v1/messages` 与 `/v1/responses`
- 没有统一的插件式配置体系
- 没有鉴权白名单、限流、熔断、重试等生产能力
- 流式日志解析针对主流事件格式做了处理，但不保证覆盖所有未来事件类型
- 大流式响应会额外占用一份内存用于日志解析
- 当前没有测试代码

## Roadmap

- 增加环境变量配置支持
- 增加配置示例文件
- 增加请求 ID 与结构化日志
- 增加脱敏和日志轮转
- 增加协议适配层，例如 `messages -> responses`
- 增加测试与 CI

## 贡献

欢迎提交 Issue 和 PR。

如果你准备基于这个项目做扩展，比较适合从下面几个方向入手：

- 增加中间件化能力
- 增加更多上游协议支持
- 增加更完整的观测与错误处理

## License

MIT

## 说明

这个项目当前更偏向“工程骨架”和“可读实现”，而不是一个已经产品化的通用网关。

如果你需要一个简单、清晰、方便二次开发的 AI API 代理起点，这个仓库就是为这个目的准备的。
