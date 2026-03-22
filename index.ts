import { createServer, type Server } from "node:http";
import { randomUUID, generateKeyPairSync, createPrivateKey, sign, createHash, createPublicKey } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// Use ws library (OpenClaw dependency) — native WebSocket lacks .on() and may miss headers
const WS = require("ws") as typeof import("ws").default;

/**
 * agent-relay v2 — wake agents via gateway WebSocket RPC.
 *
 * Uses the same mechanism as subagent announce:
 * callGateway({ method: "agent" }) → agent turn in an existing session.
 *
 * Requires device identity (Ed25519 keypair) for gateway auth scopes.
 */

interface NotifyPayload {
  sessionKey?: string;
  message?: string;
  channel?: string;
  to?: string;
  callerAgent?: string;
}

interface PluginConfig {
  authToken?: string;
  port?: number;
  gatewayPort?: number;
  gatewayToken?: string;
  allowedTargets?: Record<string, string[]>;
}

// --- Target ACL ---

function isTargetAllowed(
  allowedTargets: Record<string, string[]> | undefined,
  callerSessionKey: string | undefined,
  targetSessionKey: string,
): boolean {
  if (!allowedTargets) return true; // no restrictions

  // Extract agentId from caller sessionKey: "agent:<agentId>:..."
  const callerAgent = callerSessionKey?.match(/^agent:([^:]+):/)?.[1];
  if (!callerAgent) return true; // can't identify caller — allow (HTTP has its own auth)

  const patterns = allowedTargets[callerAgent];
  if (!patterns) return true; // no rule for this agent — allow

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    // "agent:broker:*" matches "agent:broker:telegram:group:-123"
    if (pattern.endsWith(":*")) {
      return targetSessionKey.startsWith(pattern.slice(0, -1));
    }
    return targetSessionKey === pattern;
  });
}

// --- Device Identity (Ed25519) ---

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  // Ed25519 SPKI: 12-byte header + 32-byte raw key
  return spki.subarray(spki.length - 32);
}

function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return createHash("sha256").update(raw).digest("hex");
}

function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const deviceId = fingerprintPublicKey(publicKeyPem);
  return { deviceId, publicKeyPem, privateKeyPem };
}

function signPayload(privateKeyPem: string, payload: string): string {
  const key = createPrivateKey(privateKeyPem);
  const sig = sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
  platform: string;
}): string {
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
    params.platform,
    "", // deviceFamily
  ].join("|");
}

// Generate once per plugin lifetime
const deviceIdentity = generateDeviceIdentity();

// --- Gateway WebSocket RPC ---

