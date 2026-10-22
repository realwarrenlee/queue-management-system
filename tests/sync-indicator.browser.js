// Build and serve on port 3006, then open a fresh playwright-cli browser session.
// Run with playwright-cli run-code --filename tests/sync-indicator.browser.js.
// API responses are mocked; no saved orders are changed.
async (page) => {
  page.setDefaultTimeout(10000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const requests = [];
  const waiters = [];
  const nextSync = () => requests.length ? Promise.resolve(requests.shift()) : new Promise(resolve => waiters.push(resolve));
  const startSync = async () => {
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    return nextSync();
  };
  await page.route('**/api/session', route => route.fulfill({ json: { role: 'lead' } }));
  await page.route('**/api/snapshot', route => {
    const request = { route, started: Date.now() };
    if (waiters.length) waiters.shift()(request);
    else requests.push(request);
  });
  const finish = request => request.route.fulfill({ json: {
    orders: [], serverTime: new Date().toISOString(),
    menu: [{ id: 'latte', name: 'Latte', priceCents: 500, available: true, category: 'Coffee', description: 'Coffee with milk' }],
  } });
  const label = () => page.locator('#staff-sync').getAttribute('aria-label');
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const waitForLabel = text => page.waitForFunction(expected => document.querySelector('#staff-sync')?.getAttribute('aria-label')?.startsWith(expected), text, { timeout: 3500 });
  await page.goto('http://127.0.0.1:3006/staff/queue');

  const fast = await nextSync();
  await finish(fast);
  await page.getByRole('heading', { name: 'On the counter.' }).waitFor();
  await page.waitForTimeout(150);
  check((await label()).startsWith('Syncing…'), 'Fast sync flashed back to Synced before two seconds');
  check(await page.locator('#staff-sync svg.animate-spin').count() === 1, 'Syncing must use the shadcn Spinner');
  await waitForLabel('Synced');
  const fastDuration = Date.now() - fast.started;
  check(fastDuration >= 1900, `Syncing was only visible for ${fastDuration}ms`);

  await page.locator('#staff-sync').click();
  const slow = await startSync();
  await page.waitForTimeout(2200);
  check((await label()).startsWith('Syncing…'), 'Slow request stopped showing Syncing before completion');
  await finish(slow);
  await waitForLabel('Synced');
  check(Date.now() - slow.started < 3500, 'A completed slow sync waited another two seconds');

  const failed = await startSync();
  await failed.route.abort('failed');
  await waitForLabel('Offline');
  check(Date.now() - failed.started < 1900, 'Offline state was hidden by the minimum spinner duration');
  check(await page.locator('#staff-sync svg.animate-spin').count() === 0, 'Offline icon should not spin');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const recovered = await startSync();
  await waitForLabel('Syncing…');
  check(await page.locator('#staff-sync svg').evaluate(el => getComputedStyle(el).animationName) === 'none', 'Spinner ignored reduced motion');
  await finish(recovered);
  await waitForLabel('Synced');
  return { fastSyncMinimum: `${fastDuration}ms`, slowSync: 'stays visible until completion', failure: 'Offline immediately', recovery: 'Syncing → Synced', reducedMotion: 'respected' };
}
