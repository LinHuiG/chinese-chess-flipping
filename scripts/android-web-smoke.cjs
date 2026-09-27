// Requires an emulator already hosting the waiting room "Android-smoke" with unlimited turn time.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const serial = process.env.CHESS_ANDROID_SERIAL || 'emulator-5554';
const adb = path.join(process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA, 'Android/Sdk'), 'platform-tools/adb.exe');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'server/target/web-checks');
const shell = (...args) => execFileSync(adb, ['-s', serial, 'shell', ...args], { encoding: 'utf8' });
function ui(action, text) {
  return execFileSync('pwsh', ['-NoProfile', '-File', path.join(__dirname, 'android-ui.ps1'), '-Serial', serial, '-Action', action,
    ...(text ? ['-Text', text] : [])], { encoding: 'utf8' }).trim();
}
function tapCell(index) {
  const nodes = JSON.parse(ui('Inspect'));
  assert(nodes.some(n => n.text === '你的回合'));
  const board = nodes.find(n => n['content-desc']?.includes('四列八行'));
  assert(board, 'Android board visible');
  const [x1, y1, x2, y2] = board.bounds.match(/\d+/g).map(Number), w = x2 - x1, h = y2 - y1;
  const density = Number(shell('wm', 'density').match(/(\d+)\s*$/)[1]) / 160;
  const side = Math.min(52 * density, w * .16), cell = Math.min((w - 2 * side - 16 * density) / 4, (h - 16 * density) / 8);
  const left = (w - 4 * cell) / 2, top = Math.max(0, (h - 8 * cell) / 2);
  shell('input', 'tap', String(Math.round(x1 + left + (index % 4 + .5) * cell)), String(Math.round(y1 + top + (Math.floor(index / 4) + .5) * cell)));
}
(async () => {
  let browser;
  try { browser = await chromium.launch({ headless: true }); } catch { browser = await chromium.launch({ headless: true, channel: 'msedge' }); }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(process.env.CHESS_WEB_URL || 'http://127.0.0.1');
    await page.locator('.room-item').filter({ hasText: 'Android-smoke' }).getByRole('button', { name: '加入' }).click();
    await page.locator('#ready').waitFor(); await page.click('#ready'); ui('Tap', '准备');
    await page.locator('#game').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('.cell[data-value="99"]').length === 32);
    for (let i = 0; i < 2; i++) {
      if ((await page.locator('#turn').textContent()) === '轮到你了') await page.locator('.cell').nth(i).click(); else tapCell(i);
      await page.waitForFunction(n => document.querySelectorAll('.cell[data-value="99"]').length === n, 31 - i);
    }
    assert(JSON.parse(ui('Inspect')).some(n => n.text === '你执红棋' || n.text === '你执黑棋'));
    await page.screenshot({ path: path.join(out, 'web-with-android.png'), fullPage: true });
    shell('screencap', '-p', '/sdcard/chess-web-smoke.png');
    execFileSync(adb, ['-s', serial, 'pull', '/sdcard/chess-web-smoke.png', path.join(out, 'android-with-web.png')]);
    await page.locator('#game .leave').click(); await page.click('#confirm-ok');
    await page.locator('#lobby').waitFor({ state: 'visible' });
    const end = JSON.parse(ui('Inspect')); assert(end.some(n => n.text === '你赢了'));
    ui('Tap', '继续'); ui('Tap', '解散房间'); ui('Tap', '解散');
    console.log(JSON.stringify({ result: 'PASS', checks: ['actual Android HTTP host', 'browser guest', 'ready/start', 'one flip on each device', 'colors assigned', 'guest leave / Android wins', 'room dissolved'] }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
