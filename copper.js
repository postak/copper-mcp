import { toISODate, parseCopperCloseDate } from "./utils.js";

const BASE_URL = "https://api.copper.com/developer_api/v1";
let HEADERS = {};

export function initCopperClient({ apiKey, userEmail }) {
  HEADERS = {
    "X-PW-AccessToken": apiKey,
    "X-PW-Application": "developer_api",
    "X-PW-UserEmail": userEmail,
    "Content-Type": "application/json",
  };
}

export async function copperFetch(path, { method = "GET", body } = {}) {
  const opts = { method, headers: HEADERS };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Copper API ${res.status}: ${text}`);
  }
  return res.json();
}

export async function copperFetchWithMeta(path, { method = "GET", body } = {}) {
  const opts = { method, headers: HEADERS };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Copper API ${res.status}: ${text}`);
  }
  const data = await res.json();
  const totalCount = res.headers.get("X-PW-TOTAL");
  return { data, total_count: totalCount ? parseInt(totalCount, 10) : null };
}

export async function resolveParentName(type, id, cache) {
  const key = `${type}:${id}`;
  if (cache.has(key)) return cache.get(key);
  const endpoints = {
    person: `/people/${id}`,
    company: `/companies/${id}`,
    lead: `/leads/${id}`,
    opportunity: `/opportunities/${id}`,
  };
  const endpoint = endpoints[type];
  if (!endpoint) {
    const fallback = `${type} #${id}`;
    cache.set(key, fallback);
    return fallback;
  }
  try {
    const record = await copperFetch(endpoint);
    const name = record.name || record.first_name
      ? [record.first_name, record.last_name].filter(Boolean).join(" ") || record.name
      : `${type} #${id}`;
    cache.set(key, name);
    return name;
  } catch {
    const fallback = `${type} #${id}`;
    cache.set(key, fallback);
    return fallback;
  }
}

export async function fetchPipelinesMap() {
  const pipelines = await copperFetch("/pipelines");
  const byId = new Map();
  const byName = new Map();
  for (const p of pipelines) {
    const stagesById = new Map();
    const stagesByName = new Map();
    for (const s of (p.stages || [])) {
      stagesById.set(s.id, { name: s.name, win_probability: s.win_probability });
      stagesByName.set(s.name.toLowerCase(), s.id);
    }
    const entry = { id: p.id, name: p.name, stagesById, stagesByName };
    byId.set(p.id, entry);
    byName.set(p.name.toLowerCase(), entry);
  }
  return { byId, byName };
}

export async function fetchAllOpportunities(baseBody) {
  const allResults = [];
  let page = 1;
  const pageSize = 200;
  while (true) {
    const body = { ...baseBody, page_size: pageSize, page_number: page };
    const results = await copperFetch("/opportunities/search", { method: "POST", body });
    allResults.push(...results);
    if (results.length < pageSize) break;
    page++;
  }
  return allResults;
}

export async function fetchUsersMap() {
  const users = await copperFetch("/users");
  const byId = new Map();
  for (const u of users) {
    const name = u.name || [u.first_name, u.last_name].filter(Boolean).join(" ") || null;
    byId.set(u.id, { id: u.id, name, email: u.email });
  }
  return byId;
}

export function mapOpportunity(o, pipelinesById = null, usersMap = null) {
  const pipeline = pipelinesById?.get(o.pipeline_id);
  const stage = pipeline?.stagesById?.get(o.pipeline_stage_id);
  const ownerId = o.assignee_id ?? o.owner_id ?? null;
  return {
    id: o.id,
    name: o.name,
    company_id: o.company_id,
    company_name: o.company_name,
    monetary_value: o.monetary_value,
    currency: o.currency ?? null,
    status: o.status,
    pipeline_id: o.pipeline_id,
    pipeline_stage_id: o.pipeline_stage_id,
    pipeline_stage_name: stage?.name ?? null,
    owner_id: ownerId,
    owner_name: ownerId && usersMap ? (usersMap.get(ownerId)?.name ?? null) : null,
    win_probability: o.win_probability,
    close_date: parseCopperCloseDate(o.close_date),
    created_at: toISODate(o.date_created),
    updated_at: toISODate(o.date_modified),
    tags: o.tags ?? [],
    won_reason: o.win_reason ?? o.won_reason ?? null,
    lost_reason: o.loss_reason ?? o.lost_reason ?? null,
  };
}
