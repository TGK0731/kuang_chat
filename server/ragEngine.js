import https from 'https';

// ---------------------------------------------------------------------------
// 1. Tokenizer (Chinese + English)
// ---------------------------------------------------------------------------
const CJK_RE = /[一-鿿]/;
const ALNUM_RE = /[a-z0-9]/;

function tokenize(text) {
  const lower = text.toLowerCase();
  const tokens = [];
  let cjkRun = '';
  let wordRun = '';

  const flushCjk = () => {
    if (!cjkRun) return;
    // Unigrams: individual characters
    for (const ch of cjkRun) tokens.push(ch);
    // Bigrams: consecutive pairs
    for (let i = 0; i < cjkRun.length - 1; i++) {
      tokens.push(cjkRun[i] + cjkRun[i + 1]);
    }
    cjkRun = '';
  };

  const flushWord = () => {
    if (wordRun.length >= 2) tokens.push(wordRun);
    wordRun = '';
  };

  for (const ch of lower) {
    if (CJK_RE.test(ch)) {
      flushWord();
      cjkRun += ch;
    } else if (ALNUM_RE.test(ch)) {
      flushCjk();
      wordRun += ch;
    } else {
      flushCjk();
      flushWord();
    }
  }
  flushCjk();
  flushWord();

  return tokens;
}

// ---------------------------------------------------------------------------
// 2. Document Parser
// ---------------------------------------------------------------------------
export function parseDocument(filename, buffer) {
  const ext = filename.split('.').pop().toLowerCase();
  if (ext === 'txt' || ext === 'md') return buffer.toString('utf-8');
  if (ext === 'pdf') throw new Error('PDF support requires pdf-parse. Run: npm install pdf-parse');
  throw new Error(`Unsupported file type: .${ext}`);
}

// ---------------------------------------------------------------------------
// 3. Text Chunker (paragraph/sentence-aware)
// ---------------------------------------------------------------------------
export function chunkText(text, { chunkSize = 600, overlap = 100 } = {}) {
  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const merged = [];
  let buf = '';

  for (const p of paragraphs) {
    if (buf.length + p.length < chunkSize) {
      buf = buf ? `${buf}\n\n${p}` : p;
    } else {
      if (buf) merged.push(buf);
      buf = p;
    }
  }
  if (buf) merged.push(buf);

  const chunks = [];
  const splitRe = /(?<=[.。!?！？\n])\s*/;

  for (const block of merged) {
    if (block.length <= chunkSize) {
      chunks.push(block);
      continue;
    }
    const sentences = block.split(splitRe).filter(Boolean);
    let piece = '';
    for (const s of sentences) {
      if (piece.length + s.length > chunkSize && piece.length > 0) {
        chunks.push(piece.trim());
        piece = s;
      } else {
        piece = piece ? `${piece} ${s}` : s;
      }
    }
    if (piece.trim()) chunks.push(piece.trim());
  }

  // Add overlap
  if (overlap > 0 && chunks.length > 1) {
    const result = [chunks[0]];
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      if (prev.length > overlap) {
        result.push(prev.slice(-overlap) + '\n\n' + chunks[i]);
      } else {
        result.push(chunks[i]);
      }
    }
    return result;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// 4. BM25 Index
// ---------------------------------------------------------------------------
export class BM25Index {
  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.chunks = [];            // { id, filename, text }
    this.docFreq = new Map();    // term -> number of docs containing it
    this.termFreqs = [];         // per-doc Map<term, count>
    this.docLengths = [];        // per-doc token count
    this.totalDocs = 0;
    this.avgdl = 0;
  }

  addDocuments(filename, texts) {
    const startIdx = this.chunks.length;
    for (let i = 0; i < texts.length; i++) {
      const tokens = tokenize(texts[i]);
      const tf = new Map();
      for (const t of tokens) {
        tf.set(t, (tf.get(t) || 0) + 1);
      }
      this.chunks.push({ id: startIdx + i, filename, text: texts[i] });
      this.termFreqs.push(tf);
      this.docLengths.push(tokens.length);
      this.totalDocs++;
    }

    // Update docFreq and avgdl
    let totalLen = 0;
    for (let i = 0; i < this.termFreqs.length; i++) {
      totalLen += this.docLengths[i];
    }
    this.avgdl = totalLen / this.totalDocs;

    // Rebuild docFreq (simpler than incremental for MVP)
    this.docFreq.clear();
    for (const tf of this.termFreqs) {
      for (const term of tf.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) || 0) + 1);
      }
    }
  }

  removeDocument(filename) {
    const indices = [];
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      if (this.chunks[i].filename === filename) indices.push(i);
    }
    if (indices.length === 0) return 0;

    for (const idx of indices) {
      this.chunks.splice(idx, 1);
      this.termFreqs.splice(idx, 1);
      this.docLengths.splice(idx, 1);
      this.totalDocs--;
    }

    // Rebuild docFreq and avgdl
    this.docFreq.clear();
    let totalLen = 0;
    for (const tf of this.termFreqs) {
      for (const term of tf.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) || 0) + 1);
      }
      totalLen += [...tf.values()].reduce((a, b) => a + b, 0);
    }
    this.avgdl = this.totalDocs > 0 ? totalLen / this.totalDocs : 0;
    return indices.length;
  }

  search(query, k = 20) {
    if (this.totalDocs === 0) return [];
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scores = [];
    for (let i = 0; i < this.chunks.length; i++) {
      let score = 0;
      const tf = this.termFreqs[i];
      const dl = this.docLengths[i];

      for (const qt of queryTokens) {
        const n = this.docFreq.get(qt);
        if (!n) continue;
        const f = tf.get(qt) || 0;
        if (f === 0) continue;
        const idf = Math.log((this.totalDocs - n + 0.5) / (n + 0.5) + 1);
        const numerator = f * (this.k1 + 1);
        const denominator = f + this.k1 * (1 - this.b + this.b * (dl / this.avgdl));
        score += idf * (numerator / denominator);
      }
      if (score > 0) scores.push({ idx: i, score });
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, k).map(({ idx, score }) => ({
      chunk: this.chunks[idx],
      score,
    }));
  }

  listDocuments() {
    const seen = new Map();
    for (const c of this.chunks) {
      seen.set(c.filename, (seen.get(c.filename) || 0) + 1);
    }
    return [...seen.entries()].map(([filename, count]) => ({ filename, chunkCount: count }));
  }

  serialize() {
    return {
      chunks: this.chunks,
      docFreq: [...this.docFreq],
      termFreqs: this.termFreqs.map((m) => [...m]),
      docLengths: this.docLengths,
      totalDocs: this.totalDocs,
      avgdl: this.avgdl,
    };
  }

  static deserialize(data) {
    const idx = new BM25Index();
    idx.chunks = data.chunks;
    idx.docFreq = new Map(data.docFreq);
    idx.termFreqs = data.termFreqs.map((e) => new Map(e));
    idx.docLengths = data.docLengths;
    idx.totalDocs = data.totalDocs;
    idx.avgdl = data.avgdl;
    return idx;
  }
}

