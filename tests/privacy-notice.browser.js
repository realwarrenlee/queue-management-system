// Serve the app on port 3006, open a fresh playwright-cli session, then run:
// playwright-cli run-code --filename tests/privacy-notice.browser.js
// API responses are mocked; no saved orders are changed.
async (page) => {
  page.setDefaultTimeout(5000);
  await page.setViewportSize({ width: 390, height: 844 });
  let response;
  await page.route('**/api/guest/privacy-test', route => { response = route; });
  await page.goto('http://127.0.0.1:3006/g/privacy-test');
  await page.getByRole('heading', { name: 'Finding your order…', exact: true }).waitFor();
  const link = page.getByRole('link', { name: 'Privacy notice', exact: true });
  await link.click();
  const notice = page.getByRole('dialog', { name: 'Privacy notice', exact: true });
  await notice.waitFor();
  await notice.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  await response.fulfill({ json: {
    number: 42, firstName: 'Alex', status: 'queued', ordersAhead: 2, updatedAt: new Date().toISOString(),
    lines: [{ menuId: 'latte', name: 'Latte', milk: 'Dairy', temperature: 'Hot', quantity: 1, unitCents: 500 }],
  } });
  await page.getByRole('heading', { name: /Alex,/, includeHidden: true }).waitFor({ state: 'attached' });
  if (!await notice.isVisible()) throw new Error('Loading the order closed the privacy notice');
  await page.screenshot({ path: 'output/playwright/privacy-notice-mobile.png' });
  await page.keyboard.press('Escape');
  await notice.waitFor({ state: 'hidden' });
  if (!await link.evaluate(element => element === document.activeElement)) throw new Error('Closing the notice did not return focus to its link');
  await page.screenshot({ path: 'output/playwright/privacy-footer-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await link.click();
  await notice.waitFor();
  await notice.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)); });
  await page.screenshot({ path: 'output/playwright/privacy-notice-desktop.png' });
  await notice.getByRole('button', { name: 'Close', exact: true }).click();
  await notice.waitFor({ state: 'hidden' });
  await page.unroute('**/api/guest/privacy-test');
  await page.route('**/api/guest/privacy-test', route => route.fulfill({ status: 404, json: { error: 'We could not find that order.' } }));
  await page.reload();
  await page.getByText('We could not find that order.', { exact: true }).waitFor();
  await link.click();
  await notice.waitFor();
  return { notice: 'available while loading, after loading and on invalid links', interaction: 'opens, closes and returns keyboard focus', screenshots: 'mobile and desktop' };
}
