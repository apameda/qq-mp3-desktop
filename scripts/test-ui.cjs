/*
 * Optional renderer checks using a mock Electron bridge, not a Windows/Mac app test.
 * No project dependencies are installed or changed by this script.
 * Use an existing Playwright installation and an installed headless browser:
 *   PLAYWRIGHT_MODULE_PATH=/path/to/playwright CHROME_PATH=/path/to/chrome node scripts/test-ui.cjs
 * NODE_PATH can also locate Playwright. CHROME_PATH is optional when Chrome/Edge
 * is installed in a standard location or Playwright has a bundled browser.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright'));
} catch {
  console.error('Mock UI checks require an existing Playwright installation. Set PLAYWRIGHT_MODULE_PATH or NODE_PATH; no dependencies were installed.');
  process.exit(1);
}

function browserPath() {
  if (process.env.CHROME_PATH) {
    assert.ok(fs.existsSync(process.env.CHROME_PATH), 'CHROME_PATH does not exist');
    return process.env.CHROME_PATH;
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  ];
  return candidates.find(candidate => candidate && fs.existsSync(candidate));
}

async function checkFlacUi(page, apiName) {
  assert.match(await page.locator('.brand-copy p').innerText(), /也可直接转换 FLAC/);
  assert.match(await page.locator('#empty-add-files').innerText(), /FLAC/);
  assert.match(await page.locator('#drop-overlay').innerText(), /FLAC/);
  await page.evaluate(apiName => {
    const api = window[apiName];
    const flac = { id: 'direct-flac', name: '原创合成测试音.FLAC', path: '/mock/原创合成测试音.FLAC', size: 43000, status: 'pending', progress: 0, hasKey: false };
    api.chooseFiles = async () => { window.mockEmit({ type: 'queue', items: [flac] }); return [flac]; };
    api.getDropPaths = files => files.map(file => '/mock/' + file.name);
    api.addPaths = async paths => {
      window.mockAddedPaths = paths;
      const item = { ...flac, id: 'drop-flac', name: '拖放样本.flac', path: paths[0] };
      window.mockEmit({ type: 'queue', items: [item] });
      return [item];
    };
  }, apiName);
  await page.locator('#empty-add-files').click();
  assert.equal(await page.locator('.file-name').innerText(), '原创合成测试音.FLAC');
  assert.equal(await page.locator('.file-caption').innerText(), 'FLAC 音频 · 转换为 MP3');
  if (apiName === 'qqmp3') {
    assert.ok(await page.locator('.key-button').isDisabled(), 'Ordinary FLAC does not require a song key');
    assert.equal(await page.locator('.key-button').innerText(), '无需密钥');
  }
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['synthetic'], '拖放样本.flac', { type: 'audio/flac' }));
    document.getElementById('drop-area').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await page.waitForFunction(() => document.querySelector('.file-name')?.textContent === '拖放样本.flac');
  assert.deepEqual(await page.evaluate(() => window.mockAddedPaths), ['/mock/拖放样本.flac']);
  await page.locator('#start').click();
  assert.equal((await page.evaluate(() => window.lastStart)).bitrate, 320);
  assert.ok(await page.locator('#bitrate').isDisabled());
  await page.evaluate(() => {
    window.mockEmit({ type: 'item', item: { id: 'drop-flac', name: '拖放样本.flac', path: '/mock/拖放样本.flac', size: 43000, status: 'success', progress: 100, message: '320 kbps · 44.1 kHz', hasKey: false } });
    window.mockEmit({ type: 'batch', running: false, total: 1, completed: 1, success: 1, failed: 0, cancelled: 0 });
  });
  assert.match(await page.locator('#batch-detail').innerText(), /成功 1 个/);
  await page.setViewportSize({ width: 820, height: 620 });
  assert.deepEqual(await page.evaluate(() => ({ x: document.documentElement.scrollWidth > innerWidth, y: document.documentElement.scrollHeight > innerHeight })), { x: false, y: false });
  console.log('PASS FLAC-only mock UI: selection, drag/drop, uppercase extension label, 320 kbps settings, completion display, compact layout' + (apiName === 'qqmp3' ? ', no irrelevant song-key action.' : '.'));
}

(async () => {
  const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
    const screenshots = process.env.UI_SCREENSHOTS_DIR || (process.argv.includes('--screenshots') ? path.join(__dirname, '../docs/screenshots') : null);
    if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
    const screenshot = async name => {
      if (!screenshots) return;
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(screenshots, name + '.png') });
    };
    const errors = [];
    const network = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    await page.addInitScript(() => {
      const names = ['黄龄,邓典 - 月亮之下.qmc3', '陈奕迅 - 十年.mflac', '周杰伦 - 晴天.qmcflac', '邓紫棋 - 光年之外.mgg'];
      const items = names.map((name, i) => ({ id: String(i), name, path: 'D:\\音乐收藏\\' + name, size: (i + 1) * 8418821, status: 'pending', progress: 0, hasKey: false }));
      let queue = [];
      let batchIds = [];
      const songKeys = new Map();
      let callback = () => {};
      function emit(event) {
        if (event.type === 'item') { event.item = { ...event.item, hasKey: songKeys.has(event.item.id) }; queue = queue.map(item => item.id === event.item.id ? event.item : item); }
        if (event.type === 'queue') queue = event.items;
        callback(event);
      }
      window.mockEmit = emit;
      window.mockQueue = items;
      window.keyCalls = [];
      window.qqmp3 = {
        getSettings: async () => ({ outputDir: 'C:\\Users\\音乐爱好者\\Music\\QQ转MP3', bitrate: 320 }),
        onEvent: handler => { callback = handler; return () => {}; },
        chooseFiles: async () => queue = items.map(item => ({ ...item })),
        chooseFolder: async () => queue, addPaths: async () => queue,
        chooseOutput: async () => 'D:\\已转换的音乐',
        start: async settings => {
          window.lastStart = settings;
          batchIds = queue.filter(item => item.status !== 'success').map(item => item.id);
          emit({ type: 'queue', items: queue.map(item => batchIds.includes(item.id) ? { ...item, status: 'pending', progress: 0, error: '' } : item) });
          emit({ type: 'batch', running: true, total: batchIds.length, completed: 0, success: 0, failed: 0, cancelled: 0 });
        },
        cancel: async () => {
          emit({ type: 'queue', items: queue.map(item => batchIds.includes(item.id) && !['success', 'failed'].includes(item.status) ? { ...item, status: 'cancelled' } : item) });
          const current = queue.filter(item => batchIds.includes(item.id));
          emit({ type: 'batch', running: false, total: current.length, completed: current.length,
            success: current.filter(item => item.status === 'success').length,
            failed: current.filter(item => item.status === 'failed').length,
            cancelled: current.filter(item => item.status === 'cancelled').length });
        },
        clearCompleted: async () => { for (const item of queue) if (item.status === 'success') songKeys.delete(item.id); return queue = queue.filter(item => item.status !== 'success'); },
        removeItem: async id => { songKeys.delete(id); return queue = queue.filter(item => item.id !== id); },
        clearQueue: async () => { songKeys.clear(); return queue = []; }, openOutput: async () => {}, getDropPaths: () => [],
        setKey: async (id, key) => {
          window.keyCalls.push({ id, key });
          if (key.trim()) songKeys.set(id, key.trim()); else songKeys.delete(id);
          const updated = { ...queue.find(item => item.id === id), hasKey: songKeys.has(id) };
          emit({ type: 'item', item: updated });
          return updated;
        },
      };
    });

    await page.goto(pathToFileURL(path.join(__dirname, '../src/renderer/index.html')).href);
    if (process.argv.includes('--flac-only')) {
      await checkFlacUi(page, 'qqmp3');
      assert.deepEqual(errors, [], 'No renderer errors');
      assert.deepEqual(network, [], 'No external requests');
      return;
    }
    await screenshot('mock-empty');
    await page.getByRole('button', { name: '添加文件', exact: true }).click();
    assert.equal(await page.locator('.file-row').count(), 4, 'Files enter the queue');
    const firstKey = 'first-song-only-ekey\nsecond-line';
    const secondKey = 'different-second-song-ekey';
    const keyButtons = page.locator('.key-button');
    await keyButtons.nth(0).click();
    assert.ok(await page.locator('#key-dialog').isVisible());
    assert.equal(await page.locator('#song-key').getAttribute('maxlength'), '16384');
    await page.locator('#song-key').fill(firstKey);
    await page.locator('#key-save').click();
    await page.waitForFunction(() => !document.getElementById('key-dialog').open);
    assert.equal(await page.locator('.key-button.has-key').count(), 1, 'Only the chosen song receives a key');
    assert.equal(await page.locator('#song-key').inputValue(), '', 'Input is cleared after saving');
    assert.deepEqual(await page.evaluate(() => window.keyCalls[0]), { id: '0', key: firstKey });
    await keyButtons.nth(1).click();
    assert.equal(await page.locator('#song-key').inputValue(), '', 'Another song does not inherit the first key');
    await page.locator('#song-key').fill(secondKey);
    await page.locator('#key-save').click();
    await page.waitForFunction(() => !document.getElementById('key-dialog').open);
    assert.equal(await page.locator('.key-button.has-key').count(), 2);
    assert.deepEqual(await page.evaluate(() => window.keyCalls[1]), { id: '1', key: secondKey });
    await keyButtons.nth(0).click();
    assert.equal(await page.locator('#song-key').inputValue(), '', 'Previously stored key is never refilled');
    assert.ok(await page.locator('#key-current-status').isVisible());
    await screenshot('mock-song-key');
    await page.locator('#key-clear').click();
    await page.waitForFunction(() => !document.getElementById('key-dialog').open);
    assert.deepEqual(await page.evaluate(() => window.keyCalls[2]), { id: '0', key: '' });
    assert.ok(!await keyButtons.nth(0).evaluate(el => el.classList.contains('has-key')));
    assert.ok(await keyButtons.nth(1).evaluate(el => el.classList.contains('has-key')), 'Clearing one song preserves another song key');
    await keyButtons.nth(2).click();
    await page.locator('#song-key').fill('discard-this-input');
    await page.locator('#key-cancel').click();
    assert.equal(await page.locator('#song-key').inputValue(), '', 'Input is cleared on cancel');
    assert.equal(await page.evaluate(() => window.keyCalls.length), 3, 'Cancelling does not save a key');
    await keyButtons.nth(2).click();
    await page.locator('#song-key').fill('discard-on-escape');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('key-dialog').open);
    assert.equal(await page.locator('#song-key').inputValue(), '', 'Input is cleared on Escape');
    console.log('PASS per-song keys: separate song binding, independent clearing, no refill, cancel/Escape clearing, 16384-character limit.');
    await page.getByRole('button', { name: '开始转换', exact: true }).click();
    assert.ok(await page.locator('#add-files').isDisabled(), 'Adding files is locked while running');
    assert.ok(await keyButtons.nth(0).isDisabled(), 'Changing keys is locked while running');
    await page.evaluate(() => {
      window.mockEmit({ type: 'item', item: { ...window.mockQueue[0], status: 'success', progress: 100, message: '原 MP3 直接还原 · 已保留原音质' } });
      window.mockEmit({ type: 'item', item: { ...window.mockQueue[1], status: 'failed', progress: 14, error: '文件内容不完整，无法解析音频。' } });
      window.mockEmit({ type: 'item', item: { ...window.mockQueue[2], status: 'encoding', progress: 62, message: 'FLAC → MP3 · 320 kbps' } });
      window.mockEmit({ type: 'batch', running: true, total: 4, completed: 2, success: 1, failed: 1, cancelled: 0, currentName: '周杰伦 - 晴天.qmcflac' });
    });
    await page.locator('#toast-close').click();
    await screenshot('mock-converting');
    await page.getByRole('button', { name: '取消转换', exact: true }).click();
    assert.equal(await page.locator('#batch-percentage').innerText(), '50%', 'Two completed plus two cancelled files display 50%, not 100%');
    assert.equal(await page.locator('#overall-track').getAttribute('aria-valuenow'), '50', 'Accessible progress also excludes cancellations');
    assert.equal(await page.locator('#start').innerText(), '重试未完成', 'Cancelled and failed files offer retry');
    console.log('PASS cancelled progress: 1 success + 1 failure + 2 cancelled / 4 total = 50%');

    await page.getByRole('button', { name: '重试未完成', exact: true }).click();
    assert.ok(await page.locator('#start').isHidden(), 'Retry starts a batch');
    await page.getByRole('button', { name: '取消转换', exact: true }).click();
    assert.equal(await page.locator('#batch-percentage').innerText(), '0%', 'A fully cancelled retry displays 0%, not 100%');
    console.log('PASS fully cancelled retry: 3 cancelled / 3 total = 0%');
    await page.evaluate(() => window.mockEmit({ type: 'batch', running: false, total: 4, completed: 4, success: 4, failed: 0, cancelled: 0 }));
    assert.equal(await page.locator('#batch-percentage').innerText(), '100%', 'A fully finished batch still displays 100%');
    console.log('PASS completed batch: 4 success / 4 total = 100%');

    await page.locator('.remove-item').first().click();
    assert.equal(await page.locator('.file-row').count(), 3, 'An individual item can be removed');
    await page.getByRole('button', { name: '清空列表', exact: true }).click();
    assert.equal(await page.locator('.file-row').count(), 0, 'Queue can be cleared');
    await page.getByRole('button', { name: '更改', exact: true }).click();
    assert.equal(await page.locator('#output-dir').inputValue(), 'D:\\已转换的音乐');
    await page.locator('#bitrate').selectOption('192');
    await page.getByRole('button', { name: '添加文件', exact: true }).click();
    await page.getByRole('button', { name: '开始转换', exact: true }).click();
    const settings = await page.evaluate(() => window.lastStart);
    assert.deepEqual(settings, { bitrate: 192, outputDir: 'D:\\已转换的音乐' });
    await page.getByRole('button', { name: '取消转换', exact: true }).click();
    await page.getByRole('button', { name: '清空列表', exact: true }).click();

    const maliciousName = '<img src="https://invalid.example/image" onerror="window.injected=true">.qmc0';
    await page.evaluate(name => window.mockEmit({ type: 'queue', items: [{ id: 'unsafe', name, path: name, size: 100, status: 'failed', progress: 0, error: '<script>window.injected=true</script>' }] }), maliciousName);
    assert.equal(await page.locator('.file-name').innerText(), maliciousName, 'Filename is preserved as text');
    assert.equal(await page.locator('.file-list img,.file-list script').count(), 0, 'File data cannot introduce HTML');
    assert.equal(await page.evaluate(() => Boolean(window.injected)), false, 'File data cannot execute JavaScript');
    await page.setViewportSize({ width: 820, height: 620 });
    const overflow = await page.evaluate(() => ({ x: document.documentElement.scrollWidth > innerWidth, y: document.documentElement.scrollHeight > innerHeight }));
    assert.deepEqual(overflow, { x: false, y: false });
    assert.deepEqual(errors, [], 'No renderer errors');
    assert.deepEqual(network, [], 'No external network requests');
    console.log('PASS mock UI regression: add/start/lock/progress/cancel/retry/remove/clear/output/bitrate/text injection/layout; no external requests or script errors.');
    console.log('Environment: headless browser + mock Electron API; this is not a Windows/Mac executable test.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
