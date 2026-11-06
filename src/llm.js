// One small interface over the model providers Mandate supports, so the
// agent loop and the mandate parser don't care which model runs them.
//
//   GEMINI_API_KEY     Google Gemini (free tier)      default model gemini-3.5-flash-lite
//   ANTHROPIC_API_KEY  Anthropic Claude                default model claude-sonnet-4-5
//   GROQ_API_KEY       Groq (OpenAI-compatible, free) default model llama-3.3-70b-versatile
//   LLM_MODEL          optional override for whichever provider is active
//
// chat({ system, messages, tools, forceTool }) -> { text, toolCalls: [{ id, name, input }], stop }
// messages are normalised:
//   { role: 'user', text }
//   { role: 'assistant', text, toolCalls }
//   { role: 'tool', results: [{ id, name, output }] }

const crypto = require('crypto');

function activeProvider(env = process.env) {
  if (env.LLM_PROVIDER) return env.LLM_PROVIDER;
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.GEMINI_API_KEY) return 'gemini';
  if (env.GROQ_API_KEY) return 'groq';
  return null;
}

const DEFAULT_MODEL = { anthropic: 'claude-sonnet-4-5', gemini: 'gemini-3.5-flash-lite', groq: 'llama-3.3-70b-versatile' };
const LABEL = { anthropic: 'Claude', gemini: 'Gemini', groq: 'Llama on Groq', replay: 'Gemini' };

function modelFor(p, env = process.env) {
  if (p === 'replay') return env.LLM_REPLAY_MODEL || 'gemini (recorded run)';
  return env.LLM_MODEL || (p === 'anthropic' && env.ANTHROPIC_MODEL) || DEFAULT_MODEL[p];
}

async function postJson(url, headers, body, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`Model request failed (504): no answer within ${Math.round(timeoutMs / 1000)}s`);
      throw new Error(`Model request failed (502): ${e.message}`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (json.error && (json.error.message || json.error.type)) || res.statusText;
      throw new Error(`Model request failed (${res.status}): ${msg}`);
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

// ---- Anthropic ----
async function anthropicChat({ system, messages, tools, forceTool }, env) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const msgs = messages.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.text };
    if (m.role === 'assistant') {
      const content = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls || []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
      return { role: 'assistant', content };
    }
    return { role: 'user', content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.output) })) };
  });
  const res = await client.messages.create({
    model: modelFor('anthropic', env),
    max_tokens: 2000,
    system,
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    tool_choice: forceTool ? { type: 'tool', name: forceTool } : undefined,
    messages: msgs,
  });
  return {
    text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
    toolCalls: res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input })),
    stop: res.stop_reason === 'tool_use' ? 'tool' : 'end',
  };
}

// ---- Gemini ----
// Free-tier models are sometimes overloaded (503) or rate limited (429), and
// Google retires names (404 that names the replacement). Try the configured
// model, then a chain of fallbacks, and stick to whichever worked for a while.
const GEMINI_FALLBACKS = ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-flash-latest'];
const GEMINI_TIMEOUT_MS = 15000;
const RETRYABLE = /\((404|429|500|502|503|504)\)/;
const STICKY_MS = 10 * 60 * 1000;
let geminiModel = null;
let geminiStickyUntil = 0;

async function geminiWithFallback(body, env) {
  const primary = modelFor('gemini', env);
  const extra = (env.GEMINI_FALLBACK_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const chain = [];
  const add = (m) => { if (m && !chain.includes(m)) chain.push(m); };
  if (geminiModel && Date.now() < geminiStickyUntil) add(geminiModel);
  add(primary);
  (extra.length ? extra : GEMINI_FALLBACKS).forEach(add);
  let lastError;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      const json = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': env.GEMINI_API_KEY }, body, Number(env.GEMINI_TIMEOUT_MS) || GEMINI_TIMEOUT_MS);
      if (model !== primary) {
        if (geminiModel !== model) console.warn(`[llm] using ${model} while ${primary} is unavailable`);
        geminiModel = model;
        geminiStickyUntil = Date.now() + STICKY_MS;
      } else {
        geminiModel = null;
      }
      return json;
    } catch (e) {
      lastError = e;
      if (!RETRYABLE.test(e.message)) throw e;
      const replacement = /\(404\)/.test(e.message) && (e.message.match(/models\/([\w.-]+)\s+for/) || [])[1];
      if (replacement && !chain.includes(replacement)) chain.splice(i + 1, 0, replacement);
    }
  }
  throw lastError;
}
function geminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties' || k === '$schema') continue;
    if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, geminiSchema(pv)]));
    else if (k === 'items') out.items = geminiSchema(v);
    else out[k] = v;
  }
  return out;
}

