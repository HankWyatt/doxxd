import { test, expect } from "@playwright/test";
const wallet = "11111111111111111111111111111111";

test("local watchlist persists, edits and removes without wallet reads", async ({page}) => {
  const walletRequests: string[] = [];
  const hydrationErrors: string[] = [];
  page.on("console", message => { if (/hydrat/i.test(message.text())) hydrationErrors.push(message.text()); });
  page.on("request",request => { if(new URL(request.url()).pathname.startsWith("/api/wallet/")) walletRequests.push(request.url()); });
  await page.goto("/watchlist");
  const address = page.getByLabel("Solana wallet address",{exact:true});
  await expect(address).toBeEnabled({timeout:15000});
  await address.fill("not-an-address");
  await page.getByRole("button",{name:"Save wallet",exact:true}).click();
  await expect(page.getByRole("alert")).toHaveText("Enter a valid Solana address.");
  await address.fill("  "+wallet+"  ");
  await page.getByLabel("Label (optional)").fill("Treasury");
  await page.getByRole("button",{name:"Save wallet",exact:true}).click();
  await expect(page.getByText("Treasury",{exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByText("Treasury",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Edit label for "+wallet}).click();
  await page.getByLabel("Label",{exact:true}).fill("Watch wallet");
  await page.getByRole("button",{name:"Save label",exact:true}).click();
  await expect(page.getByText("Watch wallet",{exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole("button",{name:"Remove "+wallet,exact:true}).click();
  await expect(page.getByText("No saved wallets yet",{exact:true})).toBeVisible();
  expect(walletRequests).toEqual([]);
  expect(hydrationErrors).toEqual([]);
});

test("save from a public wallet persists without adding requests", async ({page}) => {
  const walletRequests: string[] = [];
  await page.route("**/api/wallet/**", route => route.fulfill({status:503,json:{ok:false,kind:"unavailable"}}));
  page.on("request",request => {if(new URL(request.url()).pathname.startsWith("/api/wallet/"))walletRequests.push(request.url());});
  await page.goto("/wallet/"+wallet);
  const save = page.getByRole("button",{name:"Save wallet",exact:true});
  await expect(save).toBeEnabled({timeout:15000});
  await expect(page.getByText("Wallet data is unavailable",{exact:true}).first()).toBeVisible();
  const before = walletRequests.length;
  await save.focus();await save.press("Enter");
  await expect(page.getByRole("button",{name:"Remove wallet from watchlist",exact:true})).toHaveAttribute("aria-pressed","true");
  expect(walletRequests.length).toBe(before);
  await page.getByRole("link",{name:"Watchlist",exact:true}).click();
  await expect(page.getByRole("listitem")).toContainText(wallet);
  expect(walletRequests.length).toBe(before);
  await page.goto("/");
  await expect(page.locator('a[href^="/demo"]')).toHaveCount(0);
  expect(walletRequests.length).toBe(before);
});

test("returning to the watchlist reflects changes made on a wallet page", async ({page}) => {
  await page.route("**/api/wallet/**",route=>route.fulfill({status:503,json:{ok:false,kind:"unavailable"}}));
  await page.goto("/watchlist");
  const input = page.getByLabel("Solana wallet address",{exact:true});
  await expect(input).toBeEnabled({timeout:15000});
  await input.fill(wallet);
  await page.getByRole("button",{name:"Save wallet",exact:true}).click();
  await expect(page.getByRole("listitem")).toContainText(wallet);
  await page.getByRole("link",{name:/Portfolio/}).click();
  const remove = page.getByRole("button",{name:"Remove wallet from watchlist",exact:true});
  await expect(remove).toHaveAttribute("aria-pressed","true");
  await remove.click();
  await expect(page.getByRole("button",{name:"Save wallet",exact:true})).toHaveAttribute("aria-pressed","false");
  await page.goBack();
  await expect(page).toHaveURL(/\/watchlist$/);
  await expect(page.getByText("No saved wallets yet",{exact:true})).toBeVisible();
});
