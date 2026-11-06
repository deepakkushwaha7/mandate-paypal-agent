const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../src/store');
const { runAgent } = require('../src/agent');
const llm = require('../src/llm');

test('model agent loop: reads, self-corrects a blocked order, finishes', async () => {
  const store = new Store(null);
  store.state.mandate.vaultId = 'V';
  const script = [
    { text: 'Checking stock first.', toolCalls: [{ id: '1', name: 'get_stock', input: {} }, { id: '2', name: 'get_mandate', input: {} }], stop: 'tool' },
    { text: '', toolCalls: [{ id: '3', name: 'submit_order', input: { lines: [{ sku: 'TIS-A3-GOLD', qty: 1250, reason: 'low' }], note: 'Tissue' } }], stop: 'tool' },
    { text: 'Pack size is 500, rounding up.', toolCalls: [{ id: '4', name: 'submit_order', input: { lines: [{ sku: 'TIS-A3-GOLD', qty: 1500, reason: 'low' }], note: 'Tissue' } }], stop: 'tool' },
    { text: '', toolCalls: [{ id: '5', name: 'finish', input: { summary: 'Ordered tissue paper.' } }], stop: 'tool' },
  ];
  const seen = [];
  const chat = async (req) => {
    seen.push(req.messages.length);
    return script.shift();
  };
  const steps = [];
  const proposals = [];
  const r = await runAgent({ state: store.state, instruction: '', emit: (s) => steps.push(s), onProposal: (v) => proposals.push(v.decision), chat, model: { provider: 'gemini', label: 'Gemini', model: 'test' } });
  assert.equal(r.summary, 'Ordered tissue paper.');
  assert.deepEqual(proposals, ['blocked', 'auto']);
  assert.deepEqual(seen, [1, 3, 5, 7]); // user, then assistant+tool results each turn
  assert.ok(steps.some((s) => s.kind === 'thought' && /Pack size/.test(s.text)));
});

test('model outage before any proposal falls back to the built-in planner', async () => {
  const store = new Store(null);
  const steps = [];
  const proposals = [];
  await runAgent({ state: store.state, instruction: '', emit: (s) => steps.push(s), onProposal: (v) => proposals.push(v), chat: async () => { throw new Error('quota exceeded'); }, model: { provider: 'gemini', label: 'Gemini', model: 'x' } });
  assert.ok(steps.some((s) => /unavailable/.test(s.text || '')));
  assert.equal(proposals.length, 4);
});

test('Gemini adapter: request shape and function-call parsing', async () => {
  const realFetch = global.fetch;
  let sent;
  global.fetch = async (url, opts) => {
    sent = { url, headers: opts.headers, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }, { functionCall: { name: 'set_mandate', args: { monthlyCap: 3000 } } }] } }] }) };
  };
  try {
    const env = { GEMINI_API_KEY: 'k', LLM_MODEL: 'gemini-test-model' };
    const tools = [{ name: 'noop', description: 'x', parameters: { type: 'object', properties: {} } }, { name: 'set_mandate', description: 'y', parameters: { type: 'object', properties: { monthlyCap: { type: 'number' } }, additionalProperties: false } }];
    const r = await llm.chat({ system: 'sys', messages: [{ role: 'user', text: 'hi' }], tools, forceTool: 'set_mandate' }, env);
    assert.match(sent.url, /models\/gemini-test-model:generateContent$/);
    assert.equal(sent.headers['x-goog-api-key'], 'k');
    assert.equal(sent.body.toolConfig.functionCallingConfig.mode, 'ANY');
    assert.equal(sent.body.tools[0].functionDeclarations[0].parameters, undefined);
    assert.equal(sent.body.tools[0].functionDeclarations[1].parameters.additionalProperties, undefined);
    assert.equal(r.toolCalls[0].name, 'set_mandate');
    assert.equal(r.toolCalls[0].input.monthlyCap, 3000);
    assert.equal(r.stop, 'tool');
  } finally {
    global.fetch = realFetch;
  }
});

test('provider selection', () => {
  assert.equal(llm.activeProvider({}), null);
  assert.equal(llm.activeProvider({ GEMINI_API_KEY: 'x' }), 'gemini');
  assert.equal(llm.activeProvider({ GROQ_API_KEY: 'x' }), 'groq');
  assert.equal(llm.activeProvider({ GEMINI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }), 'anthropic');
});

test('Gemini adapter follows a retired-model 404 to the suggested model', async () => {
  const realFetch = global.fetch;
  const urls = [];
  global.fetch = async (url) => {
    urls.push(url);
    if (urls.length === 1) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: { message: 'This model models/old-flash is no longer available to new users. Please update your code to use models/new-flash for the latest features.' } }) };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }) };
  };
  try {
    const r = await llm.chat({ system: 's', messages: [{ role: 'user', text: 'x' }], tools: [] }, { GEMINI_API_KEY: 'k', LLM_MODEL: 'old-flash' });
    assert.equal(r.text, 'hi');
    assert.match(urls[1], /models\/new-flash:generateContent/);
  } finally {
    global.fetch = realFetch;
  }
});
