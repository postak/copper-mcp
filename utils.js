import { createHmac, timingSafeEqual } from "node:crypto";

export function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(msg) {
  return { content: [{ type: "text", text: JSON.stringify({ error: msg }, null, 2) }], isError: true };
}

export function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function signJwt(payload, secret) {
  const hdr = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac("sha256", secret).update(`${hdr}.${body}`).digest());
  return `${hdr}.${body}.${sig}`;
}

export function verifyJwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const [hdr, body, sig] = parts;
  const expected = b64url(createHmac("sha256", secret).update(`${hdr}.${body}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Invalid JWT signature");
  return JSON.parse(Buffer.from(body, "base64url").toString());
}

export const STATUS_MAP = { Open: 0, Won: 1, Lost: 2, Abandoned: 3 };

export function toUnixTimestamp(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return undefined;
}

export function toISODate(unixTs) {
  if (!unixTs) return null;
  const ts = typeof unixTs === "string" ? parseInt(unixTs, 10) : unixTs;
  if (!ts || isNaN(ts)) return null;
  const d = new Date(ts * 1000);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return null;
  return d.toISOString().slice(0, 10);
}

export function parseStatusInput(statuses) {
  if (!statuses || !statuses.length) return undefined;
  return statuses.map((s) => {
    const n = Number(s);
    if (!isNaN(n)) return n;
    const mapped = STATUS_MAP[s];
    if (mapped === undefined) throw new Error(`Unknown status: "${s}". Valid: Open, Won, Lost, Abandoned`);
    return mapped;
  });
}
