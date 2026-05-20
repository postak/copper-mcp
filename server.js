import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { OAuth2Client } from "google-auth-library";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

if (typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(); } catch {}
}

// --- Copper Config ---
const API_KEY = process.env.COPPER_API_KEY;
const USER_EMAIL = process.env.COPPER_USER_EMAIL;
const USER_ID = process.env.COPPER_USER_ID;
if (!API_KEY || !USER_EMAIL || !USER_ID) {
  console.error("COPPER_API_KEY, COPPER_USER_EMAIL, and COPPER_USER_ID environment variables are required");
  process.exit(1);
}

const BASE_URL = "https://api.copper.com/developer_api/v1";
const HEADERS = {
  "X-PW-AccessToken": API_KEY,
  "X-PW-Application": "developer_api",
  "X-PW-UserEmail": USER_EMAIL,
  "Content-Type": "application/json",
};

async function copperFetch(path, { method = "GET", body } = {}) {
  const opts = { method, headers: HEADERS };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Copper API ${res.status}: ${text}`);
  }
  return res.json();
}

async function resolveParentName(type, id, cache) {
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

function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function errorResult(msg) {
  return { content: [{ type: "text", text: JSON.stringify({ error: msg }, null, 2) }], isError: true };
}

// --- JWT Helpers ---
function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function signJwt(payload, secret) {
  const hdr = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac("sha256", secret).update(`${hdr}.${body}`).digest());
  return `${hdr}.${body}.${sig}`;
}

function verifyJwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const [hdr, body, sig] = parts;
  const expected = b64url(createHmac("sha256", secret).update(`${hdr}.${body}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Invalid JWT signature");
  return JSON.parse(Buffer.from(body, "base64url").toString());
}

