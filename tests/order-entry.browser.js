// With the app served at 127.0.0.1:3001, run in a fresh playwright-cli session:
// playwright-cli run-code --filename tests/order-entry.browser.js
// The API is mocked; production orders and menus are never touched.
async (page) => {
  page.setDefaultTimeout(10000);
  const menu = [
    { id: 'espresso', name: 'Espresso', priceCents: 300 },
    { id: 'latte', name: 'Latte', priceCents: 800 },
    { id: 'flat-white', name: 'Flat white', priceCents: 800 },
    { id: 'americano', name: 'Americano', priceCents: 600 },
    { id: 'pourover', name: 'Pourover', priceCents: 1000 },
  ].map(item => ({ ...item, available: true, category: 'Coffee', description: item.name }));
  const orders = [];
  let rejectNext = false;
  let submitted;
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  await page.route('**/api/session', route => route.fulfill({ json: { role: 'lead' } }));
  await page.route('**/api/snapshot', route => route.fulfill({ json: { orders, menu, serverTime: new Date().toISOString() } }));
  let lastMenuEdit;
  await page.route('**/api/menu/*', route => {
    const item = menu.find(item => item.id === route.request().url().split('/').at(-1));
    lastMenuEdit = route.request().postDataJSON();
    Object.assign(item, lastMenuEdit);
    return route.fulfill({ json: item });
  });
  await page.route('**/api/orders', route => {
    submitted = route.request().postDataJSON();
    if (rejectNext) return route.fulfill({ status: 409, json: { error: 'Please review this order.' } });
    const timestamp = new Date().toISOString();
    const order = { ...submitted, number: orders.length + 1, status: 'queued', revision: 0, guestToken: 'synthetic-guest', createdAt: timestamp, updatedAt: timestamp, eventDay: timestamp.slice(0, 10),
      lines: submitted.lines.map(line => ({ ...line, name: menu.find(item => item.id === line.menuId).name, unitCents: line.expectedUnitCents })),
      totalCents: submitted.lines.reduce((sum, line) => sum + line.expectedUnitCents * line.quantity, 0) };
    orders.push(order);
    return route.fulfill({ status: 201, json: order });
  });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('http://127.0.0.1:3001/staff/order');
  await page.locator('.drink-tile').first().waitFor();
  check(await page.getByRole('group', { name: 'Drinks', exact: true }).getByRole('button').count() === 7, 'Seven complete drink choices must be available');
  check(await page.getByRole('combobox', { name: 'Milk', exact: true }).count() === 0, 'Milk must be part of the drink choice');
  check(!/\$/.test(await page.locator('.drink-grid').innerText()), 'Available drink tiles must show names without prices');
  await page.getByRole('button', { name: 'Latte', exact: true }).click();
  check(await page.getByRole('radio', { name: 'Hot', exact: true }).isChecked(), 'Hot must be selected by default');
  await page.getByRole('radio', { name: 'Iced (+S$1)', exact: true }).check();
  check(await page.getByRole('button', { name: /^Add Latte/ }).innerText().then(text => /9\.00/.test(text)), 'Iced Latte must cost $9');
  await page.getByRole('button', { name: 'Latte (oat milk)', exact: true }).click();
  check(await page.getByRole('button', { name: /^Add Latte/ }).innerText().then(text => /10\.00/.test(text)), 'Iced oat Latte must cost $10');
  await page.getByRole('button', { name: /^Add Latte/ }).click();
  check(await page.getByRole('radio', { name: 'Hot', exact: true }).isChecked(), 'Adding a drink must reset Hot');
  await page.getByRole('button', { name: /^Espresso/ }).click();
  check(await page.getByRole('combobox', { name: 'Milk', exact: true }).count() === 0, 'Espresso must hide the milk selector');
  check(await page.getByRole('button', { name: /^Add Espresso/ }).innerText().then(text => /3\.00/.test(text)), 'Espresso must not inherit oat charges');
  await page.getByRole('button', { name: 'Flat white', exact: true }).click();
  await page.getByRole('button', { name: /^Add Flat white/ }).click();
  await page.getByRole('button', { name: /^Review order/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('1 × Iced Latte (oat milk)', { exact: true }).waitFor();
  await dialog.getByText('1 × Hot Flat white', { exact: true }).waitFor();
  check(/18\.00/.test(await dialog.locator('.order-total').innerText()), 'Cart must total $18');
  await dialog.getByRole('textbox', { name: 'Guest’s first name' }).fill('Synthetic guest');
  await dialog.getByRole('button', { name: 'Place order', exact: true }).click();
  await page.getByRole('heading', { name: 'One good coffee, on its way.', exact: true }).waitFor();
  check(submitted.lines[0].expectedUnitCents === 1000 && submitted.lines[1].expectedUnitCents === 800, 'Submitted totals must match the displayed amounts');
  check(submitted.lines[0].milk === 'Oat' && submitted.lines[1].milk === 'Dairy', 'Drink variants must retain the correct milk values');
  await page.keyboard.press('Escape');
  await page.goto('http://127.0.0.1:3001/staff/queue');
  await page.getByText('Iced Latte (oat milk)', { exact: true }).waitFor();
  await page.getByText('Hot Flat white', { exact: true }).waitFor();
  check(await page.getByRole('columnheader', { name: 'Milk', exact: true }).count() === 0, 'Queue must not have a separate milk column');
  await page.goto('http://127.0.0.1:3001/staff/recent');
  await page.getByText('1 × Iced Latte (oat milk)', { exact: true }).waitFor();
  check(await page.getByRole('columnheader', { name: 'Milk', exact: true }).count() === 0, 'Recent orders must not have a separate milk column');
  await page.getByRole('button', { name: 'Edit order 1', exact: true }).click();
  await page.getByRole('button', { name: 'Correct order', exact: true }).click();
  for (const width of [320, 390, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('.correction-dialog').screenshot({ path: `output/playwright/correction-labels-${width}.png`, animations: 'disabled' });
    const clipped = await page.locator('.correction-dialog .drink-name').evaluateAll(labels => labels.filter(label => {
      const button = label.closest('button');
      return label.getBoundingClientRect().right > button.getBoundingClientRect().right - parseFloat(getComputedStyle(button).paddingRight) + 1;
    }).map(label => label.textContent));
    check(clipped.length === 0, `Correction labels must fit at ${width}px: ${clipped.join(', ')}`);
  }
  await page.keyboard.press('Escape');

  // A rejected draft must reprice its iced/oat line correctly when reviewed.
  await page.goto('http://127.0.0.1:3001/staff/order');
  await page.getByRole('button', { name: 'Latte (oat milk)', exact: true }).click();
  await page.getByRole('radio', { name: 'Iced (+S$1)', exact: true }).check();
  await page.getByRole('button', { name: /^Add Latte/ }).click();
  await page.getByRole('button', { name: /^Review order/ }).click();
  await page.getByRole('textbox', { name: 'Guest’s first name' }).fill('Review guest');
  rejectNext = true;
  await page.getByRole('button', { name: 'Place order', exact: true }).click();
  await page.locator('.connection-banner').getByRole('button').click();
  await page.getByRole('button', { name: 'Review order', exact: true }).click();
  await page.getByRole('button', { name: /^Review order,/ }).click();
  check(/10\.00/.test(await page.getByRole('dialog').locator('.order-total').innerText()), 'Restored draft must include both surcharges');
  await page.keyboard.press('Escape');
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
    await page.getByRole('button', { name: 'Latte (oat milk)', exact: true }).click();
    await page.locator('.add-drink').scrollIntoViewIfNeeded();
    const columns = await page.locator('.drink-grid').evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(' ').length);
    check(columns === (width === 390 ? 2 : 4), `Expected ${width === 390 ? 2 : 4} columns at ${width}px, got ${columns}`);
    for (const name of ['Latte (oat milk)', 'Flat white (oat milk)']) {
      const metrics = await page.getByRole('button', { name, exact: true }).evaluate(button => {
        const label = button.querySelector('.drink-name');
        const range = document.createRange(); range.selectNodeContents(label);
        const rects = [...range.getClientRects()].filter(rect => rect.width > 0);
        return { lines: new Set(rects.map(rect => Math.round(rect.top))).size, right: label.getBoundingClientRect().right, limit: button.getBoundingClientRect().right - parseFloat(getComputedStyle(button).paddingRight) };
      });
      check(metrics.lines === 1 && metrics.right <= metrics.limit + 1, `${name} must fit on one line at ${width}px`);
    }
    await page.screenshot({ path: `output/playwright/drink-buttons-${width}.png`, fullPage: true });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Layout overflows at ${width}px`);
  }
  // Sold-out milk drinks disable both variants and retain a visible availability label.
  menu.find(item => item.id === 'flat-white').available = false;
  await page.reload();
  for (const label of ['Flat white Sold out', 'Flat white (oat milk) Sold out']) {
    check(await page.getByRole('button', { name: label, exact: true }).isDisabled(), `${label} must be disabled`);
  }
  await page.setViewportSize({ width: 1238, height: 768 });
  await page.goto('http://127.0.0.1:3001/staff/menu');
  await page.locator('.menu-table tbody tr').first().waitFor();
  check(await page.locator('.menu-table tbody tr').count() === 7, 'Menu must show the same seven drink choices');
  const oatRow = page.getByRole('row').filter({ has: page.getByText('Latte (oat milk)', { exact: true }) });
  check(/9\.00/.test(await oatRow.innerText()), 'Menu oat price must include the $1 addition');
  await page.screenshot({ path: 'output/playwright/seven-drink-menu.png', fullPage: true });
  await oatRow.getByRole('button', { name: 'Edit Latte (oat milk)', exact: true }).click();
  check(await page.getByRole('textbox', { name: 'Price (SGD)', exact: true }).inputValue() === '9.00', 'Oat editor must start at the displayed price');
  await page.getByRole('textbox', { name: 'Price (SGD)', exact: true }).fill('9.50');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  check(lastMenuEdit.priceCents === 850, 'Editing the oat price must retain its fixed $1 addition');
  const regularRow = page.getByRole('row').filter({ has: page.getByText('Latte', { exact: true }) });
  check(/8\.50/.test(await regularRow.innerText()) && /9\.50/.test(await oatRow.innerText()), 'Both menu prices must stay consistent');
  await oatRow.getByRole('switch').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.menu-table tbody tr')].filter(row => /Latte/.test(row.textContent)).every(row => row.querySelector('[role=switch]').getAttribute('aria-checked') === 'false'));
  return { defaults: 'Hot', choices: 'seven name-only buttons', pricing: 'iced + oat totals correct', recovery: 'restored draft includes both surcharges', columns: 'four on tablet, two on phone', soldOut: 'both variants disabled' };
}
