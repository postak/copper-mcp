# copper-mcp

MCP server for the [Copper CRM](https://www.copper.com/) API. Search contacts, log activities, manage opportunities, and query companies.

## Tools

| Tool | Description |
|------|-------------|
| `search_people` | Search contacts by name, email, or phone |
| `get_person` | Get full contact details by ID |
| `create_person` | Create a new contact |
| `update_person` | Update contact fields |
| `search_companies` | Search companies by name |
| `list_activity_types` | List available activity types |
| `create_activity` | Log a meeting, call, or note against a contact/company |
| `list_activities` | Search activities with filters and resolved parent names |
| `list_opportunities` | Search deals/opportunities |

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your credentials:
   ```bash
   cp .env.example .env
   ```

   Required environment variables:
   - `COPPER_API_KEY` - Your Copper API key
   - `COPPER_USER_EMAIL` - Your Copper account email
   - `COPPER_USER_ID` - Your Copper user ID

## Usage with Claude Code via stdio interface

Add to your Claude Code MCP config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "copper-crm": {
      "command": "node",
      "args": ["/path/to/copper-mcp/server.js"],
      "env": {
        "COPPER_API_KEY": "your-api-key",
        "COPPER_USER_EMAIL": "your-email",
        "COPPER_USER_ID": "your-user-id"
      }
    }
  }
}
```

## Running with SSE Transport

The server supports running as a standalone HTTP server with SSE (Server-Sent Events) transport in addition to the default `stdio` transport.

### 1. Start the Server

To start the server in SSE mode, run:
```bash
npm run sse
```

Or manually:
```bash
node server.js --sse --port 3000
```

By default, the server listens on port `3000` (or the port defined by the `PORT` environment variable).

### 2. Configure in Client

- **Streamable HTTP** (Recommended / modern MCP protocol):
  - SSE Endpoint: `http://localhost:3000/mcp`
- **Deprecated HTTP + SSE** (For older clients):
  - SSE Endpoint: `http://localhost:3000/sse`
  - Message Endpoint: `http://localhost:3000/messages`

## Deploy to Cloud Run

### Prerequisites

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```
### 1. Create Oauth Client in Google Cloud Console

In Google Cloud console, go to **APIs & Services → Credentials**

Create a new **OAuth client ID** with type **Web application**
Set **Authorized redirect URIs** to `https://<cloud-run-url>/google/callback`

cloud-run-url: "https://<servicename>-<projectnumber>.<region>.run.app"

### 2. Create secrets in Secret Manager

```bash
echo -n "your-copper-api-key"    | gcloud secrets create COPPER_API_KEY    --data-file=-
echo -n "your-copper-email"      | gcloud secrets create COPPER_USER_EMAIL  --data-file=-
echo -n "your-copper-user-id"    | gcloud secrets create COPPER_USER_ID     --data-file=-
echo -n "your-google-client-id"  | gcloud secrets create COPPER_GOOGLE_CLIENT_ID   --data-file=-
echo -n "your-google-secret"     | gcloud secrets create COPPER_GOOGLE_CLIENT_SECRET --data-file=-
openssl rand -base64 32          | gcloud secrets create COPPER_JWT_SECRET         --data-file=-
```

### 2. Deploy to Cloud Run

Deploy directly from the local source. Cloud Run will automatically build the container image in the cloud using Cloud Build and deploy it:

```bash
SERVICE=copper-mcp
REGION=europe-west8
PROJECT_NUMBER=$(gcloud projects describe $(gcloud config get-value project) --format="value(projectNumber)")
SERVER_URL=https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app

gcloud run deploy ${SERVICE} \
  --source . \
  --region=${REGION} \
  --platform=managed \
  --no-allow-unauthenticated \
  --port=8080 \
  --set-env-vars=NODE_ENV=production,SERVER_URL=${SERVER_URL} \
  --set-secrets=COPPER_API_KEY=COPPER_API_KEY:latest,COPPER_USER_EMAIL=COPPER_USER_EMAIL:latest,COPPER_USER_ID=COPPER_USER_ID:latest,COPPER_GOOGLE_CLIENT_ID=COPPER_GOOGLE_CLIENT_ID:latest,COPPER_GOOGLE_CLIENT_SECRET=COPPER_GOOGLE_CLIENT_SECRET:latest,COPPER_JWT_SECRET=COPPER_JWT_SECRET:latest
```


### 3. Configure Claude Desktop

```json
{
  "mcpServers": {
    "copper-crm": {
      "type": "http",
      "url": "https://<cloud-run-url>/mcp"
    }
  }
}
```

On first connection Claude Desktop will open the browser for Google login.

### Google OAuth setup

Create an OAuth 2.0 client in **Google Cloud Console → API & Services → Credentials**:
- Type: **Web application**
- Consent screen: set to **Internal** (restricts access to your Workspace domain)
- Authorized redirect URI: `https://<cloud-run-url>/google/callback`

## License

MIT
