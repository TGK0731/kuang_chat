# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 快速启动
```bash
npm run dev      # 前端 (Vite, :5173)
npm run server   # 后端 (:3001, 端口从 .env 读取)
npm run build    # 生产构建

## Architecture

This is a React + Node.js AI chat application. The frontend sends conversation messages to `POST /api/chat` on the Node.js backend, which proxies them to the 讯飞星火 MaaS API (`maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions`). The backend pipes the SSE stream directly back to the frontend.

### Three-layer design (frontend-side streaming)

1. **Stream parser** (`src/services/streamParser.js`) — Singleton class. Consumes the SSE stream via `fetch` + `ReadableStream`, decodes with `TextDecoder('utf-8', { stream: true })`, buffers SSE lines, parses JSON delta events, and rhythmically flushes content (every 50ms, 8 chars at a time) to a callback. Supports abort via `AbortController`.
2. **Global context** (`src/context/Context.jsx`) — React Context holding all shared state: messages, sessions, generation status, input, voice state, and scroll refs. The `onSent` function orchestrates the full send→stream→complete lifecycle. Session state is mirrored into `sessions` so conversation history survives switching.
3. **Rendering** (`src/components/Main/Main.jsx`) — Uses `react-virtuoso` for virtualized message list. Marks messages with status (`generating`, `completed`, `aborted`, `failed`). Renders markdown via `react-markdown` with GFM, raw HTML, and highlight.js code blocks.

### Key files

| File | Role |
|---|---|
| `server.js` | Node.js HTTP server, SSE proxy to 讯飞星火 MaaS. CORS permissive, handles `/api/chat` (POST) and `/health` (GET). |
| `src/services/streamParser.js` | SSE stream decoder + rhythm-controlled content flushing |
| `src/context/Context.jsx` | Global state: messages, multi-session management, scroll-to-bottom, generation lifecycle |
| `src/components/Main/Main.jsx` | Chat UI: virtual message list, input box, voice button, preset cards |
| `src/components/SideBar/SideBar.jsx` | Session list sidebar: create, switch, delete sessions |
| `src/components/MarkdownRenderer/MarkdownRenderer.jsx` | react-markdown wrapper with GFM + highlight.js |
| `src/hooks/useSpeechRecognition.js` | Web Speech API hook with idle→recording→processing state machine, Chinese language, error mapping |

### Unused / legacy files

- `src/config/aiService.js` — Old DeepSeek mock service, not wired into the app.
- `src/config/gemini.js` — Old Google Gemini integration, not wired in (has a syntax error too — references undefined `API_KEY` and `MODEL_NAME`).

### Model configuration

The AI model is configured in `server.js` in the `requestBody` object. Current model: `xop35qwen2b`. Tune `max_tokens`, `temperature`, and `stream` there.

### Streaming control knobs

- Flush interval: `StreamParser.startFlush()` interval (default 50ms) in `streamParser.js`
- Chunk size: `Math.min(8, ...)` in `StreamParser.flushChunk()`
- Scroll threshold: `< 100` distance check in `Context.jsx` (though `react-virtuoso`'s `atBottomStateChange` now drives scroll behavior)


## Git 提交规范
- feat: 新功能
- fix: 修复 bug
- refactor: 重构
- docs: 文档更新
- style: 代码格式（不影响功能）
- chore: 构建/工具变动

## 常用 Git 流程
1. 开始新功能：git checkout -b feat/功能名
2. 开发完成后：git add . && git commit -m "feat: xxx"
3. 推送到远程：git push -u origin feat/功能名
4. 在 GitHub 上发起 Pull Request 合并到 main

## 回答偏好
- 回复使用中文
- 代码修改前先简要说明修改思路，不要直接给出代码
- 遇到有多种实现方案时，列出选项让我选择，而不是直接选一种

## 安全习惯
- 修改认证相关代码前主动提示我注意安全影响
- 不要在代码注释或日志中输出任何密钥或 token

## 个人偏好

- 请用 "kk" 称呼我