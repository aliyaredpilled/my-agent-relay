# openclaw-agent-relay

Wake agents in their **existing sessions** via gateway WebSocket RPC. The agent sees your message with full conversation history and responds to the user through their channel (Telegram, Max, etc).

Think of it as `sessions_send` that actually delivers the response to the user, not to webchat.

## Why

`sessions_send` delivers agent responses to the internal `webchat` channel — the user never sees them. [Issue #13374](https://github.com/openclaw/openclaw/issues/13374) is closed as NOT_PLANNED.

This plugin uses the same gateway RPC mechanism as subagent announce (`callGateway({ method: "agent" })`) to trigger agent turns that deliver responses through the correct channel.

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

## Usage

### Tool: `wake_agent`

Any agent can call `wake_agent` as a native tool:

```
wake_agent({
  sessionKey: "agent:my-agent:telegram:direct:123456",
  message: "Hey, remind the client about the contract"
})
```

The target agent wakes up in their session, sees the message with full dialogue history, and responds to the user via Telegram/Max.

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
wake_agent({
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
2. On `/notify` or `wake_agent` call, connects to gateway via WebSocket
3. Authenticates with challenge-response (device signature + shared token)
4. Calls `method: "agent"` with `sessionKey`, `message`, `deliver: true`
5. Gateway runs an agent turn in the **existing** session (not isolated)
6. Agent sees the message with full conversation history
7. Response is delivered to the user via the session's channel

Falls back to `enqueueSystemEvent` + `requestHeartbeatNow` if gateway WebSocket is unavailable.

## Comparison

| | `sessions_send` | `wake_agent` |
|---|---|---|
| Agent sees message | Yes | Yes |
| Session context preserved | Yes | Yes |
| Response to Telegram/Max | **No** (webchat) | **Yes** |
| Agent formulates response | Yes | Yes |
| Available as tool | Yes (built-in) | Yes (plugin) |

## License

MIT
