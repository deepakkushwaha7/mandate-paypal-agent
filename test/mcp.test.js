const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { createApp } = require('../src/server');
const { Store } = require('../src/store');

test('MCP: an external agent buys through the mandate', async () => {
  delete process.env.PAYPAL_CLIENT_ID;
  const { app, store, stop } = createApp({ store: new Store(null), baseUrl: 'http://127.0.0.1:0', sweepMs: 60000 });
  store.state.mandate.vaultId = 'VAULT-MCP';
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'src', 'mcp.js')], env: { ...process.env, MANDATE_URL: url } }));
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['check_purchase', 'get_order_status', 'get_spending_mandate', 'purchase']);
    const ctx = await client.callTool({ name: 'get_spending_mandate', arguments: {} });
    assert.match(ctx.content[0].text, /Claude Desktop/);
    const ok = await client.callTool({ name: 'purchase', arguments: { lines: [{ sku: 'LBL-BAG-250', qty: 2000 }], note: 'Labels' } });
    assert.match(ok.content[0].text, /Paid via PayPal/);
    const bad = await client.callTool({ name: 'purchase', arguments: { lines: [{ sku: 'TOTE-CANVAS', qty: 100 }], note: 'Totes' } });
    assert.match(bad.content[0].text, /Blocked by the spending mandate/);
    assert.match(bad.content[0].text, /Approved supplier/);
  } finally {
    await client.close();
    server.close();
    stop();
  }
});
