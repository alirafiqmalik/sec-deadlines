import { expect, test } from "@playwright/test";

const endpoint = "https://sec-deadlines-submissions.test-account.workers.dev";
let received;

async function open(page, enabled = true) {
  await page.route(endpoint + "/api/config", route => route.fulfill({ json: { enabled, siteKey: "browser-test-key" } }));
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js**", route => route.fulfill({ contentType: "application/javascript", body: `window.turnstile = {
    render(selector, options) { this.options = options; document.querySelector(selector).textContent = 'Bot verification (test stub)'; queueMicrotask(() => options.callback('test-only-token')); return 'test-widget'; },
    reset() { queueMicrotask(() => this.options.callback('test-only-token')); },
    remove() { document.querySelector('#venue-verification').textContent = ''; }
  };` }));
  await page.goto("./");
  await page.evaluate(api => document.getElementById("add-venue-dialog").dataset.api = api, endpoint);
  await page.getByRole("button", { name: "Add Venue", exact: true }).click();
  if (enabled) await expect(page.getByRole("button", { name: "Submit for review" })).toBeEnabled();
}

async function fill(page) {
  const form = page.locator("#add-venue-form");
  for (const [name, value] of Object.entries({ name: "Example S&P", link: "https://conference.org/", source: "https://conference.org/cfp", date: "June 12–14", place: "London, UK", description: "Security and privacy" })) await form.locator(`[name="${name}"]`).fill(value);
  await form.locator('[name="venue-topic"][value="SEC"]').check();
  await form.locator('[name="venue-kind"][value="CONF"]').check();
}

test("keyboard modal, mobile sizing, and existing deadlines remain usable", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await open(page);
  await expect(page.locator(":focus")).toHaveAttribute("name", "name");
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 720 });
    expect(await page.locator("#add-venue-dialog").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.locator("#add-venue-dialog")).not.toBeVisible();
  await expect(page.locator("#add-venue-btn")).toBeFocused();
  await page.waitForFunction(() => [...document.querySelectorAll('.timer')].every(el => el.textContent.trim()));
  const all = await page.locator(".conf").count();
  await page.locator("#show-past-checkbox").check();
  await expect(page.locator(".conf:visible")).toHaveCount(all);
  await page.locator("#SEC-checkbox").check();
  expect(await page.locator(".conf:visible:not(.SEC)").count()).toBe(0);
  await page.locator("#SEC-checkbox").uncheck();
  await page.locator("#hide-past-btn").click();
  expect(await page.locator(".conf.past:visible").count()).toBe(0);
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#delete-expired-btn").click();
  expect(await page.locator(".conf").count()).toBeLessThan(all);
  for (const href of await page.locator('a[href*="/ical/"]').evaluateAll(links => links.map(el => el.getAttribute("href")))) {
    const response = await page.request.get(href);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("BEGIN:VCALENDAR");
  }
  expect(errors).toEqual([]);
});

test("submits entirely in popup, prevents double clicks, and shows the PR", async ({ page }) => {
  let requests = 0, polls = 0;
  await page.route(endpoint + "/api/submissions", async route => {
    received = route.request().postDataJSON(); requests++;
    await new Promise(resolve => setTimeout(resolve, 100));
    await route.fulfill({ status: 202, json: { id: received.id, day: new Date().toISOString().slice(0, 10), status: "queued" } });
  });
  await page.route(endpoint + "/api/status?**", route => { polls++; return route.fulfill({ json: polls === 1 ? { status: "queued" } : { status: "created", prUrl: "https://github.com/alirafiqmalik/sec-deadlines/pull/123" } }); });
  await open(page); await fill(page);
  await page.locator("#venue-submit").dblclick();
  await expect(page.locator("#venue-status")).toContainText("Submission received");
  await page.locator("#venue-check").click();
  await expect(page.locator("#venue-pr-link")).toHaveAttribute("href", "https://github.com/alirafiqmalik/sec-deadlines/pull/123");
  expect(requests).toBe(1);
  expect(received.payload.venue.tags).toEqual(["CONF", "SEC"]);
  expect(received.payload.venue.deadline).toEqual(["TBA"]);
  expect(received.receipt).toMatch(/^[0-9a-f]{64}$/);
  await page.keyboard.press("Escape");
  await page.locator("#add-venue-btn").click();
  await expect(page.locator("#venue-pr-link")).toBeVisible();
  await page.locator("#venue-another").click();
  await expect(page.locator('#venue-fields [name="name"]')).toHaveValue("");
  await expect(page.locator("#venue-submit")).toBeEnabled();
});

test("rejects unsafe input locally and preserves fields when daily cap is reached", async ({ page }) => {
  let requests = 0;
  await page.route(endpoint + "/api/submissions", route => { requests++; return route.fulfill({ status: 429, json: { error: "The shared limit of five venues for today is reached." } }); });
  await open(page); await fill(page);
  await page.locator('[name="name"]').fill("<script>");
  await page.locator("#venue-submit").click();
  await expect(page.locator("#venue-status")).toContainText("plain text");
  expect(requests).toBe(0);
  await page.locator('[name="name"]').fill("Example S&P");
  await page.locator("#venue-submit").click();
  await expect(page.locator("#venue-status")).toContainText("limit of five");
  await expect(page.locator('[name="name"]')).toHaveValue("Example S&P");
  await expect(page.locator("#venue-submit")).toBeEnabled();
  expect(requests).toBe(1);
});

test("rejects a forged PR link and retains a receipt after a lost response", async ({ page }) => {
  await page.route(endpoint + "/api/submissions", route => route.abort());
  await page.route(endpoint + "/api/status?**", route => route.fulfill({ json: { status: "created", prUrl: "https://attacker.org/pull/1" } }));
  await open(page); await fill(page); await page.locator("#venue-submit").click();
  await expect(page.locator("#venue-status")).toContainText("connection was interrupted");
  await page.locator("#venue-check").click();
  await expect(page.locator("#venue-pr-link")).not.toBeVisible();
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("sec-deadlines:venue-submission:v1")).receipt)).toMatch(/^[0-9a-f]{64}$/);
});

test("keeps form disabled when backend is not ready", async ({ page }) => {
  await open(page, false);
  await expect(page.locator("#venue-status")).toContainText("temporarily unavailable");
  await expect(page.locator("#venue-submit")).toBeDisabled();
});

test("explains setup state when no production endpoint is configured", async ({ page }) => {
  await page.goto("./");
  await page.evaluate(() => document.getElementById("add-venue-dialog").dataset.api = "");
  await page.locator("#add-venue-btn").click();
  await expect(page.locator("#venue-status")).toHaveText("Venue submissions are being set up. Please try again later.");
  await expect(page.locator("#venue-submit")).toBeDisabled();
});
