// Serve the app on port 3006 in a fresh playwright-cli session, then run:
// playwright-cli run-code --filename tests/recovery-feedback.browser.js
// API responses are mocked; no saved orders are changed.
async (page) => {
  page.setDefaultTimeout(10000);
  await page.setViewportSize({ width: 1024, height: 768 });
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const timestamp = new Date().toISOString();
  const menu = [{ id: 'latte', name: 'Latte', priceCents: 500, available: true, category: 'Coffee', description: 'Coffee with milk' }];
  const orders = Array.from({ length: 24 }, (_, index) => ({
    id: `feedback-order-${index + 1}`, number: index + 1, firstName: `Guest ${index + 1}`, status: 'making',
    lines: [{ menuId: 'latte', name: 'Latte', milk: 'No milk', temperature: 'Hot', quantity: 1, unitCents: 500 }],
    totalCents: 500, guestToken: `guest-${index + 1}`, createdAt: timestamp, updatedAt: timestamp, eventDay: timestamp.slice(0, 10), revision: 0,
  }));
  const previous = new Map();
  await page.route('**/api/session', route => route.fulfill({ json: { role: 'lead' } }));
  await page.route('**/api/snapshot', route => route.fulfill({ json: { orders, menu, serverTime: new Date().toISOString() } }));
  await page.route('**/api/orders', route => route.fulfill({ status: 409, json: { error: 'Latte is sold out.' } }));
  await page.route('**/api/orders/*/status', route => {
    const command = route.request().postDataJSON();
    const order = orders.find(order => order.id === command.id);
    previous.set(order.id, { ...order });
    Object.assign(order, { status: command.next, revision: order.revision + 1, undoUntil: new Date(Date.now() + 10000).toISOString() });
    return route.fulfill({ json: order });
  });
  await page.route('**/api/orders/*/undo', route => {
    const id = route.request().url().split('/').at(-2);
    const order = orders.find(order => order.id === id);
    Object.assign(order, previous.get(id), { revision: order.revision + 1, undoUntil: undefined });
    return route.fulfill({ json: order });
  });

  await page.goto('http://127.0.0.1:3006/staff/order');
  await page.getByRole('button', { name: /^Latte/ }).click();
  await page.getByRole('radio', { name: 'Hot', exact: true }).check();
  await page.getByRole('button', { name: /^Add Latte/ }).click();
  await page.getByRole('button', { name: /^Review order/ }).click();
  await page.getByRole('textbox', { name: 'Guest’s first name' }).fill('Sold-out guest');
  await page.getByRole('button', { name: 'Place order', exact: true }).click();
  await page.locator('.connection-banner').getByRole('button').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Latte is sold out.', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  const rejectedBanner = await page.locator('.connection-banner').innerText();
  check(/sold out/i.test(rejectedBanner) && /review|reject/i.test(rejectedBanner), `Rejected order must explain the failure and recovery: ${rejectedBanner}`);
  check(!/waiting for confirmation/i.test(rejectedBanner), 'Rejected work is incorrectly presented as waiting for confirmation');
  await page.screenshot({ path: 'output/playwright/rejected-work.png', fullPage: true });

  await page.locator('.connection-banner').getByRole('button').click();
  await dialog.getByRole('button', { name: 'Discard…', exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard change', exact: true }).click();
  await dialog.getByText('All work is confirmed. You’re up to date.', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });

  await page.goto('http://127.0.0.1:3006/staff/queue');
  await page.getByRole('heading', { name: 'On the counter.' }).waitFor();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Show tracking QR for order 1', exact: true }) });
    await row.getByRole('button', { name: 'Ready', exact: true }).click();
    await page.getByRole('button', { name: 'Undo last change', exact: true }).waitFor();
    const overlaps = await page.evaluate(() => {
      const toast = document.querySelector('.undo-toast').getBoundingClientRect();
      const workspace = document.querySelector('.staff-content').getBoundingClientRect();
      return [...document.querySelectorAll('.queue-table .table-action')].filter(button => {
        const rect = button.getBoundingClientRect();
        const left = Math.max(rect.left, workspace.left, 0);
        const right = Math.min(rect.right, workspace.right, innerWidth);
        const top = Math.max(rect.top, workspace.top, 0);
        const bottom = Math.min(rect.bottom, workspace.bottom, innerHeight);
        return left < right && top < bottom && left < toast.right && right > toast.left && top < toast.bottom && bottom > toast.top;
      }).length;
    });
    check(overlaps === 0, `Undo overlaps ${overlaps} queue actions at ${viewport.width}px`);
    await page.screenshot({ path: `output/playwright/undo-${viewport.width}.png` });
    // Scroll to the last ticket while Undo remains available, including narrow screens.
    const lastRow = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Show tracking QR for order 24', exact: true }) });
    await lastRow.getByRole('button', { name: 'Ready', exact: true }).click();
    await page.getByRole('button', { name: 'Undo last change', exact: true }).click();
    await lastRow.getByRole('button', { name: 'Ready', exact: true }).waitFor();
    check(await page.locator('.undo-toast').count() === 0, `Undo did not dismiss after restoring the order at ${viewport.width}px`);
    check(await row.getByRole('button', { name: 'Collected', exact: true }).count() === 1, 'Undo changed an unrelated ticket');
    // Restore the first ticket for the next viewport.
    Object.assign(orders[0], previous.get(orders[0].id), { revision: orders[0].revision + 1, undoUntil: undefined });
    await page.reload();
    await row.getByRole('button', { name: 'Ready', exact: true }).waitFor();
  }
  if (failures.length) throw new Error(failures.join('\n'));
  return { rejectedOrder: 'reason and review action visible', undoLayout: 'no queue actions covered on desktop, tablet or phone', undoAction: 'restores the selected ticket after scrolling' };
}