async function geminiChat({ system, messages, tools, forceTool }, env) {
  const contents = messages.map((m) => {
    if (m.role === 'user') return { role: 'user', parts: [{ text: m.text }] };
    if (m.role === 'assistant') {
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls || []) parts.push({ functionCall: { name: c.name, args: c.input || {} }, ...(c.signature ? { thoughtSignature: c.signature } : {}) });
      return { role: 'model', parts };
    }
    return { role: 'user', parts: m.results.map((r) => ({ functionResponse: { name: r.name, response: { result: r.output } } })) };
  });
  const functionDeclarations = tools.map((t) => {
    const d = { name: t.name, description: t.description };
    if (t.parameters && t.parameters.properties && Object.keys(t.parameters.properties).length) d.parameters = geminiSchema(t.parameters);
    return d;
  });
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    tools: [{ functionDeclarations }],
    toolConfig: { functionCallingConfig: forceTool ? { mode: 'ANY', allowedFunctionNames: [forceTool] } : { mode: 'AUTO' } },
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  };
  const json = await geminiWithFallback(body, env);
  const parts = (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || [];
  const toolCalls = parts.filter((p) => p.functionCall).map((p) => ({ id: crypto.randomUUID(), name: p.functionCall.name, input: p.functionCall.args || {}, signature: p.thoughtSignature }));
  return {
    text: parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('\n').trim(),
    toolCalls,
    stop: toolCalls.length ? 'tool' : 'end',
  };
}

// ---- Groq (OpenAI-compatible) ----
async function openaiCompatChat({ system, messages, tools, forceTool }, env) {
  const msgs = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') msgs.push({ role: 'user', content: m.text });
    else if (m.role === 'assistant') {
      msgs.push({
        role: 'assistant',
        content: m.text || null,
        tool_calls: (m.toolCalls || []).map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) } })),
      });
    } else for (const r of m.results) msgs.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.output) });
  }
  for (const m of msgs) if (m.tool_calls && !m.tool_calls.length) delete m.tool_calls;
  const json = await postJson('https://api.groq.com/openai/v1/chat/completions', { Authorization: `Bearer ${env.GROQ_API_KEY}` }, {
    model: modelFor('groq', env),
    messages: msgs,
    tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    tool_choice: forceTool ? { type: 'function', function: { name: forceTool } } : 'auto',
    temperature: 0.2,
  });
  const msg = json.choices[0].message;
  const toolCalls = (msg.tool_calls || []).map((c) => {
    let input = {};
    try {
      input = JSON.parse(c.function.arguments || '{}');
    } catch {
      input = {};
    }
    return { id: c.id, name: c.function.name, input };
  });
  return { text: (msg.content || '').trim(), toolCalls, stop: toolCalls.length ? 'tool' : 'end' };
}

// Replays a captured model session (LLM_PROVIDER=replay, LLM_REPLAY_FILE=...).
// Used to re-record demos offline with the exact responses a live model gave.
let replay = null;
function replayChat(req, env) {
  if (!replay) {
    replay = JSON.parse(require('fs').readFileSync(env.LLM_REPLAY_FILE, 'utf8'));
    replay.cursor = 0;
  }
  if (req.forceTool === 'set_mandate') return { text: '', toolCalls: [{ id: 'r-parse', name: 'set_mandate', input: replay.parse }], stop: 'tool' };
  if (req.messages.length === 1) replay.cursor = 0;
  const turn = replay.agent[replay.cursor++] || { text: 'Done.', toolCalls: [{ id: 'r-end', name: 'finish', input: { summary: 'Done.' } }] };
  return { text: turn.text || '', toolCalls: (turn.toolCalls || []).map((c, i) => ({ id: `r-${replay.cursor}-${i}`, ...c })), stop: 'tool' };
}

async function chat(req, env = process.env) {
  const p = activeProvider(env);
  if (p === 'replay') return replayChat(req, env);
  if (p === 'anthropic') return anthropicChat(req, env);
  if (p === 'gemini') return geminiChat(req, env);
  if (p === 'groq') return openaiCompatChat(req, env);
  throw new Error('No AI model is configured.');
}

function describe(env = process.env) {
  const p = activeProvider(env);
  return p ? { provider: p, label: LABEL[p], model: (p === 'gemini' && geminiModel && Date.now() < geminiStickyUntil && geminiModel) || modelFor(p, env) } : null;
}

// Clears the remembered fallback model (used by tests).
function resetModelMemory() {
  geminiModel = null;
  geminiStickyUntil = 0;
}

module.exports = { chat, activeProvider, describe, geminiSchema, resetModelMemory };
