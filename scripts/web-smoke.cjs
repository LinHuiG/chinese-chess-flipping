// Run against a local development server: NODE_PATH=<playwright installation> node scripts/web-smoke.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
  const url = process.env.CHESS_WEB_URL || 'http://127.0.0.1';
  const out = path.resolve(__dirname, '../server/target/web-checks');
  fs.mkdirSync(out, { recursive: true });
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
  const errors = [];
  const host = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const guest = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const page of [host, guest]) {
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  }
  try {
    await Promise.all([host.goto(url), guest.goto(url)]);
    await host.locator('#lobby').waitFor({ state: 'visible' });
    await guest.locator('#lobby').waitFor({ state: 'visible' });
    await host.waitForFunction(() => /服务器 \d+ ms/.test(document.querySelector('#server-latency').textContent));
    assert.equal(await host.locator('#network-metrics').isVisible(), true);
    await host.screenshot({ path: path.join(out, 'desktop-lobby.png'), fullPage: true });
    await host.click('#settings-open'); await host.fill('#nickname','测试房主'); await host.click('#nickname-save'); await host.locator('#settings-dialog .primary').click();
    await host.click('#create-open'); assert.equal(await host.inputValue('#room-name'),'测试房主的房间'); await host.fill('#room-name', '网页跨端联调'); await host.click('#create-form button[type=submit]');
    await host.locator('#waiting').waitFor({ state: 'visible' });
    await guest.click('#lobby-refresh'); await guest.locator('.room-item').filter({ hasText: '网页跨端联调' }).getByRole('button', { name: '加入' }).click();
    await guest.locator('#waiting').waitFor({ state: 'visible' });
    await host.locator('[data-seconds="0"]').click();
    await guest.locator('[data-seconds="0"].active').waitFor();
    await host.screenshot({ path: path.join(out, 'desktop-waiting.png'), fullPage: true });
    await host.click('#ready'); await guest.click('#ready');
    await Promise.all([host.locator('#game').waitFor({ state: 'visible' }), guest.locator('#game').waitFor({ state: 'visible' })]);
    await host.locator('.cell[data-value="99"]').first().waitFor();
    for (let i = 0; i < 4; i++) {
      const actor = (await host.locator('#turn').textContent()) === '轮到你了' ? host : guest;
      await actor.locator('.cell[data-value="99"]').first().click();
      await Promise.all([host.waitForFunction(n => document.querySelectorAll('.cell[data-value="99"]').length === n, 31 - i),
        guest.waitForFunction(n => document.querySelectorAll('.cell[data-value="99"]').length === n, 31 - i)]);
    }
    assert.deepEqual(await host.locator('.cell').evaluateAll(cells => cells.map(c => c.dataset.value)),
      await guest.locator('.cell').evaluateAll(cells => cells.map(c => c.dataset.value)));
    const saved = await host.evaluate(() => JSON.parse(sessionStorage.getItem('chess.session.v2')));
    const before = await guest.locator('.cell').evaluateAll(c => c.map(x => x.dataset.value));
    await guest.context().setOffline(true);
    await host.waitForFunction(() => /重连中|连接异常/.test(document.querySelector('#peer-status').textContent));
    await guest.context().setOffline(false);
    await guest.reload();
    await guest.waitForFunction(() => document.querySelector('#peer-status').textContent.endsWith('在线'));
    assert.deepEqual(await guest.locator('.cell').evaluateAll(c => c.map(x => x.dataset.value)), before);
    await host.reload();
    await host.waitForFunction(() => !document.querySelector('#game').hidden && document.querySelector('#peer-status').textContent.endsWith('在线'));
    await host.waitForFunction(() => document.querySelectorAll('.cell[data-value="99"]').length === 28);
    const restored = await host.evaluate(() => JSON.parse(sessionStorage.getItem('chess.session.v2')));
    assert.equal(restored.self, saved.self, 'Refresh preserves user ID');
    assert.deepEqual(restored.referee.game.pieces, saved.referee.game.pieces, 'Hidden board survives host refresh');
    assert.deepEqual(restored.referee.game.history, saved.referee.game.history, 'History survives host refresh');
    assert.equal(restored.referee.move, saved.referee.move);
    await host.screenshot({ path: path.join(out, 'desktop-game.png'), fullPage: true });
    await guest.screenshot({ path: path.join(out, 'mobile-game.png'), fullPage: true });
    assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile horizontal overflow');
    await guest.setViewportSize({ width: 844, height: 390 });
    await guest.screenshot({ path: path.join(out, 'mobile-landscape.png'), fullPage: true });
    assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Landscape horizontal overflow');
    await guest.click('#settings-open'); await guest.locator('#motion').uncheck(); await guest.locator('#sound').uncheck();
    await guest.locator('#settings-dialog .primary').click();
    await host.click('#rules-open'); await host.waitForFunction(() => document.querySelector('#rules-body').textContent.includes('禁止重复棋面'));
    await host.locator('#rules-dialog .dialog-close').click();
    await guest.locator('#game .leave').click(); await guest.click('#confirm-ok');
    await host.locator('#outcome-dialog').waitFor({ state: 'visible' });
    assert.equal(await host.locator('#outcome-title').textContent(), '你赢了');
    await host.screenshot({ path: path.join(out, 'desktop-victory.png'), fullPage: true });
    await host.locator('#outcome-dialog .dialog-close').click();
    await host.locator('#waiting .dissolve').click(); await host.click('#confirm-ok');
    await host.locator('#lobby').waitFor({ state: 'visible' });
    assert.deepEqual(errors, [], 'Browser errors');
    console.log(JSON.stringify({ result: 'PASS', checks: ['two browser sessions', 'room join', 'time sync', 'ready/start', 'four alternating flips', 'matching boards', 'disconnect gray status', 'guest reconnect', 'host refresh private board/history', 'nickname', 'mobile/landscape layout', 'settings', 'rules', 'leave loses', 'dissolve'], screenshots: out }));
  } catch (error) {
    console.error('host:', await host.locator('body').innerText());
    console.error('guest:', await guest.locator('body').innerText());
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
