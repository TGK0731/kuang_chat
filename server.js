import http from 'http';
import https from 'https';
import dotenv from 'dotenv';
import iconv from 'iconv-lite';
import { createRagEngine } from './server/ragEngine.js';

dotenv.config();

const API_KEY = process.env.XUNFEI_API_KEY;
const PORT = process.env.PORT || 3001;

const ragEngine = createRagEngine(API_KEY);

// Probe embeddings in background (non-blocking)
ragEngine.ensureEmbeddings().then((provider) => {
  if (provider) console.log('Embeddings provider ready');
  else console.log('Embeddings unavailable, using BM25-only mode');
});

// ---- Safe UTF-8/GBK decoder ----
function safeDecode(buf) {
  const utf8 = buf.toString('utf-8');
  if (!utf8.includes('�')) return utf8;
  try { return iconv.decode(buf, 'gbk'); } catch (_) { return utf8; }
}

// ---- Multipart Parser (single file) ----
function parseMultipart(buffer, boundary) {
  const str = buffer.toString('binary');
  const boundaryDelim = '--' + boundary;
  const parts = str.split(boundaryDelim);

  for (const part of parts) {
    if (!part.includes('Content-Disposition')) continue;
    const filenameMatch = part.match(/filename="(.+?)"/);
    if (!filenameMatch) continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const contentStart = headerEnd + 4;
    let contentEnd = part.lastIndexOf('\r\n--');
    if (contentEnd === -1) contentEnd = part.lastIndexOf('\r\n' + boundaryDelim);
    if (contentEnd === -1) contentEnd = part.lastIndexOf('\r\n');
    if (contentEnd < contentStart) contentEnd = part.length;
    return {
      filename: filenameMatch[1],
      data: Buffer.from(part.slice(contentStart, contentEnd), 'binary'),
    };
  }
  return null;
}

// ---- Server ----
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  // --- GET /api/rag/documents?action=list ---
  if (req.method === 'GET' && req.url === '/api/rag/documents') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ documents: ragEngine.listDocuments() }));
    return;
  }

  // --- POST /api/rag/documents (remove) ---
  if (req.method === 'POST' && req.url === '/api/rag/documents') {
    const docChunks = [];
    req.on('data', (c) => docChunks.push(c));
    req.on('end', () => {
      try {
        const buf = Buffer.concat(docChunks);
        const body = safeDecode(buf);
        const { action, filename } = JSON.parse(body);
        if (action === 'remove' && filename) {
          const removed = ragEngine.removeDocument(decodeURIComponent(filename));
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true, removedChunks: removed }));
        } else {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Invalid action' }));
        }
      } catch (e) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- POST /api/upload ---
  if (req.method === 'POST' && req.url === '/api/upload') {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)$/);

    if (!boundaryMatch) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
      return;
    }

    const boundary = boundaryMatch[1];
    const chunks = [];
    let totalSize = 0;
    const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

    req.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_SIZE) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      const buffer = Buffer.concat(chunks);
      const parsed = parseMultipart(buffer, boundary);

      if (!parsed || !parsed.filename) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'No file found in upload' }));
        return;
      }

      const ext = parsed.filename.split('.').pop().toLowerCase();
      if (!['txt', 'md', 'pdf'].includes(ext)) {
        res.statusCode = 415;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Unsupported file type: .${ext}` }));
        return;
      }

      try {
        const result = await ragEngine.indexDocument(parsed.filename, parsed.data);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (e) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: e.message }));
      }
    });

    req.on('error', () => {
      res.statusCode = 413;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'File too large (max 10MB)' }));
    });
    return;
  }

  // --- POST /api/chat ---
  if (req.method === 'POST' && req.url === '/api/chat') {
    const bodyChunks = [];

    req.on('data', (chunk) => {
      bodyChunks.push(chunk);
    });

    req.on('end', async () => {
      try {
        const buf = Buffer.concat(bodyChunks);
        const body = safeDecode(buf);
        const requestData = JSON.parse(body);
        const { messages, rag } = requestData;

        console.log('收到请求, RAG:', rag?.enabled ? 'ON' : 'OFF');

        const ragEnabled = rag?.enabled && ragEngine.listDocuments().length > 0;

        if (ragEnabled) {
          const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
          const query = lastUserMsg?.content || '';

          if (query) {
            const retrievedChunks = await ragEngine.retrieve(query);
            console.log(`检索到 ${retrievedChunks.length} 个相关片段`);

            const augmentedMessages = ragEngine.buildMessages(messages, retrievedChunks);
            const sources = ragEngine.buildSources(retrievedChunks);
            handleStreamRequest(augmentedMessages, res, sources);
            return;
          }
        }

        handleStreamRequest(messages, res, null);
      } catch (error) {
        console.error('解析请求体错误:', error);
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: '请求格式错误' }));
      }
    });
    return;
  }

  // --- GET /health ---
  if (req.method === 'GET' && req.url === '/health') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', message: 'AI Chat API is running', ragDocs: ragEngine.listDocuments().length }));
    return;
  }

  res.statusCode = 404;
  res.end();
});

function handleStreamRequest(messages, res, sources) {
  const requestBody = {
    model: 'xop35qwen2b',
    messages,
    max_tokens: 4000,
    temperature: 0.7,
    stream: true,
  };

  const options = {
    hostname: 'maas-api.cn-huabei-1.xf-yun.com',
    port: 443,
    path: '/v2/chat/completions',
    method: 'POST',
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      'User-Agent': 'Node.js-Client',
      Accept: '*/*',
    },
  };

  console.log('发送到MaaS的请求体大小:', JSON.stringify(requestBody).length, 'bytes');

  const maasReq = https.request(options, (maasRes) => {
    console.log('MaaS API 响应状态码:', maasRes.statusCode);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (sources && sources.length > 0) {
      // Intercept SSE stream to inject sources before [DONE]
      let sseBuf = '';
      maasRes.on('data', (chunk) => {
        sseBuf += chunk.toString();
        const lines = sseBuf.split('\n');
        sseBuf = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ') && line.includes('[DONE]')) {
            res.write(`data: ${JSON.stringify({ type: 'sources', sources })}\n\n`);
          }
          res.write(line + '\n');
        }
      });

      maasRes.on('end', () => {
        if (sseBuf) res.write(sseBuf);
        res.end();
        console.log('RAG response ended with sources');
      });
    } else {
      // Legacy transparent pipe (no RAG)
      maasRes.pipe(res);
    }

    maasRes.on('end', () => {
      console.log('响应结束');
    });
  });

  maasReq.on('error', (error) => {
    console.error('请求错误:', error);
    res.write(`data: {"error": "流式请求失败：${error.message}"} \n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  maasReq.on('timeout', () => {
    console.error('请求超时');
    maasReq.destroy();
    res.write('data: {"error": "请求超时"} \n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  maasReq.write(JSON.stringify(requestBody));
  maasReq.end();

  console.log('请求已发送');
}

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
