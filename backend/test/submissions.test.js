import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker.js";
import { digest, sign } from "../src/security.js";
import { validatePayload } from "../../static/js/venue-validation.js";

const origin = "https://alihamzamalik.me";
const year = new Date().getUTCFullYear();
const payload = (name = "Example S&P") => ({ schemaVersion: 1, source: "https://conference.org/cfp", venue: { name, year: year + 1, link: "https://conference.org/", deadline: [`${year}-11-30 23:59`], timezone: "Etc/GMT+12", date: `June ${year + 1}`, place: "London, UK", tags: ["SEC", "CONF"] } });
const data = () => ({ id: crypto.randomUUID(), receipt: "ab".repeat(32), payload: payload(), turnstileToken: "test-challenge" });
const config = () => ({ ...env, GITHUB_REPOSITORY: `test/${crypto.randomUUID()}` });
function request(body, headers = {}, path = "/api/submissions") {
  return new Request(`https://worker.example${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": crypto.randomUUID(), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
function external(verification = { success: true, action: "add_venue", hostname: "alihamzamalik.me" }, dispatchStatus = 204) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("/siteverify")) return Response.json(verification);
    if (String(url).includes("api.github.com")) return new Response(null, { status: dispatchStatus });
    throw new Error("Unexpected external request");
  });
}
afterEach(() => vi.restoreAllMocks());

describe("durable global quota", () => {
  it("accepts exactly five simultaneous submissions and survives eviction", async () => {
    const stub = env.SUBMISSIONS.get(env.SUBMISSIONS.newUniqueId());
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => stub.reserve(crypto.randomUUID(), `receipt-${i}`, `fingerprint-${i}`, `venue-${i}`, { payload: payload(`Venue ${i}`) })));
    expect(results.filter(r => r.accepted)).toHaveLength(5);
    expect(results.filter(r => r.reason === "daily_limit")).toHaveLength(25);
    await evictDurableObject(stub);
    expect((await stub.reserve(crypto.randomUUID(), "another", "another", "another", {})).reason).toBe("daily_limit");
    expect(await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT COUNT(*) AS n FROM submissions").one().n)).toBe(5);
  });

  it("does not consume another slot on retry or permit receipt guessing", async () => {
    const stub = env.SUBMISSIONS.get(env.SUBMISSIONS.newUniqueId());
    const id = crypto.randomUUID(), hash = await digest("receipt");
    expect((await stub.reserve(id, hash, "fingerprint", "venue", {})).fresh).toBe(true);
    expect((await stub.reserve(id, hash, "fingerprint", "venue", {})).fresh).toBe(false);
    expect(await stub.status(id, await digest("wrong"))).toBeNull();
    expect((await stub.reserve(crypto.randomUUID(), hash, "different", "venue", {})).reason).toBe("duplicate");
    await stub.result(id, "created", "https://github.com/test/repo/pull/1");
    await stub.result(id, "failed", null);
    expect((await stub.status(id, hash)).status).toBe("created");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.status(id, hash)).toBeNull();
  });
});

describe("public endpoint protection", () => {
  it("rejects unauthorized origins, content types, large streams, and malformed JSON before external calls", async () => {
    const spy = external();
    expect((await worker.fetch(request(data(), { Origin: "https://attacker.org" }), config())).status).toBe(403);
    expect((await worker.fetch(request(data(), { "Content-Type": "text/plain" }), config())).status).toBe(415);
    expect((await worker.fetch(request("x".repeat(9000)), config())).status).toBe(413);
    expect((await worker.fetch(request("{"), config())).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    { success: false, action: "add_venue", hostname: "alihamzamalik.me" },
    { success: true, action: "other", hostname: "alihamzamalik.me" },
    { success: true, action: "add_venue", hostname: "localhost" },
  ])("rejects invalid Turnstile result %j without dispatch", async verification => {
    const spy = external(verification);
    expect((await worker.fetch(request(data()), config())).status).toBe(403);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("validates the signature of the exact payload sent to the trusted workflow", async () => {
    const spy = external();
    const submission = data(), cfg = config();
    const response = await worker.fetch(request(submission), cfg);
    expect(response.status).toBe(202);
    const dispatch = JSON.parse(spy.mock.calls[1][1].body);
    expect(dispatch.ref).toBe("master");
    expect(dispatch.inputs.signature).toBe(await sign(dispatch.inputs.submission, cfg.SUBMISSION_SIGNING_KEY));
    const envelope = JSON.parse(dispatch.inputs.submission);
    expect(envelope.id).toBe(submission.id);
    expect(envelope.slot).toBe(1);
    const statusRequest = new Request(`https://worker.example/api/status?id=${submission.id}&day=${envelope.day}`, { headers: { Origin: origin, "X-Submission-Receipt": submission.receipt } });
    expect((await (await worker.fetch(statusRequest, cfg)).json()).status).toBe("queued");
  });

  it("rejects forged callbacks and invalid dates before creating an object", async () => {
    const cfg = config();
    const result = { day: new Date().toISOString().slice(0, 10), id: crypto.randomUUID(), status: "failed" };
    expect((await worker.fetch(request(result, {}, "/internal/result"), cfg)).status).toBe(403);
    const response = await worker.fetch(new Request(`https://worker.example/api/status?id=${result.id}&day=2026-99-99`, { headers: { Origin: origin, "X-Submission-Receipt": "ab".repeat(32) } }), cfg);
    expect(response.status).toBe(404);
  });

  it("keeps the quota consumed when GitHub's response is uncertain", async () => {
    external(undefined, 500);
    const cfg = config(), submission = data();
    expect((await (await worker.fetch(request(submission), cfg)).json()).status).toBe("reserved");
    submission.id = crypto.randomUUID();
    expect((await worker.fetch(request(submission), cfg)).status).toBe(409);
  });

  it("fails closed when deployment secrets are missing", async () => {
    expect((await worker.fetch(request(data()), { ...config(), TURNSTILE_SECRET: undefined })).status).toBe(503);
  });

  it("dispatches at most five distinct venues through the HTTP endpoint", async () => {
    const spy = external(), cfg = config();
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => {
      const submission = data(); submission.payload = payload(`HTTP Venue ${i}`);
      return worker.fetch(request(submission), cfg);
    }));
    expect(responses.filter(response => response.status === 202)).toHaveLength(5);
    expect(responses.filter(response => response.status === 429)).toHaveLength(3);
    expect(spy.mock.calls.filter(([url]) => String(url).includes("api.github.com"))).toHaveLength(5);
  });

  it("accepts only signed callbacks with this repository's PR URL and protects status receipts", async () => {
    external();
    const submission = data(), cfg = config();
    const accepted = await (await worker.fetch(request(submission), cfg)).json();
    async function callback(prUrl) {
      const raw = JSON.stringify({ id: submission.id, day: accepted.day, status: "created", prUrl });
      return worker.fetch(request(raw, { "X-Submission-Signature": await sign(raw, cfg.SUBMISSION_SIGNING_KEY) }, "/internal/result"), cfg);
    }
    expect((await callback("https://attacker.org/pull/1")).status).toBe(400);
    const prUrl = `https://github.com/${cfg.GITHUB_REPOSITORY}/pull/7`;
    expect((await callback(prUrl)).status).toBe(200);
    const url = `https://worker.example/api/status?id=${submission.id}&day=${accepted.day}`;
    const read = receipt => worker.fetch(new Request(url, { headers: { Origin: origin, "X-Submission-Receipt": receipt } }), cfg);
    expect((await read("00".repeat(32))).status).toBe(404);
    const response = await read(submission.receipt);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(await response.json()).toEqual({ status: "created", prUrl });
  });
});

describe("untrusted venue data", () => {
  it.each(["javascript:alert(1)", "http://conference.org", "https://127.0.0.1", "https://user:pass@conference.org", "https://conference.local", "https://conference.org/%250aBEGIN:VEVENT", "https://conference.org/%253cscript%253e"])("rejects unsafe URLs: %s", url => {
    const p = payload(); p.source = url;
    expect(() => validatePayload(p)).toThrow();
  });
  it.each(["</script><script>alert(1)</script>", "{{site.title}}", "$(curl attacker.org)", "x\nBEGIN:VEVENT"])("rejects executable names: %s", name => expect(() => validatePayload(payload(name))).toThrow());
  it("rejects impossible dates, traversal timezones, unknown fields, and tag injection", () => {
    for (const change of [{ deadline: [`${year}-02-30 23:59`] }, { timezone: "../../etc/passwd" }, { workflow: "run" }, { tags: ["SEC", "CONF", '" onclick="alert(1)'] }]) {
      const p = payload(); Object.assign(p.venue, change);
      expect(() => validatePayload(p)).toThrow();
    }
  });
});
