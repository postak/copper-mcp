import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { rateLimit } from "express-rate-limit";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { randomUUID } from "node:crypto";
import { initCopperClient } from "./copper.js";
import { createGoogleOAuthProvider } from "./auth.js";
import { createServer } from "./tools.js";

if (typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(); } catch { }
}

const API_KEY = process.env.COPPER_API_KEY;
const USER_EMAIL = process.env.COPPER_USER_EMAIL;
if (!API_KEY || !USER_EMAIL) {
  console.error("COPPER_API_KEY and COPPER_USER_EMAIL environment variables are required");
  process.exit(1);
}

initCopperClient({ apiKey: API_KEY, userEmail: USER_EMAIL });

async function main() {
  const useSse = process.argv.includes("--sse") || process.argv.includes("-sse") || process.env.PORT;

  if (useSse) {
    const portIndex = process.argv.indexOf("--port");
    const port = portIndex !== -1 ? parseInt(process.argv[portIndex + 1], 10) : parseInt(process.env.PORT || "3000", 10);
    const noAuth = process.argv.includes("--no-auth");

    const app = createMcpExpressApp({ host: "0.0.0.0" });
    app.set("trust proxy", 1); // Trust Cloud Run's load balancer for X-Forwarded-For

    // Rate limiting to prevent abuse
    const apiLimiter = rateLimit({
      windowMs: 5 * 60 * 1000, // 5 minutes
      max: 200, // Limit each IP to 200 requests per `window`
      message: { jsonrpc: "2.0", error: { code: -32000, message: "Too many requests, please try again later." }, id: null }
    });
    app.use("/mcp", apiLimiter);
    app.use("/sse", apiLimiter);
    app.use("/messages", apiLimiter);
    app.use("/google/callback", apiLimiter);

    const transports = {};

    let bearerAuth = (req, res, next) => next();
    let serverUrl = process.env.SERVER_URL || `http://localhost:${port}`;

    if (!noAuth) {
      serverUrl = process.env.SERVER_URL;
      const googleClientId = process.env.COPPER_GOOGLE_CLIENT_ID;
      const googleClientSecret = process.env.COPPER_GOOGLE_CLIENT_SECRET;
      const jwtSecret = process.env.COPPER_JWT_SECRET;
      if (!serverUrl || !googleClientId || !googleClientSecret || !jwtSecret) {
        console.error("SERVER_URL, COPPER_GOOGLE_CLIENT_ID, COPPER_GOOGLE_CLIENT_SECRET, and COPPER_JWT_SECRET are required in HTTP mode");
        process.exit(1);
      }

      const oauthProvider = createGoogleOAuthProvider({ serverUrl, googleClientId, googleClientSecret, jwtSecret });

      // OAuth endpoints: /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource,
      //                  /authorize, /token, /register
      app.use(mcpAuthRouter({
        provider: oauthProvider,
        issuerUrl: new URL(serverUrl),
        baseUrl: new URL(serverUrl),
        resourceName: "Copper CRM MCP Server",
      }));

      app.get("/google/callback", (req, res) => oauthProvider.handleGoogleCallback(req, res));

      bearerAuth = requireBearerAuth({ verifier: oauthProvider });
    }

    app.get("/", (req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Copper MCP Server</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(22, 28, 45, 0.4);
      --border: rgba(255, 255, 255, 0.08);
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --accent: #6366f1;
      --accent-glow: rgba(99, 102, 241, 0.15);
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.2);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: 'Outfit', sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem 1rem;
      background-image: radial-gradient(circle at 50% 0%, rgba(99, 102, 241, 0.15) 0%, transparent 50%);
    }
    .container {
      width: 100%;
      max-width: 800px;
      backdrop-filter: blur(12px);
      background-color: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 3rem;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 2.5rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1.5rem;
    }
    h1 {
      font-size: 2.25rem;
      font-weight: 700;
      background: linear-gradient(135deg, #fff 0%, #a5b4fc 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }
    .subtitle { color: var(--text-muted); font-size: 1rem; }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--success-glow);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: var(--success);
      padding: 0.5rem 1rem;
      border-radius: 9999px;
      font-weight: 600;
      font-size: 0.875rem;
    }
    .status-dot {
      width: 8px; height: 8px;
      background-color: var(--success);
      border-radius: 50%;
      box-shadow: 0 0 10px var(--success);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }
    .info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.5rem; margin-bottom: 3rem; }
    .info-card {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 1.25rem;
      transition: all 0.3s ease;
    }
    .info-card:hover { border-color: rgba(99, 102, 241, 0.4); transform: translateY(-2px); background: rgba(99, 102, 241, 0.02); }
    .info-label { color: var(--text-muted); font-size: 0.875rem; margin-bottom: 0.25rem; }
    .info-value { font-size: 1.1rem; font-weight: 600; }
    .section-title { font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; color: #fff; }
    .endpoint-list { display: flex; flex-direction: column; gap: 1rem; margin-bottom: 3rem; }
    .endpoint-item {
      display: flex; align-items: center; justify-content: space-between;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1rem 1.25rem;
    }
    .endpoint-info { display: flex; align-items: center; gap: 1rem; }
    .method {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.75rem; font-weight: 700;
      padding: 0.25rem 0.5rem; border-radius: 6px;
    }
    .method.get { background: rgba(59, 130, 246, 0.15); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.3); }
    .method.post { background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); }
    .method.all { background: rgba(139, 92, 246, 0.15); color: #8b5cf6; border: 1px solid rgba(139, 92, 246, 0.3); }
    .path { font-family: 'JetBrains Mono', monospace; font-size: 0.95rem; color: #a5b4fc; }
    .copy-btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 0.5rem 0.75rem;
      border-radius: 8px; cursor: pointer;
      font-size: 0.875rem; font-weight: 500;
      transition: all 0.2s;
    }
    .copy-btn:hover { background: var(--accent); border-color: var(--accent); color: #fff; }
    .tools-list { display: grid; grid-template-columns: 1fr; gap: 0.75rem; }
    .tool-item {
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid var(--border);
      border-radius: 12px; padding: 1rem;
    }
    .tool-name { font-family: 'JetBrains Mono', monospace; color: #818cf8; font-weight: 600; font-size: 0.95rem; margin-bottom: 0.25rem; }
    .tool-desc { color: var(--text-muted); font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>Copper CRM MCP Server</h1>
        <div class="subtitle">Model Context Protocol interface for Copper</div>
      </div>
      <div class="status-badge">
        <div class="status-dot"></div>
        Online
      </div>
    </header>

    <div class="info-grid">
      <div class="info-card">
        <div class="info-label">Protocol</div>
        <div class="info-value">MCP (SSE / HTTP)</div>
      </div>
      <div class="info-card">
        <div class="info-label">Authentication</div>
        <div class="info-value">${noAuth ? 'None' : 'Google OAuth'}</div>
      </div>
      <div class="info-card">
        <div class="info-label">Version</div>
        <div class="info-value">1.0.0</div>
      </div>
    </div>

    <div class="section-title">Available Endpoints</div>
    <div class="endpoint-list">
      <div class="endpoint-item">
        <div class="endpoint-info">
          <span class="method all">ALL</span>
          <span class="path">/mcp</span>
        </div>
        <button class="copy-btn" onclick="copyEndpoint('/mcp')">Copy URL</button>
      </div>
      <div class="endpoint-item">
        <div class="endpoint-info">
          <span class="method get">GET</span>
          <span class="path">/sse</span>
        </div>
        <button class="copy-btn" onclick="copyEndpoint('/sse')">Copy URL</button>
      </div>
      <div class="endpoint-item">
        <div class="endpoint-info">
          <span class="method post">POST</span>
          <span class="path">/messages</span>
        </div>
        <button class="copy-btn" onclick="copyEndpoint('/messages')">Copy URL</button>
      </div>
    </div>

    <div class="section-title">Registered MCP Tools</div>
    <div class="tools-list">
      <div class="tool-item">
        <div class="tool-name">search_people</div>
        <div class="tool-desc">Search Copper contacts by name, email, or phone.</div>
      </div>
      <div class="tool-item">
        <div class="tool-name">get_person</div>
        <div class="tool-desc">Get full details of a Copper contact by their ID.</div>
      </div>
      <div class="tool-item">
        <div class="tool-name">create_person</div>
        <div class="tool-desc">Create a new person (contact) in Copper CRM.</div>
      </div>
      <div class="tool-item">
        <div class="tool-name">update_person</div>
        <div class="tool-desc">Update an existing person in Copper CRM.</div>
      </div>
      <div class="tool-item">
        <div class="tool-name">search_companies</div>
        <div class="tool-desc">Search Copper companies by name.</div>
      </div>
      <div class="tool-item">
        <div class="tool-name">list_activity_types</div>
        <div class="tool-desc">List available activity types (Note, Meeting, Phone Call, etc.).</div>
      </div>
      <div class="tool-item">
        <div class="tool-name">create_activity</div>
        <div class="tool-desc">Log an activity against a Copper person or company.</div>
      </div>
      <div class="tool-item">
        <div class="tool-name">list_opportunities</div>
        <div class="tool-desc">Search deals with enriched fields, ISO dates, and pagination metadata.</div>
      </div>
      <div class="tool-item">
        <div class="tool-name">create_opportunity</div>
        <div class="tool-desc">Create a new opportunity (deal/task) in Copper CRM.</div>
      </div>
      <div class="tool-item">
        <div class="tool-name">update_opportunity</div>
        <div class="tool-desc">Update an existing opportunity (deal/task) in Copper CRM.</div>
      </div>
      <div class="tool-item">
        <div class="tool-name">summarize_opportunities</div>
        <div class="tool-desc">Aggregate deals by stage, status, or owner — full dataset, no pagination needed.</div>
      </div>
      <div class="tool-item">
        <div class="tool-name">get_pipeline_funnel</div>
        <div class="tool-desc">Funnel view for a pipeline with per-stage metrics and YTD won/lost summary.</div>
      </div>
      <div class="tool-item">
        <div class="tool-name">get_stale_opportunities</div>
        <div class="tool-desc">Find open deals not updated in the last N days.</div>
      </div>
      <div class="tool-item">
        <div class="tool-name">list_activities</div>
        <div class="tool-desc">Search activities with resolved parent names and filters.</div>
      </div>
      <div class="tool-item">
        <div class="tool-name">list_pipelines</div>
        <div class="tool-desc">List all pipelines with their stages and IDs.</div>
      </div>
    </div>
  </div>

  <script>
    function copyEndpoint(path) {
      const fullUrl = window.location.origin + path;
      navigator.clipboard.writeText(fullUrl).then(() => {
        const btn = event.target;
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        btn.style.background = '#10b981';
        btn.style.borderColor = '#10b981';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.background = '';
          btn.style.borderColor = '';
        }, 1500);
      });
    }
  </script>
</body>
</html>`);
    });

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

    app.use((_req, res) => res.redirect("/"));

    app.listen(port, (error) => {
      if (error) {
        console.error("Failed to start server:", error);
        process.exit(1);
      }
      console.log(`Copper MCP Server listening on port ${port}`);
      if (!noAuth) {
        console.log(`OAuth discovery: ${serverUrl}/.well-known/oauth-authorization-server`);
      }
      console.log(`Endpoints: ${serverUrl}/mcp  |  ${serverUrl}/sse`);
    });

    process.on("SIGINT", async () => {
      console.log("Shutting down...");
      for (const sessionId in transports) {
        try { await transports[sessionId].close(); } catch { }
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
