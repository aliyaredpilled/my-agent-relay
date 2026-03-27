import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  /** Short aliases for target session keys, e.g. { "broker": "agent:broker:telegram:group:-123" } */
  targetAliases?: Record<string, string>;
  /** Per-agent auto-sign control. Keys are agent IDs, values are booleans. Default: true for all. */
  autoSign?: Record<string, boolean>;
  /** Default timezone for reminders, e.g. "Asia/Yekaterinburg" */
  defaultTimezone?: string;
}

// --- Reminders ---

interface Reminder {
  id: string;
  fireAt: number;
  sessionKey: string;
  message: string;
  client?: string;
  createdAt: number;
}

function loadReminders(path: string): Reminder[] {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return []; }
}

function saveReminders(path: string, reminders: Reminder[]): void {
  writeFileSync(path, JSON.stringify(reminders, null, 2));
}

// Singleton: only the first plugin instance manages reminders (plugin is loaded per-agent)
let remindersInitialized = false;

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
  const configKeys = Object.keys(pluginCfg);

  // Fallback: when loaded via resolvePluginTools fallback with empty config,
  // try to recover settings from the full OpenClaw config (api.config).
  const fullCfg = (api.config as any) ?? {};
  const fallbackPluginCfg = fullCfg?.plugins?.entries?.["agent-relay"]?.config as PluginConfig | undefined;
  const fallbackGatewayToken = fullCfg?.gateway?.auth?.token as string | undefined;

  const authToken = pluginCfg.authToken ?? fallbackPluginCfg?.authToken;
  const gatewayToken = pluginCfg.gatewayToken ?? fallbackPluginCfg?.gatewayToken ?? fallbackGatewayToken;
  const usedFallback = configKeys.length === 0 && (authToken || gatewayToken);

  api.logger.info(`agent-relay: plugin loaded (configKeys: [${configKeys.join(", ")}], hasPluginConfig: ${!!api.pluginConfig}${usedFallback ? ", recoveredFromFullConfig: true" : ""})`);

  if (!authToken && !gatewayToken) {
    api.logger.warn("agent-relay: missing config (authToken + gatewayToken) — no plugin config and no fallback available, tools will not be registered");
    return;
  }

  if (!authToken) {
    api.logger.info("agent-relay: no authToken — HTTP server will be disabled, tools still available");
  }
  if (!gatewayToken) {
    api.logger.warn("agent-relay: missing config.gatewayToken — will fall back to system events only");
  }

  const port = pluginCfg.port ?? fallbackPluginCfg?.port ?? 18790;
  const gatewayPort = pluginCfg.gatewayPort ?? fallbackPluginCfg?.gatewayPort ?? 18789;
  const allowedTargets = pluginCfg.allowedTargets ?? fallbackPluginCfg?.allowedTargets;
  const targetAliases = pluginCfg.targetAliases ?? fallbackPluginCfg?.targetAliases ?? {};
  const autoSignConfig = pluginCfg.autoSign ?? fallbackPluginCfg?.autoSign ?? {};
  const defaultTimezone = pluginCfg.defaultTimezone ?? fallbackPluginCfg?.defaultTimezone ?? "Asia/Yekaterinburg";
  const { enqueueSystemEvent, requestHeartbeatNow } = api.runtime.system;

  // Build agentId+channel → accountId lookup from bindings
  const accountIdMap = new Map<string, string>();
  const bindings = (api.config as any)?.bindings ?? [];
  for (const b of bindings) {
    if (b.agentId && b.match?.channel && b.match?.accountId) {
      accountIdMap.set(`${b.agentId}:${b.match.channel}`, b.match.accountId);
    }
  }
  api.logger.info(`agent-relay: accountId map: ${JSON.stringify(Object.fromEntries(accountIdMap))}`);

  // Cache sender metadata from message_received for auto-sign enrichment
  const senderCache = new Map<string, { name?: string; username?: string }>();

  // --- Reminders persistence ---
  const remindersPath = join(api.rootDir ?? ".", "reminders.json");
  const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function fireReminder(r: Reminder) {
    if (!gatewayToken) return;
    // Dedup: check reminder still exists in file (another instance may have already fired it)
    const all = loadReminders(remindersPath);
    if (!all.some((x) => x.id === r.id)) return;
    // Remove from file first (before delivery) to prevent double-fire on race
    saveReminders(remindersPath, all.filter((x) => x.id !== r.id));
    activeTimers.delete(r.id);

    const reminderParts = r.sessionKey.match(/^agent:([^:]+):([^:]+):(?:[^:]+:)*?(direct|group):(.+)$/);
    const reminderAgentId = reminderParts?.[1];
    const targetChannel = reminderParts?.[2];
    const targetTo = reminderParts?.[4];
    const reminderAccountId = reminderAgentId && targetChannel
      ? accountIdMap.get(`${reminderAgentId}:${targetChannel}`)
      : undefined;
    callGatewayAgent(
      { gatewayPort, gatewayToken, sessionKey: r.sessionKey, message: r.message, channel: targetChannel, to: targetTo, accountId: reminderAccountId },
      api.logger,
    ).then((result) => {
      if (result.ok) {
        api.logger.info(`agent-relay: reminder delivered to ${r.sessionKey} (client: ${r.client ?? "?"})`);
      } else {
        api.logger.warn(`agent-relay: reminder delivery failed: ${result.error}`);
      }
    });
  }

  function scheduleReminder(r: Reminder) {
    const delay = Math.max(0, r.fireAt - Date.now());
    const timer = setTimeout(() => fireReminder(r), delay);
    activeTimers.set(r.id, timer);
  }

  // Restore reminders from disk on startup (only once — first plugin instance wins)
  if (!remindersInitialized) {
    remindersInitialized = true;
    const saved = loadReminders(remindersPath);
    for (const r of saved) {
      scheduleReminder(r);
    }
    if (saved.length > 0) {
      api.logger.info(`agent-relay: restored ${saved.length} reminder(s) from disk`);
    }
  }

  api.logger.info(`agent-relay: device identity ${deviceIdentity.deviceId}`);

  // --- Agent Tool: notify_agent ---
  // Uses tool factory pattern so ctx.sessionKey is available even for sandbox agents.
  // The factory is called per-session; ctx.sessionKey comes from the gateway (host-side),
  // not from the sandbox, so it's always populated.
  if (gatewayToken) {
    api.registerTool((ctx) => ({
      name: "notify_agent",
      description:
        "Send a message to another agent in their existing session. The agent sees your message " +
        "with full conversation history and responds to the user via their channel (Telegram). " +
        "Use this to deliver responses, reminders, or instructions to other agents.",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description:
              'Target agent name (short alias), e.g. "broker". ' +
              "Configured aliases map this to the full session key automatically.",
          },
          sessionKey: {
            type: "string",
            description:
              "Full target session key (use this only if no alias is configured for the target).",
          },
          message: {
            type: "string",
            description: "Message to send to the agent (they will see it as a user message).",
          },
        },
        required: ["message"],
      },
      async execute(_id: string, params: { to?: string; sessionKey?: string; message: string }) {
        // Resolve target: alias → full sessionKey
        const resolvedKey = params.to
          ? targetAliases[params.to]
          : params.sessionKey;

        if (!resolvedKey) {
          const hint = params.to
            ? `Unknown alias "${params.to}". Available: ${Object.keys(targetAliases).join(", ") || "none"}`
            : "Missing sessionKey or to parameter.";
          return {
            content: [{ type: "text" as const, text: hint }],
            isError: true,
          };
        }

        // ctx.sessionKey is injected by the factory — works for sandbox agents too
        const callerKey = ctx.sessionKey;

        // Check ACL: does this agent have permission to wake the target?
        if (!isTargetAllowed(allowedTargets, callerKey, resolvedKey)) {
          api.logger.warn(`agent-relay: notify_agent blocked — ${callerKey} not allowed to target ${resolvedKey}`);
          return {
            content: [{
              type: "text" as const,
              text: `Not allowed: your agent is not permitted to wake session ${resolvedKey}. Check allowedTargets in plugin config.`,
            }],
            isError: true,
          };
        }

        // Auto-sign: prepend caller session key (configurable per agent)
        const callerAgent = callerKey?.match(/^agent:([^:]+):/)?.[1];
        const shouldSign = callerAgent ? (autoSignConfig[callerAgent] ?? true) : true;

        let prefix = "";
        if (callerKey && shouldSign) {
          prefix = `[from: ${callerKey}]\n`;
          // Enrich with sender metadata if available
          const sender = senderCache.get(callerKey);
          if (sender) {
            const parts = [sender.name, sender.username ? `@${sender.username}` : ""].filter(Boolean);
            if (parts.length) prefix += `[client: ${parts.join(" ")}]\n`;
          }
        }
        const signedMessage = prefix + params.message;

        api.logger.info(`agent-relay: notify_agent from=${callerKey ?? "unknown"} to=${params.to ?? ""}(${resolvedKey}) sign=${shouldSign}`);

        // Derive channel, delivery target, and accountId from target sessionKey
        // Format: agent:<agentId>:<channel>:[accountId:]<peerType>:<peerId>
        const targetParts = resolvedKey.match(/^agent:([^:]+):([^:]+):(?:[^:]+:)*?(direct|group):(.+)$/);
        const targetAgentId = targetParts?.[1];
        const targetChannel = targetParts?.[2];
        const targetTo = targetParts?.[4]; // peerId (chatId for telegram)
        // Resolve accountId from bindings (agentId !== accountId for wamm-survey)
        const targetAccountId = targetAgentId && targetChannel
          ? accountIdMap.get(`${targetAgentId}:${targetChannel}`)
          : undefined;

        const result = await callGatewayAgent(
          {
            gatewayPort,
            gatewayToken: gatewayToken!,
            sessionKey: resolvedKey,
            message: signedMessage,
            channel: targetChannel,
            to: targetTo,
            accountId: targetAccountId,
          },
          api.logger,
        );

        if (result.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Message delivered to ${params.to ?? resolvedKey}.`,
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
    }));
    api.logger.info("agent-relay: registered tool notify_agent (factory pattern)");

    // --- Tool: set_reminder ---
    api.registerTool((ctx) => ({
      name: "set_reminder",
      description:
        "Set a reminder that will be delivered back to the current conversation after a delay. " +
        "Use either 'minutes' for relative time or 'time' for an exact date/time.",
      parameters: {
        type: "object",
        properties: {
          minutes: {
            type: "number",
            description: "Deliver reminder after this many minutes (e.g. 30, 120).",
          },
          time: {
            type: "string",
            description:
              'Exact date/time in ISO format, e.g. "2026-03-26T12:00". ' +
              "If no timezone offset given, uses the configured default (Asia/Yekaterinburg).",
          },
          message: {
            type: "string",
            description: "Reminder text that will be delivered back to this conversation.",
          },
        },
        required: ["message"],
      },
      async execute(_id: string, params: { minutes?: number; time?: string; message: string }) {
        if (!params.minutes && !params.time) {
          return {
            content: [{ type: "text" as const, text: "Specify either 'minutes' or 'time'." }],
            isError: true,
          };
        }

        let fireAt: number;
        if (params.minutes) {
          fireAt = Date.now() + params.minutes * 60_000;
        } else {
          // Parse time — add timezone if not specified
          let timeStr = params.time!;
          if (!timeStr.includes("+") && !timeStr.includes("Z") && !timeStr.match(/\d{2}:\d{2}$/)) {
            // Resolve timezone offset
            try {
              const offsetMs = new Date().getTimezoneOffset() * 60_000;
              const inTz = new Date(new Date(timeStr).getTime()).toLocaleString("sv", { timeZone: defaultTimezone });
              fireAt = new Date(inTz).getTime();
              // Simpler: use Intl to get correct offset
              const now = new Date();
              const formatter = new Intl.DateTimeFormat("en", { timeZone: defaultTimezone, timeZoneName: "shortOffset" });
              const parts = formatter.formatToParts(now);
              const tzPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
              const match = tzPart.match(/GMT([+-]\d+)/);
              if (match) {
                timeStr += match[1].padStart(3, "0").replace(/^([+-])(\d)$/, "$10$2") + ":00";
              }
            } catch {}
            fireAt = new Date(timeStr).getTime();
          } else {
            fireAt = new Date(timeStr).getTime();
          }
        }

        if (isNaN(fireAt) || fireAt < Date.now() - 60_000) {
          return {
            content: [{ type: "text" as const, text: `Invalid or past time. Parsed: ${new Date(fireAt).toISOString()}` }],
            isError: true,
          };
        }

        const callerKey = ctx.sessionKey;
        if (!callerKey) {
          return {
            content: [{ type: "text" as const, text: "Cannot determine session — unable to set reminder." }],
            isError: true,
          };
        }

        const sender = senderCache.get(callerKey);
        const reminder: Reminder = {
          id: randomUUID(),
          fireAt,
          sessionKey: callerKey,
          message: `Напоминание: ${params.message}`,
          client: sender?.name,
          createdAt: Date.now(),
        };

        // Save to disk + schedule
        const all = loadReminders(remindersPath);
        all.push(reminder);
        saveReminders(remindersPath, all);
        scheduleReminder(reminder);

        const fireDate = new Date(fireAt);
        const formatter = new Intl.DateTimeFormat("ru", {
          timeZone: defaultTimezone,
          day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
        });
        const humanTime = formatter.format(fireDate);

        api.logger.info(`agent-relay: reminder set for ${callerKey} at ${fireDate.toISOString()} (client: ${sender?.name ?? "?"})`);

        return {
          content: [{
            type: "text" as const,
            text: `Reminder set for ${humanTime}. It will be delivered to this conversation automatically.`,
          }],
        };
      },
    }));
    api.logger.info("agent-relay: registered tool set_reminder");
  } else {
    api.logger.warn("agent-relay: gatewayToken missing — notify_agent and set_reminder NOT registered");
  }

  // Cache sender info: message_received has name but no sessionKey for custom channels,
  // before_agent_start has sessionKey but no sender name. Combine both.
  let pendingSender: { name?: string; username?: string } | null = null;

  api.on("message_received", (event: any, ctx: any) => {
    const sessionKey = ctx?.sessionKey;
    const name = event?.metadata?.senderName;
    const username = event?.metadata?.senderUsername;
    if (name || username) {
      if (sessionKey) {
        senderCache.set(sessionKey, { name, username });
      } else {
        // Custom channels (Max) don't pass sessionKey here — save for before_agent_start
        pendingSender = { name, username };
      }
    }
  });

  api.on("before_agent_start", (_event: any, ctx: any) => {
    if (pendingSender && ctx?.sessionKey) {
      senderCache.set(ctx.sessionKey, pendingSender);
      pendingSender = null;
    }
  });

  let server: Server | null = null;

  if (!authToken) {
    api.logger.info("agent-relay: HTTP server skipped (no authToken)");
    return;
  }

  server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method !== "POST" || (req.url !== "/notify" && req.url !== "/remind")) {
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

    // --- /remind endpoint ---
    if (req.url === "/remind") {
      const { sessionKey: rSessionKey, message: rMessage, minutes, time, client } = payload as any;
      if (!rSessionKey || !rMessage) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing required fields: sessionKey, message" }));
        return;
      }
      if (!minutes && !time) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Specify either 'minutes' or 'time'" }));
        return;
      }
      let fireAt: number;
      if (minutes) {
        fireAt = Date.now() + Number(minutes) * 60_000;
      } else {
        fireAt = new Date(String(time)).getTime();
      }
      if (isNaN(fireAt) || fireAt < Date.now() - 60_000) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Invalid or past time: ${new Date(fireAt).toISOString()}` }));
        return;
      }
      const reminder: Reminder = {
        id: randomUUID(),
        fireAt,
        sessionKey: rSessionKey,
        message: `Напоминание: ${rMessage}`,
        client,
        createdAt: Date.now(),
      };
      const all = loadReminders(remindersPath);
      all.push(reminder);
      saveReminders(remindersPath, all);
      scheduleReminder(reminder);
      api.logger.info(`agent-relay: HTTP reminder set for ${rSessionKey} at ${new Date(fireAt).toISOString()} (client: ${client ?? "?"})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, reminderId: reminder.id, fireAt: new Date(fireAt).toISOString() }));
      return;
    }

    // --- /notify endpoint ---
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

    // Resolve accountId from bindings for correct bot delivery
    const httpParts = sessionKey.match(/^agent:([^:]+):([^:]+):/);
    const httpAccountId = httpParts ? accountIdMap.get(`${httpParts[1]}:${httpParts[2]}`) : undefined;

    // Primary path: gateway WebSocket RPC (like subagent announce)
    if (gatewayToken) {
      const result = await callGatewayAgent(
        { gatewayPort, gatewayToken, sessionKey, message: signedHttpMessage, channel, to, accountId: httpAccountId },
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
      `agent-relay: listening on http://127.0.0.1:${port}/notify + /remind` +
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