// --- Google OAuth Provider ---
function createGoogleOAuthProvider({ serverUrl, googleClientId, googleClientSecret, jwtSecret }) {
  const callbackUrl = new URL("/google/callback", serverUrl).href;

  const registeredClients = new Map();
  const pendingAuth = new Map();  // googleState → {clientId, redirectUri, state, codeChallenge, expiresAt}
  const pendingCodes = new Map(); // authCode    → {email, clientId, codeChallenge, expiresAt}

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingAuth) if (v.expiresAt < now) pendingAuth.delete(k);
    for (const [k, v] of pendingCodes) if (v.expiresAt < now) pendingCodes.delete(k);
  }, 5 * 60 * 1000);
  cleanup.unref();

  return {
    // --- OAuthServerProvider interface ---

    get clientsStore() {
      return {
        getClient: async (clientId) => {
          let client = registeredClients.get(clientId);
          if (!client) {
            // Auto-register client to survive server restarts/redeploys in stateless environments (Cloud Run)
            client = {
              client_id: clientId,
              client_id_issued_at: Math.floor(Date.now() / 1000),
              redirect_uris: [
                "https://claude.ai/api/mcp/auth_callback",
                "https://claude.com/api/mcp/auth_callback"
              ],
              client_name: "Claude",
            };
            registeredClients.set(clientId, client);
          }
          return client;
        },
        registerClient: async (client) => {
          const registered = {
            ...client,
            client_id: client.client_id || randomUUID(),
            client_id_issued_at: Math.floor(Date.now() / 1000),
          };
          registeredClients.set(registered.client_id, registered);
          return registered;
        },
      };
    },

    async authorize(client, params, res) {
      const googleState = randomUUID();
      pendingAuth.set(googleState, {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        state: params.state,
        codeChallenge: params.codeChallenge,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", googleClientId);
      url.searchParams.set("redirect_uri", callbackUrl);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email");
      url.searchParams.set("state", googleState);
      url.searchParams.set("access_type", "online");
      res.redirect(url.toString());
    },

    async challengeForAuthorizationCode(_client, authorizationCode) {
      const entry = pendingCodes.get(authorizationCode);
      if (!entry) throw new Error("Invalid authorization code");
      return entry.codeChallenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode) {
      const entry = pendingCodes.get(authorizationCode);
      if (!entry || entry.expiresAt < Date.now()) {
        pendingCodes.delete(authorizationCode);
        throw new Error("Invalid or expired authorization code");
      }
      pendingCodes.delete(authorizationCode);

      const now = Math.floor(Date.now() / 1000);
      return {
        access_token: signJwt({
          sub: entry.email,
          iss: serverUrl,
          aud: serverUrl,
          iat: now,
          exp: now + 3600,
          client_id: client.client_id,
          scopes: [],
        }, jwtSecret),
        token_type: "bearer",
        expires_in: 3600,
      };
    },

    async exchangeRefreshToken() {
      throw new Error("Refresh tokens not supported — re-authenticate to get a new token");
    },

    async verifyAccessToken(token) {
      const payload = verifyJwt(token, jwtSecret);
      if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Token expired");
      if (payload.iss !== serverUrl) throw new Error("Invalid issuer");
      return {
        token,
        clientId: payload.client_id,
        scopes: payload.scopes ?? [],
        expiresAt: payload.exp,
        extra: { email: payload.sub },
      };
    },

    // --- Google callback handler (mounted as a separate Express route) ---

    async handleGoogleCallback(req, res) {
      try {
        const { code, state: googleState, error } = req.query;

        if (error) {
          res.status(400).send(`Google OAuth error: ${error}`);
          return;
        }
        if (!code || !googleState) {
          res.status(400).send("Missing code or state");
          return;
        }

        const pending = pendingAuth.get(googleState);
        if (!pending || pending.expiresAt < Date.now()) {
          pendingAuth.delete(googleState);
          res.status(400).send("Invalid or expired OAuth state — please restart the sign-in flow");
          return;
        }
        pendingAuth.delete(googleState);

        const oauth2Client = new OAuth2Client(googleClientId, googleClientSecret, callbackUrl);
        const { tokens } = await oauth2Client.getToken(code);
        const ticket = await oauth2Client.verifyIdToken({
          idToken: tokens.id_token,
          audience: googleClientId,
        });
        const email = ticket.getPayload().email;

        const authCode = randomUUID();
        pendingCodes.set(authCode, {
          email,
          clientId: pending.clientId,
          codeChallenge: pending.codeChallenge,
          expiresAt: Date.now() + 5 * 60 * 1000,
        });

        const redirectUrl = new URL(pending.redirectUri);
        redirectUrl.searchParams.set("code", authCode);
        if (pending.state) redirectUrl.searchParams.set("state", pending.state);
        res.redirect(redirectUrl.toString());
      } catch (err) {
        console.error("Google callback error:", err);
        res.status(500).send("Authentication failed");
      }
    },
  };
}

// --- MCP Server Factory ---
function createServer() {
  const server = new McpServer({
    name: "copper-crm",
    version: "1.0.0",
  });

  server.tool(
    "search_people",
    "Search Copper contacts by name, email, or phone. Returns matching person records with IDs for use in create_activity.",
    {
      name: z.string().optional().describe("Full name or partial name to search"),
      emails: z.array(z.string()).optional().describe("Email addresses to match"),
      phone_number: z.string().optional().describe("Phone number to match"),
      page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
    },
    async ({ name, emails, phone_number, page_size, page_number }) => {
      const body = {};
      if (name) body.name = name;
      if (emails) body.emails = emails;
      if (phone_number) body.phone_number = phone_number;
      body.page_size = page_size || 20;
      body.page_number = page_number || 1;

      const results = await copperFetch("/people/search", { method: "POST", body });
      const people = results.map((p) => ({
        id: p.id,
        name: p.name,
        first_name: p.first_name,
        last_name: p.last_name,
        emails: p.emails,
        phone_numbers: p.phone_numbers,
        company_id: p.company_id,
        company_name: p.company_name,
        title: p.title,
      }));
      return jsonResult(people);
    }
  );

  server.tool(
    "get_person",
    "Get full details of a Copper contact by their ID.",
    { person_id: z.number().describe("Copper person ID") },
    async ({ person_id }) => jsonResult(await copperFetch(`/people/${person_id}`))
  );

  server.tool(
    "create_person",
    "Create a new person (contact) in Copper CRM.",
    {
      first_name: z.string().describe("First name"),
      last_name: z.string().describe("Last name"),
      title: z.string().optional().describe("Job title"),
      company_name: z.string().optional().describe("Company name (Copper auto-links or creates)"),
      emails: z.array(z.object({
        email: z.string(),
        category: z.enum(["work", "personal", "other"]).optional()
      })).optional().describe("Email addresses"),
      phone_numbers: z.array(z.object({
        number: z.string(),
        category: z.enum(["work", "mobile", "home", "other"]).optional()
      })).optional().describe("Phone numbers"),
      tags: z.array(z.string()).optional().describe("Tags for categorization"),
      contact_type_id: z.number().optional().describe("Contact type ID"),
    },
    async ({ first_name, last_name, title, company_name, emails, phone_numbers, tags, contact_type_id }) => {
      const body = { name: `${first_name} ${last_name}` };
      if (first_name) body.first_name = first_name;
      if (last_name) body.last_name = last_name;
      if (title) body.title = title;
      if (company_name) body.company_name = company_name;
      if (emails) body.emails = emails;
      if (phone_numbers) body.phone_numbers = phone_numbers;
      if (tags) body.tags = tags;
      if (contact_type_id) body.contact_type_id = contact_type_id;
      return jsonResult(await copperFetch("/people", { method: "POST", body }));
    }
  );

  server.tool(
    "update_person",
    "Update an existing person (contact) in Copper CRM. Only include fields you want to change. The 'details' field is the 'About' section visible at the top of the contact page.",
    {
      person_id: z.number().describe("Copper person ID to update"),
      details: z.string().optional().describe("About/details text (visible at top of contact page in Copper UI)"),
      title: z.string().optional().describe("Job title"),
      tags: z.array(z.string()).optional().describe("Tags (replaces existing tags)"),
    },
    async ({ person_id, details, title, tags }) => {
      const body = {};
      if (details !== undefined) body.details = details;
      if (title !== undefined) body.title = title;
      if (tags !== undefined) body.tags = tags;
      const result = await copperFetch(`/people/${person_id}`, { method: "PUT", body });
      return jsonResult({ id: result.id, name: result.name, details: result.details, title: result.title, tags: result.tags });
    }
  );

  server.tool(
    "search_companies",
    "Search Copper companies by name. Returns matching company records.",
    {
      name: z.string().optional().describe("Company name to search"),
      page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
    },
    async ({ name, page_size, page_number }) => {
      const body = {};
      if (name) body.name = name;
      body.page_size = page_size || 20;
      body.page_number = page_number || 1;
      const results = await copperFetch("/companies/search", { method: "POST", body });
      return jsonResult(results.map((c) => ({
        id: c.id,
        name: c.name,
        email_domain: c.email_domain,
        phone_numbers: c.phone_numbers,
        websites: c.websites,
        address: c.address,
      })));
    }
  );

  server.tool(
    "list_activity_types",
    "List all available activity types in Copper (e.g., Note, Meeting, Phone Call). Returns activity_type_id values needed for create_activity.",
    {},
    async () => jsonResult(await copperFetch("/activity_types"))
  );

  server.tool(
    "create_activity",
    "Log an activity (meeting note, phone call, etc.) against a Copper person or company. Use list_activity_types first to get the correct activity_type_id.",
    {
      parent_type: z.enum(["person", "company"]).describe("Type of record to log against"),
      parent_id: z.number().describe("Copper ID of the person or company"),
      activity_type_id: z.number().describe("Activity type ID (from list_activity_types)"),
      details: z.string().describe("Activity content — meeting notes, action items, summary, etc. Use plain text, not markdown."),
      activity_date: z.number().optional().describe("Unix timestamp for when the activity occurred (default: now)"),
    },
    async ({ parent_type, parent_id, activity_type_id, details, activity_date }) => {
      const body = {
        parent: { type: parent_type, id: parent_id },
        type: { id: activity_type_id, category: "user" },
        user_id: parseInt(USER_ID),
        details,
      };
      if (activity_date) body.activity_date = activity_date;
      const result = await copperFetch("/activities", { method: "POST", body });
      return jsonResult({ id: result.id, parent: result.parent, type: result.type, details: result.details, activity_date: result.activity_date });
    }
  );

  server.tool(
    "list_opportunities",
    "Search Copper opportunities (deals). Optionally filter by name, company, person, status_ids, tags, minimum_close_date, maximum_close_date, pipeline_stage_ids, pipeline_ids. Returns deal name, value, status, and pipeline stage.",
    {
      name: z.string().optional().describe("Opportunity name to search"),
      company_ids: z.array(z.number()).optional().describe("Filter by company IDs"),
      person_ids: z.array(z.number()).optional().describe("Filter by associated person IDs"),
      page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
      status_ids: z.array(z.number()).optional().describe("Filter by status IDs"),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
      minimum_close_date: z.number().optional().describe("Filter by minimum close date (Unix timestamp)"),
      maximum_close_date: z.number().optional().describe("Filter by maximum close date (Unix timestamp)"),
      pipeline_stage_ids: z.array(z.number()).optional().describe("Filter by pipeline stage IDs"),
      pipeline_ids: z.array(z.number()).optional().describe("Filter by pipeline IDs"),
    },
    async ({ name, company_ids, person_ids, page_size, page_number, status_ids, tags, minimum_close_date, maximum_close_date, pipeline_stage_ids, pipeline_ids }) => {
      const body = {};
      if (name) body.name = name;
      if (company_ids) body.company_ids = company_ids;
      if (person_ids) body.person_ids = person_ids;
      if (status_ids) body.status_ids = status_ids;
      if (tags) body.tags = tags;
      if (minimum_close_date) body.minimum_close_date = minimum_close_date;
      if (maximum_close_date) body.maximum_close_date = maximum_close_date;
      if (pipeline_stage_ids) body.pipeline_stage_ids = pipeline_stage_ids;
      if (pipeline_ids) body.pipeline_ids = pipeline_ids;
      body.page_size = page_size || 20;
      body.page_number = page_number || 1;
      const results = await copperFetch("/opportunities/search", { method: "POST", body });
      return jsonResult(results.map((o) => ({
        id: o.id, name: o.name, company_id: o.company_id, company_name: o.company_name,
        monetary_value: o.monetary_value, status: o.status, pipeline_id: o.pipeline_id,
        pipeline_stage_id: o.pipeline_stage_id, close_date: o.close_date, win_probability: o.win_probability,
      })));
    }
  );

  server.tool(
    "list_activities",
    "Search Copper activities (meeting notes, calls, emails logged against contacts). Filter by parent record, activity type, or date range. Returns resolved parent names. Excludes system activities (assignee/status changes) by default.",
    {
      parent_type: z.enum(["person", "company", "lead", "opportunity", "project", "task"]).optional().describe("Filter by parent entity type"),
      parent_id: z.number().optional().describe("Filter by parent entity ID (requires parent_type)"),
      minimum_activity_date: z.number().optional().describe("Unix timestamp — only activities on or after this date"),
      maximum_activity_date: z.number().optional().describe("Unix timestamp — only activities on or before this date"),
      include_system: z.boolean().optional().describe("Include system activities like assignee/status changes (default: false)"),
      page_size: z.number().optional().describe("Results per page (default 20, max 200)"),
      page_number: z.number().optional().describe("Page number (default 1)"),
    },
    async ({ parent_type, parent_id, minimum_activity_date, maximum_activity_date, include_system, page_size, page_number }) => {
      const body = {};
      if (parent_type && parent_id) body.parent = { id: parent_id, type: parent_type };
      if (minimum_activity_date) body.minimum_activity_date = minimum_activity_date;
      if (maximum_activity_date) body.maximum_activity_date = maximum_activity_date;
      body.page_size = page_size || 200;
      body.page_number = page_number || 1;

      const results = await copperFetch("/activities/search", { method: "POST", body });
      const filtered = include_system ? results : results.filter((a) => a.type?.category === "user");
      const nameCache = new Map();
      const activities = await Promise.all(
        filtered.map(async (a) => {
          const parentType = a.parent?.type;
          const parentId = a.parent?.id;
          const parent_name = parentType && parentId
            ? await resolveParentName(parentType, parentId, nameCache)
            : null;
          return { id: a.id, parent: a.parent, parent_name, type: a.type, user_id: a.user_id, details: a.details, activity_date: a.activity_date, date_created: a.date_created, date_modified: a.date_modified };
        })
      );
      return jsonResult(activities);
    }
  );

  server.tool(
    "list_pipelines",
    "List all pipelines in Copper CRM. Returns pipeline IDs, names, and their stages — useful for filtering opportunities by pipeline_id or pipeline_stage_id.",
    {},
    async () => jsonResult(await copperFetch("/pipelines"))
  );

  return server;
}

// --- Start ---
async function main() {
  const useSse = process.argv.includes("--sse") || process.argv.includes("-sse") || process.env.PORT;

  if (useSse) {
    const portIndex = process.argv.indexOf("--port");
    const port = portIndex !== -1 ? parseInt(process.argv[portIndex + 1], 10) : parseInt(process.env.PORT || "3000", 10);

    // OAuth env vars required in HTTP mode
    const serverUrl = process.env.SERVER_URL;
    const googleClientId = process.env.COPPER_GOOGLE_CLIENT_ID;
    const googleClientSecret = process.env.COPPER_GOOGLE_CLIENT_SECRET;
    const jwtSecret = process.env.COPPER_JWT_SECRET;
    if (!serverUrl || !googleClientId || !googleClientSecret || !jwtSecret) {
      console.error("SERVER_URL, COPPER_GOOGLE_CLIENT_ID, COPPER_GOOGLE_CLIENT_SECRET, and COPPER_JWT_SECRET are required in HTTP mode");
      process.exit(1);
    }

    const oauthProvider = createGoogleOAuthProvider({ serverUrl, googleClientId, googleClientSecret, jwtSecret });
    const app = createMcpExpressApp({ host: "0.0.0.0" });
    const transports = {};

    // OAuth endpoints: /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource,
    //                  /authorize, /token, /register
    app.use(mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(serverUrl),
      baseUrl: new URL(serverUrl),
      resourceName: "Copper CRM MCP Server",
    }));

    // Google's redirect back after login
    app.get("/google/callback", (req, res) => oauthProvider.handleGoogleCallback(req, res));

    const bearerAuth = requireBearerAuth({ verifier: oauthProvider });

    // =============================================================================
    // STREAMABLE HTTP TRANSPORT (PROTOCOL VERSION 2025-11-25)
    // =============================================================================
    app.all("/mcp", bearerAuth, async (req, res) => {
      console.log(`Received ${req.method} request to /mcp`);
      try {
        const sessionId = req.headers["mcp-session-id"];
        let transport;
        if (sessionId && transports[sessionId]) {
          const existing = transports[sessionId];
          if (existing instanceof StreamableHTTPServerTransport) {
            transport = existing;
          } else {
            res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: Session exists but uses a different transport protocol" }, id: null });
            return;
          }
        } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              console.log(`StreamableHTTP session initialized: ${sid}`);
              transports[sid] = transport;
            },
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports[sid]) {
              delete transports[sid];
            }
          };
          const serverInstance = createServer();
          await serverInstance.connect(transport);
        } else {
          res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session ID provided" }, id: null });
          return;
        }
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error("Error handling MCP request:", error);
        if (!res.headersSent) {
          res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
        }
      }
    });

    // =============================================================================
    // DEPRECATED HTTP+SSE TRANSPORT (PROTOCOL VERSION 2024-11-05)
    // =============================================================================
    app.get("/sse", bearerAuth, async (req, res) => {
      console.log("Received GET request to /sse");
      try {
        const transport = new SSEServerTransport("/messages", res);
        const sessionId = transport.sessionId;
        transports[sessionId] = transport;
        res.on("close", () => {
          console.log(`SSE connection closed for session ${sessionId}`);
          delete transports[sessionId];
        });
        const serverInstance = createServer();
        await serverInstance.connect(transport);
        console.log(`SSE stream established, session: ${sessionId}`);
      } catch (error) {
        console.error("Error establishing SSE stream:", error);
        if (!res.headersSent) res.status(500).send("Error establishing SSE stream");
      }
    });

    app.post("/messages", bearerAuth, async (req, res) => {
      console.log("Received POST request to /messages");
      const sessionId = req.query.sessionId;
      if (!sessionId) {
        res.status(400).send("Missing sessionId parameter");
        return;
      }
      const existing = transports[sessionId];
      if (!(existing instanceof SSEServerTransport)) {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No SSE session found for sessionId" }, id: null });
        return;
      }
      try {
        await existing.handlePostMessage(req, res, req.body);
      } catch (error) {
        console.error("Error handling /messages request:", error);
        if (!res.headersSent) res.status(500).send("Error handling request");
      }
    });

    app.listen(port, (error) => {
      if (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
      }
      console.log(`Copper MCP Server listening on port ${port}`);
      console.log(`OAuth discovery: ${serverUrl}/.well-known/oauth-authorization-server`);
      console.log(`Endpoints: ${serverUrl}/mcp  |  ${serverUrl}/sse`);
    });

    process.on("SIGINT", async () => {
      console.log("Shutting down...");
      for (const sessionId in transports) {
        try { await transports[sessionId].close(); } catch {}
        delete transports[sessionId];
      }
      process.exit(0);
    });

  } else {
    // Stdio mode — no auth needed
    const serverInstance = createServer();
    const transport = new StdioServerTransport();
    await serverInstance.connect(transport);
    console.error("Copper MCP Server running in stdio mode");
  }
}

main().catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
