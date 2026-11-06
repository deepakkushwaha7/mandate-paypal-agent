// Browser end-to-end test of the dashboard (Playwright + simulated PayPal).
// Run: npm run e2e
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { createApp } = require('../../src/server');

delete process.env.PAYPAL_CLIENT_ID;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

test('judge journey: tour, save PayPal, rules, run agent, receipt, undo, approve, stop all', async () => {
  const port = 4300 + Math.floor(Math.random() * 500);
  const { app, stop } = createApp({ port, baseUrl: `http://localhost:${port}`, sweepMs: 1000 });
  const server = app.listen(port);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text())) errors.push(m.text()); });
  try {
    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector('#welcome:not([hidden])');

    // Tour opens, steps through, and closes with Escape.
    await page.click('#welcome-tour');
    await page.waitForSelector('#tour:not([hidden])');
    assert.match(await page.textContent('#tour-step'), /Step 1 of 7/);
    await page.click('#tour-next');
    assert.match(await page.textContent('#tour-title'), /Save PayPal once/);
    await page.keyboard.press('Escape');
    assert.equal(await page.isHidden('#tour'), true);

    // Save PayPal (simulated approval page).
    await page.click('#connect');
    await page.waitForURL(/simulated-paypal/);
    await page.click('button[value=approve]');
    await page.waitForURL(/\/$|notice/);
    await page.waitForSelector('text=PayPal saved for agents');

    // Edit rules in plain English, preview, apply.
    await page.click('#edit-rules');
    await page.fill('#plain', 'Keep it under 3k a month and never more than €1,200 on one order. Anything below €400 you can just pay. Give me 90 seconds to undo.');
    await page.click('#parse');
    await page.waitForSelector('#apply');
    assert.match(await page.textContent('#diff'), /Monthly budget.*€2,500.*€3,000/s);
    await page.click('#apply');
    await page.waitForSelector('#rules-version >> text=Version 2');

    // Run the agent with an instruction.
    await page.fill('#instruction', 'Black Friday campaign starts in 2 weeks');
    await page.click('#run');
    await page.waitForSelector('#feed .finish', { timeout: 15000 });
    await page.waitForSelector('#card-inbox:not([hidden])');
    const feed = await page.textContent('#feed');
    assert.match(feed, /Paid automatically/);
    assert.match(feed, /Needs your OK/);
    assert.match(feed, /Blocked/);
    assert.doesNotMatch(feed, /MBX-S-KRAFT/); // plain names, not SKU codes

    // Decision receipt in the drawer explains the price rise.
    await page.locator('.ag-row', { hasText: 'Boxly' }).first().click();
    await page.waitForSelector('#drawer:not([hidden])');
    assert.match(await page.textContent('#d-body'), /went up 6\.9%/);
    await page.keyboard.press('Escape');
    assert.equal(await page.isHidden('#drawer'), true);

    // Undo an auto-paid order from the toast.
    const toastUndo = page.locator('.toast button', { hasText: 'Undo' }).first();
    await toastUndo.click();
    await page.waitForSelector('.toast >> text=Undone. No money moved.');

    // Approve a waiting order through the (simulated) PayPal approval page.
    await page.locator('#inbox [data-approve]').first().click();
    await page.waitForURL(/simulated-paypal/);
    await page.click('button[value=approve]');
    await page.waitForURL(/\/$|notice/);
    await page.waitForSelector('.badge >> text=On hold');

    // Stop all agents: confirmation, then paused banner.
    await page.click('#kill');
    await page.waitForSelector('#m-kill:not([hidden])');
    assert.match(await page.textContent('#kill-q'), /will be cancelled in PayPal/);
    await page.click('#kill-confirm');
    await page.waitForSelector('#paused:not([hidden])');
    assert.equal(await page.isDisabled('#run'), true);

    // Connect-an-agent dialog shows a per-workspace key.
    await page.click('#paused #resume');
    await page.waitForSelector('#paused', { state: 'hidden' });
    await page.click('#connect-agent');
    assert.match(await page.textContent('#mcp-config'), /"MANDATE_AGENT_KEY": "mk_/);
    await page.keyboard.press('Escape');

    // No horizontal scroll on a phone.
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth), true);

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
    stop();
  }
});
