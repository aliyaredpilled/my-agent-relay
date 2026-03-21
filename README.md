# openclaw-agent-relay

Wake agents in their **existing sessions** via gateway WebSocket RPC. The agent sees your message with full conversation history and responds to the user through their channel (Telegram, Discord, etc).

Think of it as `sessions_send` that actually delivers the response to the user, not to webchat.

## Why

Multi-agent setups need agents to talk to each other: a broker sends a reminder, a scheduler triggers a follow-up, a cron wakes an agent to check on a client. OpenClaw has `sessions_send` for this — but it doesn't solve the last mile: getting the response to the user.

### The `sessions_send` problem

`sessions_send` injects a message into another agent's session and preserves conversation history. But the agent's response goes to `channel=webchat` — an internal channel. The user on Telegram never sees it. [#13374](https://github.com/openclaw/openclaw/issues/13374) (closed NOT_PLANNED).

Worse, `sessions_send` can corrupt the target session's delivery context, flipping it from `telegram` to `webchat` for all subsequent messages ([#44153](https://github.com/openclaw/openclaw/issues/44153), [#31671](https://github.com/openclaw/openclaw/issues/31671)).

### Known workarounds and why they're fragile

**Workaround 1: agent calls `message` tool explicitly.** The target agent sends the response via `message` with `channel: "telegram"` and an explicit `to`/`threadId`, then returns `ANNOUNCE_SKIP`. This is the most common community workaround ([#47971](https://github.com/openclaw/openclaw/issues/47971), [#44153](https://github.com/openclaw/openclaw/issues/44153), [#28603](https://github.com/openclaw/openclaw/issues/28603)). But it has two problems: you have to embed delivery instructions in every `sessions_send` payload, and **the agent tends to forget to use it**. From the agent's perspective, it just received a message and is responding normally — it doesn't know its reply won't reach the user. So it writes a perfectly good response that goes straight to webchat. You can prompt it to call the message tool every time, but it drifts, especially in longer sessions.

**Workaround 2: rely on announce step.** When `sessions_send` uses `timeout=0`, the target agent gets an announce step where it can write a response that gets delivered to Telegram. This technically works — but in practice the model tends to return `ANNOUNCE_SKIP` instead of writing the actual message. Even with explicit instructions, it "forgets" and skips the announce area. This is a known LLM behavior pattern ([#43295](https://github.com/openclaw/openclaw/issues/43295)) — models generate responses first and check rules second, if at all. You can fight this with very short prompts or runtime enforcement (`recallBeforeResponse`), but it remains unreliable.

On top of that, announce delivery itself has issues:
- Drops `threadId` for Telegram topics ([#47971](https://github.com/openclaw/openclaw/issues/47971), [#45878](https://github.com/openclaw/openclaw/issues/45878))
- Silently fails with multi-channel setups ([#47524](https://github.com/openclaw/openclaw/issues/47524))
- `ANNOUNCE_SKIP` text can leak to the user's Telegram ([#45084](https://github.com/openclaw/openclaw/issues/45084))

### What this plugin does instead

`openclaw-agent-relay` bypasses `sessions_send` and announce entirely. It uses the same gateway RPC mechanism as subagent announce (`callGateway({ method: "agent" })`) to run an agent turn in the **existing session** with `deliver: true`. The agent responds normally — no special instructions, no `ANNOUNCE_SKIP`, no message tool workarounds — and the response goes straight to Telegram.

## Install

```bash
openclaw plugins install openclaw-agent-relay
```

## Configure

Add to `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "openclaw-agent-relay": {
        enabled: true,
        config: {
          authToken: "your-secret-token",      // for HTTP endpoint auth
          gatewayToken: "copy-from-gateway.auth.token", // from your openclaw.json
          // port: 18790,        // HTTP endpoint port (default: 18790)
          // gatewayPort: 18789, // gateway WS port (default: 18789)
        }
      }
    }
  }
}
```

`gatewayToken` is the same token from `gateway.auth.token` in your `openclaw.json`.

### Restrict who can wake whom

Use `allowedTargets` to limit which agents can target which sessions:

```json5
{
  plugins: {
    entries: {
      "openclaw-agent-relay": {
        enabled: true,
        config: {
          authToken: "your-secret-token",
          gatewayToken: "copy-from-gateway.auth.token",
          allowedTargets: {
            // wamm can only wake the broker
            "wamm-survey-agent": ["agent:broker:*"],
            // broker can only wake wamm
            "broker": ["agent:wamm-survey-agent:*"]
          }
        }
      }
    }
  }
}
```

Patterns support trailing `:*` wildcards. Omit `allowedTargets` to allow all agents to wake any session.

## Usage

### Tool: `notify_agent`

Any agent can call `notify_agent` as a native tool:

```
notify_agent({
  sessionKey: "agent:my-agent:telegram:direct:123456",
  message: "Hey, remind the client about the contract"
})
```

The target agent wakes up in their session, sees the message with full dialogue history, and responds to the user via Telegram.

### HTTP: POST /notify

For cron jobs, scripts, or external systems:

```bash
curl -X POST http://127.0.0.1:18790/notify \
  -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionKey": "agent:my-agent:telegram:direct:123456",
    "message": "Reminder: client asked for the contract"
  }'
```

### Parameters

| Field | Required | Description |
|-------|----------|-------------|
| `sessionKey` | Yes | Target session key (`agent:<agentId>:<channel>:<type>:<peerId>`) |
| `message` | Yes | Message text (agent sees it as a user message) |
| `channel` | No | Override delivery channel |
| `to` | No | Override delivery recipient |

## Example: what happens inside

### Broker wakes another agent via tool call

```
👤 USER (to broker)
"Remind the WAMM client about the rental contract"

🤖 BROKER → tool call
notify_agent({
  sessionKey: "agent:wamm-survey:telegram:direct:647960541",
  message: "Remind the client they requested a rental contract. Ask when is convenient to send it."
})

⚙️ TOOL RESULT
"Agent woken in session agent:wamm-survey:telegram:direct:647960541.
 They will see your message and respond to the user via their channel."

🤖 BROKER
"Done! WAMM agent will remind the client about the contract."
```

Meanwhile, in the **WAMM agent's session** (with full conversation history):

```
... (previous dialogue with client about documents) ...

👤 [injected by relay — agent sees this as a user message]
"Remind the client they requested a rental contract. Ask when is convenient to send it."

🤖 WAMM AGENT → responds in Telegram
"Здравствуйте! Напоминаю — вы просили договор аренды.
 Когда вам удобно его получить? Могу отправить прямо сейчас."
```

The client sees the message **from the WAMM bot** in Telegram — not from the broker, not from webchat.

### External trigger via HTTP

```
# Cron job at 9:00 AM
curl -X POST http://127.0.0.1:18790/notify \
  -H "Authorization: Bearer relay-notify-2026" \
  -d '{"sessionKey":"agent:support:telegram:direct:123456",
       "message":"Morning check: any pending tickets from yesterday?"}'

# Response:
{"ok": true, "method": "gateway-rpc"}

# The support agent wakes up in their Telegram session and responds to the user
```

## How it works

1. Plugin generates an Ed25519 device identity at startup
2. On `/notify` or `notify_agent` call, connects to gateway via WebSocket
3. Authenticates with challenge-response (device signature + shared token)
4. Calls `method: "agent"` with `sessionKey`, `message`, `deliver: true`
5. Gateway runs an agent turn in the **existing** session (not isolated)
6. Agent sees the message with full conversation history
7. Response is delivered to the user via the session's channel

Falls back to `enqueueSystemEvent` + `requestHeartbeatNow` if gateway WebSocket is unavailable.

## Comparison

| | `sessions_send` | `notify_agent` |
|---|---|---|
| Agent sees message | Yes | Yes |
| Session context preserved | Yes | Yes |
| Response to Telegram | **No** (webchat) | **Yes** |
| Agent formulates response | Yes | Yes |
| Available as tool | Yes (built-in) | Yes (plugin) |

## License

MIT