async function callGatewayAgent(
  params: {
    gatewayPort: number;
    gatewayToken: string;
    sessionKey: string;
    message: string;
    channel?: string;
    to?: string;
    accountId?: string;
  },
  logger: OpenClawPluginApi["logger"],
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${params.gatewayPort}`;
    let ws: InstanceType<typeof WS>;

    try {
      ws = new WS(url);
    } catch (err) {
      resolve({ ok: false, error: `ws connect failed: ${err}` });
      return;
    }

    const connectId = randomUUID();
    const agentId = randomUUID();
    let settled = false;

    const done = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(result);
    };

    const timer = setTimeout(() => {
      done({ ok: false, error: "timeout (30s)" });
    }, 30_000);

    ws.on("error", (err: Error) => {
      done({ ok: false, error: `ws error: ${err.message}` });
    });

    ws.on("close", () => {
      done({ ok: false, error: "ws closed before response" });
    });

    ws.on("message", (data: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      // Step 1: connect.challenge → send connect with device identity
      if (msg.type === "event" && msg.event === "connect.challenge") {
        const nonce = msg.payload?.nonce;
        if (!nonce) {
          done({ ok: false, error: "missing nonce in challenge" });
          return;
        }

        const role = "operator";
        const scopes = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"];
        const signedAtMs = Date.now();

        const payload = buildDeviceAuthPayloadV3({
          deviceId: deviceIdentity.deviceId,
          clientId: "gateway-client",
          clientMode: "backend",
          role,
          scopes,
          signedAtMs,
          token: params.gatewayToken,
          nonce,
          platform: "linux",
        });
        const signature = signPayload(deviceIdentity.privateKeyPem, payload);

        ws.send(JSON.stringify({
          type: "req",
          id: connectId,
          method: "connect",
          params: {
            minProtocol: 1,
            maxProtocol: 3,
            client: {
              id: "gateway-client",
              version: "2.0.0",
              mode: "backend",
              platform: "linux",
            },
            auth: { token: params.gatewayToken },
            role,
            scopes,
            device: {
              id: deviceIdentity.deviceId,
              publicKey: base64UrlEncode(derivePublicKeyRaw(deviceIdentity.publicKeyPem)),
              signature,
              signedAt: signedAtMs,
              nonce,
            },
          },
        }));
        return;
      }

      if (msg.type !== "res") return;

      // Step 2: connect response → send agent request
      if (msg.id === connectId) {
        if (!msg.ok) {
          done({ ok: false, error: `connect rejected: ${msg.error?.message ?? "unknown"}` });
          return;
        }
        ws.send(JSON.stringify({
          type: "req",
          id: agentId,
          method: "agent",
          params: {
            sessionKey: params.sessionKey,
            message: params.message,
            deliver: true,
            idempotencyKey: randomUUID(),
            ...(params.channel ? { channel: params.channel } : {}),
            ...(params.to ? { to: params.to } : {}),
            ...(params.accountId ? { accountId: params.accountId } : {}),
          },
        }));
        return;
      }

      // Step 3: agent response
      if (msg.id === agentId) {
        if (msg.ok) {
          done({ ok: true });
        } else {
          done({ ok: false, error: `agent rejected: ${msg.error?.message ?? "unknown"}` });
        }
      }
    });
  });
}

export default function agentRelay(api: OpenClawPluginApi) {
  const pluginCfg = (api.pluginConfig ?? {}) as PluginConfig;

  const authToken = pluginCfg.authToken;
  if (!authToken) {
    api.logger.warn("agent-relay: missing config.authToken — disabled");
    return;
  }

  const gatewayToken = pluginCfg.gatewayToken;
  if (!gatewayToken) {
    api.logger.warn("agent-relay: missing config.gatewayToken — will fall back to system events only");
  }

  const port = pluginCfg.port ?? 18790;
  const gatewayPort = pluginCfg.gatewayPort ?? 18789;
  const allowedTargets = pluginCfg.allowedTargets;
  const { enqueueSystemEvent, requestHeartbeatNow } = api.runtime.system;

  api.logger.info(`agent-relay: device identity ${deviceIdentity.deviceId}`);

  // --- Agent Tool: notify_agent ---
  // Allows any agent (e.g. broker) to wake another agent via native tool call
  if (gatewayToken) {
    api.registerTool({
      name: "notify_agent",
      description:
        "Send a message to another agent in their existing session. The agent sees your message " +
        "with full conversation history and responds to the user via their channel (Telegram). " +
        "Use this to deliver responses, reminders, or instructions to other agents.",
      parameters: {
        type: "object",
        properties: {
          sessionKey: {
            type: "string",
            description:
              'Target agent session key, e.g. "agent:wamm-survey-agent:telegram:direct:647960541". ' +
              "Use sessions_list to find active sessions.",
          },
          message: {
            type: "string",
            description: "Message to send to the agent (they will see it as a user message).",
          },
        },
        required: ["sessionKey", "message"],
      },
      async execute(_id: string, params: { sessionKey: string; message: string }, context?: { sessionKey?: string }) {
        // Check ACL: does this agent have permission to wake the target?
        const callerKey = context?.sessionKey ?? (api as any).sessionKey;
        if (!isTargetAllowed(allowedTargets, callerKey, params.sessionKey)) {
          api.logger.warn(`agent-relay: notify_agent blocked — ${callerKey} not allowed to target ${params.sessionKey}`);
          return {
            content: [{
              type: "text" as const,
              text: `Not allowed: your agent is not permitted to wake session ${params.sessionKey}. Check allowedTargets in plugin config.`,
            }],
            isError: true,
          };
        }

        // Auto-sign: prepend caller info to message
        const signedMessage = callerKey
          ? `[from: ${callerKey}] ${params.message}`
          : params.message;

        // Derive accountId from target sessionKey for multi-bot setups
        const targetAgentId = params.sessionKey.match(/^agent:([^:]+):/)?.[1];

        const result = await callGatewayAgent(
          {
            gatewayPort,
            gatewayToken: gatewayToken!,
            sessionKey: params.sessionKey,
            message: signedMessage,
            accountId: targetAgentId,
          },
          api.logger,
        );

        if (result.ok) {
          api.logger.info(`agent-relay: notify_agent tool triggered for ${params.sessionKey}`);
          return {
            content: [
              {
                type: "text" as const,
                text: `Agent woken in session ${params.sessionKey}. They will see your message and respond to the user via their channel.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to wake agent: ${result.error}`,
            },
          ],
          isError: true,
        };
      },
    });
    api.logger.info("agent-relay: registered tool notify_agent");
  }

  let server: Server | null = null;

  server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method !== "POST" || req.url !== "/notify") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${authToken}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 10_000) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        return;
      }
    }

    let payload: NotifyPayload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const { sessionKey, message, channel, to, callerAgent } = payload;
    if (!sessionKey || !message) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required fields: sessionKey, message" }));
      return;
    }

    // Check ACL for HTTP callers (optional — callerAgent in payload)
    if (callerAgent && allowedTargets) {
      const callerKey = `agent:${callerAgent}:http`;
      if (!isTargetAllowed(allowedTargets, callerKey, sessionKey)) {
        api.logger.warn(`agent-relay: HTTP notify blocked — ${callerAgent} not allowed to target ${sessionKey}`);
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Not allowed: ${callerAgent} cannot target ${sessionKey}` }));
        return;
      }
    }

    // Auto-sign HTTP requests
    const signedHttpMessage = callerAgent
      ? `[from: agent:${callerAgent}] ${message}`
      : message;

    // Derive accountId from sessionKey for multi-bot setups
    const targetAgentId = sessionKey.match(/^agent:([^:]+):/)?.[1];

    // Primary path: gateway WebSocket RPC (like subagent announce)
    if (gatewayToken) {
      const result = await callGatewayAgent(
        { gatewayPort, gatewayToken, sessionKey, message: signedHttpMessage, channel, to, accountId: targetAgentId },
        api.logger,
      );

      if (result.ok) {
        api.logger.info(`agent-relay: agent turn triggered for ${sessionKey}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, method: "gateway-rpc" }));
        return;
      }

      api.logger.warn(`agent-relay: gateway RPC failed (${result.error}), falling back to system event`);
    }

    // Fallback: enqueueSystemEvent + requestHeartbeatNow (requires heartbeat config)
    const enqueued = enqueueSystemEvent(signedHttpMessage, { sessionKey });
    requestHeartbeatNow({ sessionKey, reason: "agent-relay" });

    api.logger.info(`agent-relay: fallback notify to ${sessionKey}, enqueued=${enqueued}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, method: "system-event-fallback", enqueued }));
  });

  server.listen(port, "127.0.0.1", () => {
    api.logger.info(
      `agent-relay: listening on http://127.0.0.1:${port}/notify` +
      (gatewayToken ? " (gateway RPC enabled)" : " (system event fallback only)"),
    );
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      api.logger.info(`agent-relay: port ${port} already in use (another plugin instance), skipping`);
      return;
    }
    api.logger.error(`agent-relay: server error: ${err.message}`);
  });
}