// ---------------------------------------------------------------------------
// 5. Embeddings Provider (abstraction + MaaS probe)
// ---------------------------------------------------------------------------
export class EmbeddingsProvider {
  async embed(texts) {
    throw new Error('Not implemented');
  }
}

export class MaaSEmbeddingsProvider extends EmbeddingsProvider {
  constructor(apiKey, endpoint, model) {
    super();
    this.apiKey = apiKey;
    this.endpoint = endpoint; // { hostname, path }
    this.model = model;
  }

  async embed(texts) {
    const body = JSON.stringify({ model: this.model, input: texts });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: this.endpoint.hostname,
          port: 443,
          path: this.endpoint.path,
          method: 'POST',
          timeout: 15000,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.error) return reject(new Error(json.error.message || 'Embedding error'));
              const embeddings = json.data?.map((d) => d.embedding) || [];
              resolve(embeddings);
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Embedding timeout')); });
      req.write(body);
      req.end();
    });
  }
}

export async function probeEmbeddings(apiKey) {
  const endpoints = ['/v1/embeddings', '/v2/embeddings'];

  for (const path of endpoints) {
    try {
      const result = await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'maas-api.cn-huabei-1.xf-yun.com',
            port: 443,
            path,
            method: 'POST',
            timeout: 8000,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
          },
          (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => {
              if (res.statusCode === 200 || res.statusCode === 201) {
                try {
                  const json = JSON.parse(d);
                  resolve({ path, model: json.model, dimension: json.data?.[0]?.embedding?.length });
                } catch {
                  reject(new Error('Invalid JSON'));
                }
              } else {
                reject(new Error(`HTTP ${res.statusCode}`));
              }
            });
          }
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(JSON.stringify({ model: 'xop35qwen2b', input: ['test'] }));
        req.end();
      });
      return new MaaSEmbeddingsProvider(apiKey, { hostname: 'maas-api.cn-huabei-1.xf-yun.com', path }, result.model);
    } catch {
      // try next endpoint
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 6. Hybrid Retriever
// ---------------------------------------------------------------------------
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, nA = 0, nB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    nA += a[i] * a[i];
    nB += b[i] * b[i];
  }
  const denom = Math.sqrt(nA) * Math.sqrt(nB);
  return denom === 0 ? 0 : dot / denom;
}

