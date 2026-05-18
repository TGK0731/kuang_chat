# RAG 检索增强生成 — 技术亮点总结

## 一、为什么需要 RAG？

大语言模型存在两个固有缺陷：

**幻觉问题**：模型会自信地编造不存在的事实。比如你问"腿痛有哪些原因"，它可能给出看似合理但实际胡编的答案。

**知识截止**：模型的训练数据有截止日期，无法回答训练后出现的新知识。

RAG（Retrieval-Augmented Generation）的思路是在提问时，先从本地知识库中检索相关文档片段，将检索结果与用户问题一起送入大模型，强制模型基于提供的上下文作答，而不是依靠自身不可靠的"记忆"。

核心价值一句话总结：**让大模型从不靠谱的"闭卷考试"变成可验证的"开卷考试"**。

## 二、整体架构

```
┌─────────────────────────────────────────────────┐
│  用户输入：腿痛有哪些原因？                       │
└────────────────────┬────────────────────────────┘
                     │ POST /api/chat + { rag: { enabled: true } }
                     ▼
┌─────────────────────────────────────────────────┐
│  服务端 RAG 引擎 (server/ragEngine.js)           │
│                                                  │
│  ① 分词 → ② BM25 检索 → ③ 语义精排(可选)        │
│       │                                          │
│       ▼ 检索到 3 个相关文档片段                   │
│  ④ 构建增强 Prompt：                             │
│     "请基于以下上下文回答，并在每句话后标注[1][2] │
│      CONTEXT:                                     │
│      [1] tuiteng.txt: 乳酸堆积导致腿痛...         │
│      [2] tuiteng.txt: 缺乏维生素D会导致...        │
│      [3] tuiteng.txt: 糖尿病引起神经末梢病变..."  │
└────────────────────┬────────────────────────────┘
                     │ POST /v2/chat/completions (增强后的 messages)
                     ▼
┌─────────────────────────────────────────────────┐
│  讯飞星火 MaaS API                               │
│  → 基于上下文生成回答，标注 [1] [2] [3]          │
└────────────────────┬────────────────────────────┘
                     │ SSE 流
                     ▼
┌─────────────────────────────────────────────────┐
│  前端渲染                                        │
│  - Markdown 中 [1] → <sup class="citation">[1]  │
│  - 消息底部展示"参考来源"卡片                    │
│  - 参考文献列表：文件名 + 匹配片段                │
└─────────────────────────────────────────────────┘
```

## 三、技术亮点

### 1. SSE 流拦截 — 在不中断流式输出的前提下注入元数据

**难点**：RAG 需要在 LLM 回复末尾注入来源信息，但当前系统使用 `maasRes.pipe(res)` 透明转发 SSE 流，不能中断流式体验。

**方案**：当 RAG 启用时，将 `maasRes.pipe(res)` 替换为手动拦截循环：

```javascript
// 拦截 SSE 流，在 [DONE] 前注入 sources 事件
maasRes.on('data', (chunk) => {
  for (const line of lines) {
    if (line.startsWith('data: ') && line.includes('[DONE]')) {
      // 在结束标记前塞入来源数据
      res.write(`data: ${JSON.stringify({ type: 'sources', sources })}\n\n`);
    }
    res.write(line + '\n');
  }
});
```

**效果**：前端接收到的 SSE 流末尾多了一个 `type: "sources"` 事件，包含文档名、匹配片段、引用编号。非 RAG 模式走原来的 `pipe()`，零开销。

### 2. 自研 BM25 检索引擎 — 零依赖、混合中英文分词

**为什么不用 Elasticsearch / LangChain / ChromaDB？**

- ES 太重，需要 Java 运行时
- LangChain 增加 50+ 依赖，引入大量抽象层
- ChromaDB/Pinecone 需要独立进程，运维复杂

实际需求只是"对少量文档做关键词匹配 + 可选的向量精排"，300 行代码即可覆盖。

**中文分词方案**：unigram + bigram

中文不像英文有空格分词。例如"腿痛有哪些原因"如果当作整段匹配，文档里根本不可能有完全相同的短语。

```
输入："腿痛有哪些原因"
  → unigram: 腿 痛 有 哪 些 原 因
  → bigram:  腿痛 痛有 有哪 哪些 些原 原因
```

这样查询"腿痛"就能命中文档中"腿痛起来"、"导致腿痛"等片段。BM25 的 TF-IDF 变体天然适合这种 token 级别的模糊匹配。

**BM25 核心公式**（约 80 行代码）：

```
BM25(q, d) = Σ IDF(qi) × [f(qi,d) × (k1+1)] ÷ [f(qi,d) + k1 × (1 - b + b × |d|/avgdl)]
```

