import { OAuth2Client } from "google-auth-library";
import { randomUUID } from "node:crypto";
import { signJwt, verifyJwt } from "./utils.js";

export function createGoogleOAuthProvider({ serverUrl, googleClientId, googleClientSecret, jwtSecret }) {
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