export async function retrieveChunks(query, bm25Index, embeddingsProvider, topK = 5) {
  const bm25Results = bm25Index.search(query, 20);
  if (bm25Results.length === 0) return [];

  if (!embeddingsProvider || bm25Results.length <= topK) {
    return bm25Results.slice(0, topK);
  }

  try {
    const queryVecs = await embeddingsProvider.embed([query]);
    const queryVec = queryVecs[0];
    if (!queryVec) return bm25Results.slice(0, topK);

    const texts = bm25Results.map((r) => r.chunk.text);
    const chunkVecs = await embeddingsProvider.embed(texts);

    const maxBm25 = bm25Results[0].score || 1;
    const combined = bm25Results.map((r, i) => {
      const semScore = cosineSimilarity(queryVec, chunkVecs[i]);
      const normBm25 = r.score / maxBm25;
      return { ...r, score: semScore * 0.6 + normBm25 * 0.4 };
    });

    combined.sort((a, b) => b.score - a.score);
    return combined.slice(0, topK);
  } catch {
    return bm25Results.slice(0, topK);
  }
}

// ---------------------------------------------------------------------------
// 7. Prompt Builder
// ---------------------------------------------------------------------------
export function buildRagMessages(messages, retrievedChunks) {
  if (retrievedChunks.length === 0) {
    return [
      { role: 'system', content: 'You are a helpful assistant. The knowledge base does not contain relevant information for this query. Answer honestly and say you do not have enough information.' },
      ...messages,
    ];
  }

  const contextParts = retrievedChunks.map(({ chunk }, i) =>
    `[${i + 1}] Source: ${chunk.filename}\n"""${chunk.text}"""`
  );

  const systemPrompt =
    `You are a helpful AI assistant. Answer the user's question using ONLY the provided context below.\n` +
    `You MUST cite your sources: after every sentence or fact drawn from the context, place a bracketed\n` +
    `citation marker like [1], [2], or [3] that matches the CONTEXT item number.\n\n` +
    `CONTEXT:\n${contextParts.join('\n\n')}\n\n` +
    `If the context does not contain enough information to answer, say so honestly.`;

  // Preserve existing system message if present, otherwise prepend
  const systemIdx = messages.findIndex((m) => m.role === 'system');
  if (systemIdx >= 0) {
    const newMessages = [...messages];
    newMessages[systemIdx] = { role: 'system', content: systemPrompt + '\n\n' + newMessages[systemIdx].content };
    return newMessages;
  }

  return [{ role: 'system', content: systemPrompt }, ...messages];
}

// ---------------------------------------------------------------------------
// 8. Convenience: build sources metadata for the frontend
// ---------------------------------------------------------------------------
export function buildSourcesPayload(retrievedChunks) {
  return retrievedChunks.map(({ chunk }, i) => ({
    index: i + 1,
    filename: chunk.filename,
    snippet: chunk.text.slice(0, 200),
  }));
}

// ---------------------------------------------------------------------------
// 9. Global RAG engine instance factory
// ---------------------------------------------------------------------------
export function createRagEngine(apiKey) {
  const bm25Index = new BM25Index();
  let embeddingsProvider = null;
  let probePromise = null;

  const ensureEmbeddings = async () => {
    if (probePromise) return probePromise;
    probePromise = probeEmbeddings(apiKey).then((p) => {
      embeddingsProvider = p;
      return p;
    }).catch(() => null);
    return probePromise;
  };

  const indexDocument = async (filename, buffer) => {
    const text = parseDocument(filename, buffer);
    const chunks = chunkText(text);
    bm25Index.addDocuments(filename, chunks);

    // If embeddings available, they're computed on-the-fly during retrieval
    // so no pre-computation needed here
    return { filename, chunkCount: chunks.length, hasEmbeddings: embeddingsProvider !== null };
  };

  return {
    bm25Index,
    getEmbeddingsProvider: () => embeddingsProvider,
    ensureEmbeddings,
    indexDocument,
    removeDocument: (filename) => bm25Index.removeDocument(filename),
    listDocuments: () => bm25Index.listDocuments(),
    retrieve: (query) => retrieveChunks(query, bm25Index, embeddingsProvider),
    buildMessages: buildRagMessages,
    buildSources: buildSourcesPayload,
  };
}
