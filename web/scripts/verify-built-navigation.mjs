import { chromium, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Run against a synthetic Worker with an invalid upstream, never private custody.
export async function verifyBuiltNavigation(baseURL) {
  const base = new URL(baseURL);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1')
    throw new Error('Built navigation requires a loopback preview');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  let walletRequests = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/wallet/')) walletRequests++;
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (/hydrat/i.test(message.text())) errors.push(message.text());
  });
  await page.route('**/api/wallet/**', route => route.fulfill({
    status: 503, json: { ok: false, kind: 'unavailable' },
  }));
  try {
    await page.goto(new URL('/demo', base).href);
    await expect(page.getByText('$12,345.67', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Inspect BONK holding', exact: true }).click();
    await expect(page.locator('#holdings .detail-row')).toBeVisible();
    const stake = page.locator('#protocol-stake');
    await stake.getByRole('button', { name: 'Expand Native staking', exact: true }).click();
    await stake.locator('.data-row button').click();
    const stakeDetail = stake.locator('.detail-row');
    const stakeField = label => stakeDetail.locator('dl > div')
      .filter({ has: page.getByText(label, { exact: true }) }).locator('dd');
    await expect(stakeField('Account lamports')).toHaveText('10000000000');
    await expect(stakeField('Staker')).toHaveText(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    await expect(stakeField('Authorized withdrawer')).toHaveText(await stakeField('Staker').textContent());
    await expect(stakeField('Lockup Unix timestamp (seconds)')).toHaveText('0');
    await expect(stakeField('Lockup epoch')).toHaveText('0');
    await expect(stakeField('Lockup custodian')).toHaveText(await stakeField('Staker').textContent());
    await expect(stakeField('Activation epoch')).toHaveText('700');
    await expect(stakeField('Deactivation epoch')).toHaveText('Unknown');
    await expect(stakeField('Valuation / delegation basis')).toContainText('not effective or withdrawable stake');
    for (const [width, view] of [[1440, 'desktop'], [390, 'mobile']]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await stakeDetail.scrollIntoViewIfNeeded();
      await page.screenshot({ path: fileURLToPath(new URL(`../test-results/screenshots/stake-${view}.png`, import.meta.url)), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('link', { name: 'Activity', exact: true }).click();
    await expect(page).toHaveURL(new URL('/demo?tab=activity', base).href, { timeout: 10000 });
    await expect(page.getByRole('button', { name: /^Inspect transaction/ }).first()).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: /^Inspect transaction/ }).first().click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.getByRole('link', { name: 'Portfolio', exact: true }).click();
    await expect(page).toHaveURL(new URL('/demo?tab=portfolio', base).href);
    await page.goBack();
    await expect(page).toHaveURL(new URL('/demo?tab=activity', base).href);
    await page.getByLabel('From (UTC)', { exact: true }).fill('2026-10-22T00:00');
    await page.getByLabel('To (UTC)', { exact: true }).fill('2026-10-23T00:00');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('from')).toBe('2026-10-22T00:00:00.000Z');
    await expect(page.getByRole('button', { name: /^Inspect transaction/ })).toHaveCount(2);
    await page.goto(new URL('/demo?tab=activity&scenario=activity-continuation', base).href);
    await expect(page.getByText('Another page is available', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Load more →' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('cursor')).toBe('demo-next');
    await expect(page.getByRole('button', { name: /^Inspect transaction/ })).toHaveCount(4);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const wallet = '7yW6xxcWv2bGX2KkXDCf8qx9Fu7JXraT2m2YZ2f3tWsa';
    const portfolioReads = Promise.all(['overview', 'summary'].map(resource =>
      page.waitForResponse(response => new URL(response.url()).pathname === `/api/wallet/${wallet}/${resource}`)));
    await page.getByRole('textbox', { name: 'Solana address' }).fill(wallet);
    await page.getByRole('button', { name: 'Explore wallet' }).click();
    await portfolioReads;
    await expect(page).toHaveURL(new URL('/wallet/' + wallet, base).href);
    await expect(page.getByText('Wallet data is unavailable', { exact: true }).first()).toBeVisible();
    const activityReads = Promise.all(['overview', 'summary', 'transactions'].map(resource =>
      page.waitForResponse(response => new URL(response.url()).pathname === `/api/wallet/${wallet}/${resource}`)));
    await page.getByRole('link', { name: 'Activity', exact: true }).click();
    await activityReads;
    await expect(page).toHaveURL(new URL('/wallet/' + wallet + '/activity', base).href);
    const beforeWatchlist = walletRequests;
    await page.getByRole('button', { name: 'Save wallet', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remove wallet from watchlist' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('link', { name: 'Watchlist', exact: true }).click();
    await expect(page.getByRole('listitem')).toContainText(wallet);
    await page.reload();
    await expect(page.getByRole('listitem')).toContainText(wallet);
    await page.getByRole('button', { name: 'Edit label for ' + wallet }).click();
    await page.getByLabel('Label', { exact: true }).fill('Saved wallet');
    await page.getByRole('button', { name: 'Save label', exact: true }).click();
    await expect(page.getByText('Saved wallet', { exact: true })).toBeVisible();
    await page.screenshot({ path: fileURLToPath(new URL('../test-results/screenshots/watchlist-desktop.png', import.meta.url)) });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: fileURLToPath(new URL('../test-results/screenshots/watchlist-mobile.png', import.meta.url)) });
    await page.getByRole('button', { name: 'Remove ' + wallet, exact: true }).click();
    await expect(page.getByText('No saved wallets yet', { exact: true })).toBeVisible();
    expect(walletRequests).toBe(beforeWatchlist);
    await page.getByLabel('Solana wallet address', { exact: true }).fill(wallet);
    await page.getByRole('button', { name: 'Save wallet', exact: true }).click();
    const reopenedReads = Promise.all(['overview', 'summary'].map(resource =>
      page.waitForResponse(response => new URL(response.url()).pathname === `/api/wallet/${wallet}/${resource}`)));
    await page.getByRole('link', { name: /Portfolio/ }).click();
    await reopenedReads;
    const afterReopen = walletRequests;
    await page.getByRole('button', { name: 'Remove wallet from watchlist', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save wallet', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await page.goBack();
    await expect(page).toHaveURL(new URL('/watchlist', base).href);
    await expect(page.getByText('No saved wallets yet', { exact: true })).toBeVisible();
    expect(walletRequests).toBe(afterReopen);
    if (errors.length) throw new Error('Built navigation produced browser errors: ' + errors.join('; '));
    return { navigated: true, mobileWidth: 390, pageErrors: 0 };
  } catch (error) {
    if (errors.length) throw new Error('Built navigation produced browser errors: ' + errors.join('; '), { cause: error });
    throw error;
  } finally {
    await browser.close();
  }
}
