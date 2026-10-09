import { DurableObject } from "cloudflare:workers";
import { DAILY_LIMIT, MAX_BYTES, InvalidSubmission, validatePayload, venueKey } from "../../static/js/venue-validation.js";
import { digest, readBounded, sign, verify } from "./security.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ACTION = "add_venue";
const VERSION = "2026-10-09";

function reply(body, status = 200, origin, extra = {}) {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Vary": "Origin", ...(origin ? { "Access-Control-Allow-Origin": origin } : {}), ...extra,
  } });
}

function available(env) {
  return env.SUBMISSIONS_ENABLED === "true" && Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET && env.GITHUB_DISPATCH_TOKEN && env.SUBMISSION_SIGNING_KEY);
}

export class DailySubmissions extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY, receipt_hash TEXT NOT NULL, fingerprint TEXT UNIQUE NOT NULL,
        venue_key TEXT UNIQUE NOT NULL, slot INTEGER UNIQUE NOT NULL, envelope TEXT NOT NULL,
        status TEXT NOT NULL, pr_url TEXT, created INTEGER NOT NULL
      )`);
    });
  }

  async reserve(id, receiptHash, fingerprint, key, envelope) {
    const result = this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec("SELECT * FROM submissions WHERE id = ? OR fingerprint = ? OR venue_key = ?", id, fingerprint, key).toArray();
      if (existing.length) {
        const row = existing[0];
        if (row.id === id && row.receipt_hash === receiptHash && row.fingerprint === fingerprint) return { accepted: true, fresh: false, status: row.status, prUrl: row.pr_url };
        return { accepted: false, reason: "duplicate" };
      }
      const count = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM submissions").one().n;
      if (count >= DAILY_LIMIT) return { accepted: false, reason: "daily_limit" };
      envelope.slot = count + 1;
      this.ctx.storage.sql.exec("INSERT INTO submissions VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)", id, receiptHash, fingerprint, key, envelope.slot, JSON.stringify(envelope), "reserved", Date.now());
      return { accepted: true, fresh: true, envelope };
    });
    if (result.fresh) await this.ctx.storage.setAlarm(Date.now() + 8 * 86400000);
    return result;
  }

  dispatched(id) {
    this.ctx.storage.sql.exec("UPDATE submissions SET status = 'queued' WHERE id = ? AND status = 'reserved'", id);
  }

  result(id, status, prUrl) {
    const row = this.ctx.storage.sql.exec("SELECT status, pr_url FROM submissions WHERE id = ?", id).toArray()[0];
    if (!row) return false;
    // Never let an old failure notification undo a successful PR.
    if (row.status !== "created") this.ctx.storage.sql.exec("UPDATE submissions SET status = ?, pr_url = ? WHERE id = ?", status, prUrl || null, id);
    return true;
  }

  status(id, receiptHash) {
    const row = this.ctx.storage.sql.exec("SELECT status, pr_url FROM submissions WHERE id = ? AND receipt_hash = ?", id, receiptHash).toArray()[0];
    return row ? { status: row.status, prUrl: row.pr_url } : null;
  }

  async alarm() { this.ctx.storage.sql.exec("DELETE FROM submissions"); }
}

function object(env, day) {
  // Each repository/day is one coordination entity; five reservations share it.
  return env.SUBMISSIONS.getByName(`${env.GITHUB_REPOSITORY}:${day}`);
}

function recentDay(day) {
  const time = typeof day === "string" && DAY.test(day) ? Date.parse(day) : NaN;
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day && time <= Date.now() && Date.now() - time < 8 * 86400000;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowedOrigin = origin === env.ALLOWED_ORIGIN ? origin : undefined;
    if (url.pathname === "/health" && request.method === "GET") return reply({ ok: true, version: VERSION, ready: available(env) });
    if (url.pathname === "/internal/result") {
      if (request.method !== "POST" || !env.SUBMISSION_SIGNING_KEY) return reply({ error: "Not found." }, 404);
      try {
        const raw = await readBounded(request, 2000);
        if (!await verify(raw, request.headers.get("X-Submission-Signature"), env.SUBMISSION_SIGNING_KEY)) return reply({ error: "Forbidden." }, 403);
        const result = JSON.parse(raw);
        if (!recentDay(result.day) || !UUID.test(result.id) || !["created", "failed"].includes(result.status)) return reply({ error: "Invalid result." }, 400);
        if (result.status === "created" && !new RegExp(`^https://github\\.com/${env.GITHUB_REPOSITORY}/pull/[1-9][0-9]*$`).test(result.prUrl)) return reply({ error: "Invalid PR URL." }, 400);
        if (!await object(env, result.day).result(result.id, result.status, result.prUrl)) return reply({ error: "Not found." }, 404);
        return reply({ ok: true });
      } catch { return reply({ error: "Invalid result." }, 400); }
    }
    if (!allowedOrigin) return reply({ error: "This origin is not allowed." }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": allowedOrigin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Submission-Receipt", "Access-Control-Max-Age": "600", "Vary": "Origin",
    } });
    if (url.pathname === "/api/config" && request.method === "GET") return reply({ enabled: available(env), siteKey: env.TURNSTILE_SITE_KEY, dailyLimit: DAILY_LIMIT }, 200, allowedOrigin);
    const rate = await env.REQUEST_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
    if (!rate.success) return reply({ error: "Too many requests. Try again in a minute." }, 429, allowedOrigin, { "Retry-After": "60" });
    if (url.pathname === "/api/status" && request.method === "GET") {
      const id = url.searchParams.get("id"), day = url.searchParams.get("day"), receipt = request.headers.get("X-Submission-Receipt") || "";
      if (!UUID.test(id || "") || !recentDay(day) || !/^[0-9a-f]{64}$/.test(receipt)) return reply({ error: "Not found." }, 404, allowedOrigin);
      const status = await object(env, day).status(id, await digest(receipt));
      return reply(status || { error: "Not found." }, status ? 200 : 404, allowedOrigin);
    }
    if (url.pathname !== "/api/submissions" || request.method !== "POST") return reply({ error: "Not found." }, 404, allowedOrigin);
    if (!available(env)) return reply({ error: "Venue submissions are temporarily unavailable." }, 503, allowedOrigin);
    if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") return reply({ error: "Send JSON." }, 415, allowedOrigin);
    let data;
    try { data = JSON.parse(await readBounded(request, MAX_BYTES + 2600)); }
    catch (error) { return reply({ error: error.message === "too_large" ? "Submission is too large." : "Invalid JSON." }, error.message === "too_large" ? 413 : 400, allowedOrigin); }
    let payload;
    try {
      if (!data || Object.keys(data).sort().join() !== "id,payload,receipt,turnstileToken" || !UUID.test(data.id) || !/^[0-9a-f]{64}$/.test(data.receipt) || typeof data.turnstileToken !== "string" || !data.turnstileToken.length || data.turnstileToken.length > 2048) throw new InvalidSubmission("Invalid submission fields.");
      if (new TextEncoder().encode(JSON.stringify(data.payload)).length > MAX_BYTES) throw new InvalidSubmission("Submission is too large.");
      payload = validatePayload(data.payload);
    } catch (error) { return reply({ error: error instanceof InvalidSubmission ? error.message : "Invalid submission." }, 400, allowedOrigin); }
    try {
      const check = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST", signal: AbortSignal.timeout(10000), headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: data.turnstileToken, remoteip: request.headers.get("CF-Connecting-IP") || "" }),
      });
      const verification = JSON.parse(await readBounded(check, 8000));
      if (!check.ok || verification.success !== true || verification.action !== ACTION || verification.hostname !== env.TURNSTILE_HOSTNAME) return reply({ error: "Bot verification failed. Complete it again." }, 403, allowedOrigin);
    } catch { return reply({ error: "Bot verification is unavailable. Try again." }, 503, allowedOrigin); }
    const day = new Date().toISOString().slice(0, 10);
    const stub = object(env, day);
    const envelope = { version: 1, id: data.id, day, createdAt: new Date().toISOString(), payload };
    const reservation = await stub.reserve(data.id, await digest(data.receipt), await digest(JSON.stringify(payload)), venueKey(payload.venue), envelope);
    if (!reservation.accepted) return reply({ error: reservation.reason === "daily_limit" ? "The shared limit of five venues for today is reached. Try again after midnight UTC." : "This venue already has a submission today." }, reservation.reason === "daily_limit" ? 429 : 409, allowedOrigin);
    if (!reservation.fresh) return reply({ id: data.id, day, status: reservation.status, prUrl: reservation.prUrl }, 202, allowedOrigin);
    try {
      const raw = JSON.stringify(reservation.envelope);
      const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/venue-submission.yml/dispatches`, {
        method: "POST", signal: AbortSignal.timeout(15000), headers: {
          "Authorization": `Bearer ${env.GITHUB_DISPATCH_TOKEN}`, "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "sec-deadlines-submissions", "Content-Type": "application/json",
        }, body: JSON.stringify({ ref: env.GITHUB_BRANCH, inputs: { submission: raw, signature: await sign(raw, env.SUBMISSION_SIGNING_KEY) } }),
      });
      if (!response.ok) throw new Error(`dispatch_${response.status}`);
      await stub.dispatched(data.id);
      console.log(JSON.stringify({ event: "venue_queued", id: data.id, day, slot: reservation.envelope.slot }));
      return reply({ id: data.id, day, status: "queued" }, 202, allowedOrigin);
    } catch {
      // Keep the reservation: a network timeout may follow a successful dispatch.
      // This prevents a retry from creating extra PRs or bypassing the daily cap.
      console.error(JSON.stringify({ event: "venue_dispatch_uncertain", id: data.id, day }));
      return reply({ id: data.id, day, status: "reserved", message: "Submission received, but GitHub confirmation is delayed. Keep this window open to check its status." }, 202, allowedOrigin);
    }
  },
};
