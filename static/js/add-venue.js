import { MAX_BYTES, validatePayload } from "./venue-validation.js";

const dialog = document.getElementById("add-venue-dialog");
const form = document.getElementById("add-venue-form");
const fields = document.getElementById("venue-fields");
const submit = document.getElementById("venue-submit");
const status = document.getElementById("venue-status");
const prLink = document.getElementById("venue-pr-link");
const check = document.getElementById("venue-check");
const another = document.getElementById("venue-another");
const storageKey = "sec-deadlines:venue-submission:v1";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const year = new Date().getUTCFullYear();
form.elements.year.value = year + 1;
form.elements.year.min = year;
form.elements.year.max = year + 5;
let api, config, widget, token = "", loading = false, sending = false, pollTimer, job;

try {
  const saved = JSON.parse(sessionStorage.getItem(storageKey));
  if (saved && uuidPattern.test(saved.id) && /^[0-9a-f]{64}$/.test(saved.receipt) && /^\d{4}-\d{2}-\d{2}$/.test(saved.day) && Date.now() - saved.started < 8 * 86400000) job = saved;
} catch { /* Storage is optional. */ }

function message(text, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}

function remember() {
  try { if (job) sessionStorage.setItem(storageKey, JSON.stringify(job)); else sessionStorage.removeItem(storageKey); } catch { /* Private browsing may block storage. */ }
}

function refreshControls() {
  fields.disabled = !config?.enabled || sending || Boolean(job);
  submit.disabled = fields.disabled || !token;
  submit.hidden = Boolean(job);
  check.hidden = !job || job.finished;
  another.hidden = !job?.finished;
}

async function request(path, options = {}) {
  const response = await fetch(api + path, { ...options, credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(25000) });
  let body;
  try { body = await response.json(); } catch { throw new Error("The submission service returned an invalid response. Try again later."); }
  if (!response.ok) throw new Error(body.error || "The submission service could not complete this request.");
  return body;
}

let turnstileScript;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve();
  if (!turnstileScript) {
    turnstileScript = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = resolve;
      script.onerror = () => { script.remove(); turnstileScript = null; reject(new Error("Bot verification could not load. Check your connection and reopen the form.")); };
      document.head.append(script);
    });
  }
  return turnstileScript;
}

async function verification() {
  await loadTurnstile();
  if (!dialog.open || job || widget !== undefined) return;
  widget = window.turnstile.render("#venue-verification", {
    sitekey: config.siteKey, action: "add_venue", theme: "dark",
    callback: value => { token = value; refreshControls(); },
    "expired-callback": () => { token = ""; refreshControls(); },
    "error-callback": () => { token = ""; refreshControls(); message("Bot verification failed. Check your connection and try again.", true); },
  });
}

async function open() {
  dialog.showModal();
  if (loading) return;
  loading = true;
  try {
    const endpoint = new URL(dialog.dataset.api);
    if (!/^https:\/\/sec-deadlines-submissions\.[a-z0-9-]+\.workers\.dev$/.test(endpoint.origin) || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new Error("Venue submissions are being set up. Please try again later.");
    api = endpoint.origin;
    config = await request("/api/config");
    if (!config.enabled || typeof config.siteKey !== "string" || !config.siteKey) throw new Error("Venue submissions are temporarily unavailable. Please try again later.");
    refreshControls();
    if (job) await poll();
    else {
      message("Complete the form and bot verification to submit for review.");
      await verification();
      if (dialog.open) form.elements.name.focus();
    }
  } catch (error) { message(error.message === "Invalid URL" ? "Venue submissions are being set up. Please try again later." : error.message, true); }
  finally { loading = false; refreshControls(); }
}

function payloadFromForm() {
  const text = name => form.elements[name].value.trim();
  const venue = {
    name: text("name"), year: Number(text("year")), link: text("link"), date: text("date"), place: text("place"),
    deadline: text("deadline").split(/\r?\n/).map(v => v.trim()).filter(Boolean), timezone: text("timezone"),
    tags: [...form.querySelectorAll('input[name="venue-topic"]:checked, input[name="venue-kind"]:checked')].map(input => input.value),
  };
  if (text("rank")) venue.tags.push(text("rank"));
  for (const name of ["description", "dblp", "comment"]) if (text(name)) venue[name] = text(name);
  const payload = validatePayload({ schemaVersion: 1, source: text("source"), venue });
  if (new TextEncoder().encode(JSON.stringify(payload)).length > MAX_BYTES) throw new Error("The submission is too large. Shorten the notes or description.");
  return payload;
}

function safePr(url) {
  const escapedRepo = dialog.dataset.repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return typeof url === "string" && new RegExp(`^https://github\\.com/${escapedRepo}/pull/[1-9][0-9]*$`).test(url);
}

async function poll() {
  clearTimeout(pollTimer);
  if (!job || !dialog.open) return;
  check.disabled = true;
  try {
    const result = await request(`/api/status?id=${encodeURIComponent(job.id)}&day=${encodeURIComponent(job.day)}`, { headers: { "X-Submission-Receipt": job.receipt } });
    if (result.status === "created" && safePr(result.prUrl)) {
      message("Your pull request is ready for review. The venue appears on this page after it is merged.");
      prLink.href = result.prUrl;
      prLink.hidden = false;
      job.finished = true;
    } else if (result.status === "failed") {
      message("The request could not create a pull request. Its daily slot stays reserved. Ali can inspect the workflow logs. Check the venue details before submitting another request.", true);
      job.finished = true;
    } else message("Submission received. GitHub is preparing the pull request. You can close this form and reopen it in this tab to check its status.");
  } catch (error) { message(`${error.message} Your submission reference is ${job.id}.`, true); }
  finally {
    check.disabled = false;
    remember();
    refreshControls();
    // Four checks per minute leave room for submission and other requests.
    if (!job.finished && dialog.open && Date.now() - job.started < 10 * 60000) pollTimer = setTimeout(poll, 15000);
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (sending || job || !token) return;
  let payload;
  try { payload = payloadFromForm(); }
  catch (error) { message(error.message, true); status.focus(); return; }
  sending = true;
  refreshControls();
  message("Submitting your venue…");
  const candidate = { id: crypto.randomUUID(), receipt: Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join(""), day: new Date().toISOString().slice(0, 10), started: Date.now() };
  try {
    const result = await request("/api/submissions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: candidate.id, receipt: candidate.receipt, payload, turnstileToken: token }) });
    job = { ...candidate, day: result.day };
    remember();
    await poll();
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "TypeError") {
      // A dropped response may follow acceptance. Preserve the receipt to avoid duplicate requests.
      job = candidate;
      remember();
      message("The connection was interrupted. Check status before sending another request.", true);
    } else message(error.message, true);
  } finally {
    sending = false;
    token = "";
    if (widget !== undefined) window.turnstile.reset(widget);
    refreshControls();
  }
});

document.getElementById("add-venue-btn").addEventListener("click", open);
document.getElementById("venue-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  clearTimeout(pollTimer);
  if (widget !== undefined) { window.turnstile.remove(widget); widget = undefined; }
  token = "";
  document.getElementById("add-venue-btn").focus();
});
check.addEventListener("click", poll);
another.addEventListener("click", async () => {
  job = undefined;
  remember();
  form.reset();
  form.elements.year.value = year + 1;
  prLink.hidden = true;
  if (widget !== undefined) { window.turnstile.remove(widget); widget = undefined; }
  token = "";
  refreshControls();
  message("Complete the form and bot verification to submit for review.");
  try { await verification(); } catch (error) { message(error.message, true); }
});
