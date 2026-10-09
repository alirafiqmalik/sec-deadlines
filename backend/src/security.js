export async function readBounded(request, maximum) {
  if (Number(request.headers.get("Content-Length")) > maximum) throw new Error("too_large");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new Error("too_large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder("utf-8", { fatal: true }).decode(result);
}

export async function digest(value) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sign(value, secret) {
  return hex(await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(value)));
}

export async function verify(value, signature, secret) {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const bytes = new Uint8Array(signature.match(/../g).map(b => parseInt(b, 16)));
  return crypto.subtle.verify("HMAC", await hmacKey(secret), bytes, new TextEncoder().encode(value));
}