k1=1.5 控制词频饱和度，b=0.75 控制文档长度惩罚。

### 3. 增量式设计 — RAG 是附加功能，不破坏原有流程

**关键设计原则**：

- 服务端：`/api/chat` 新增可选字段 `rag: { enabled: true }`，不传则走原有透传逻辑
- 前端：streamParser 新增 `onComplete(sources)` 回调参数，无 RAG 时 sources 为空数组，不影响任何组件
- 消息对象：新增 `sources: []` 字段，向下兼容——旧消息没有 sources 字段，渲染时跳过
- 模型无关：BM25 + 可选 embeddings 的检索管线独立于讯飞星火 MaaS，服务商切换时检索部分不受影响

### 4. 文档处理管线 — 段落感知的分块策略

纯按字符数切分会破坏语义完整性。

**实际采用的分块策略**（`chunkText` 函数）：

```
原始文档
  → 按 \n\n 分割段落
  → 短段落合并（凑够 ~300 字符）
  → 长段落按句末标点(. 。 ! ?)拆分
  → 相邻块加 100 字符重叠（防止关键信息被切断）
  → 最终得到 300-800 字符的语义连贯块
```

### 5. 混合检索架构 — BM25 粗筛 + Embedding 精排（可选）

```javascript
async function retrieveChunks(query, bm25Index, embeddingsProvider) {
  // 阶段 1: BM25 粗筛 → 召回 20 个候选
  const candidates = bm25Index.search(query, 20);

  // 阶段 2: 如果有 embeddings → 语义精排 top-5
  if (embeddingsProvider) {
    const queryVec = await embeddingsProvider.embed([query]);
    const chunkVecs = await embeddingsProvider.embed(candidates);
    return rerankByCosine(queryVec, chunkVecs) × 0.6 + normalize(bm25Score) × 0.4;
  }

  // 否则纯 BM25 返回
  return candidates.slice(0, 5);
}
```

服务启动时自动探测 MaaS 的 embeddings 端点，不可用则优雅降级为纯 BM25 模式，不影响核心功能。

### 6. 编码兼容 — UTF-8/GBK 自动检测

Node.js 18 不支持 GBK 解码，但 Windows 环境的某些工具会用 GBK 发送中文字符。通过 `iconv-lite` 实现自动检测：

```javascript
function safeDecode(buf) {
  const utf8 = buf.toString('utf-8');
  if (!utf8.includes('�')) return utf8;        // UTF-8 正常
  try { return iconv.decode(buf, 'gbk'); }      // 回退到 GBK
  catch { return utf8; }                         // 保底
}
```

## 四、工程实践亮点

### 问题调试能力

实现过程中遇到了三个隐蔽 bug，逐一定位修复：

| Bug | 现象 | 根因 | 排查手段 |
|-----|------|------|----------|
| 闭包陈旧引用 | RAG 开关无效 | `useCallback` 依赖数组缺失 | 阅读代码逻辑 |
| 中文分词失效 | BM25 返回 0 结果 | 正则分词把整段中文当一个 token | 打印 token 输出 |
| 请求体编码损坏 | 服务端收到乱码 | `body += Buffer` + Windows GBK | 打印 hex 原始字节 |

### 文件变更统计

| 类型 | 文件 | 新增行数 |
|------|------|----------|
| 新建 | `server/ragEngine.js` | ~430 行 |
| 新建 | `src/components/Upload/UploadPanel.jsx` | ~80 行 |
| 新建 | `src/components/Upload/UploadPanel.css` | ~120 行 |
| 修改 | `server.js` | +120 行 |
| 修改 | `src/services/streamParser.js` | +15 行 |
| 修改 | `src/context/Context.jsx` | +70 行 |
| 修改 | `src/components/Main/Main.jsx` | +40 行 |
| 修改 | `src/components/MarkdownRenderer/MarkdownRenderer.jsx` | +20 行 |

总计新增约 900 行业务代码，唯一新增 npm 依赖：`iconv-lite` + `pdf-parse`（可选）。

## 五、核心技术栈

| 层 | 技术 |
|----|------|
| 检索 | 自研 BM25（unigram+bigram 中英文分词） |
| 语义精排 | Cosine Similarity（可选，接 MaaS embeddings） |
| 文档处理 | 段落感知分块 + 滑动窗口重叠 |
| 流式协议 | SSE 拦截注入（不破坏 stream） |
| 前端渲染 | react-markdown 自定义 [N] 引用标记组件 |
| 编码兼容 | iconv-lite UTF-8/GBK 自动检测 |
