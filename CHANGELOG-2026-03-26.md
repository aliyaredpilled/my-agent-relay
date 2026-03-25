# Agent Relay + Context Meter — что починили 26 марта 2026

## Проблема 1: Футер context-meter приходил от бота broker'а вместо wamm

### Что происходило

Когда wamm-survey-agent отвечал клиенту в Telegram, плагин context-meter-lite отправлял футер `📊 10k / 200k (5%)`. Но этот футер приходил от бота **"Передатчик сообщений от агента"** (broker), а не от **"Подключение юридических лиц Скайнет Казань"** (wamm).

### Почему

В `openclaw.json` на vps5 было несоответствие между двумя местами:

```
channels.telegram.accounts:
  "wamm-survey-agent": { botToken: "8725..." }   <-- ключ "wamm-survey-agent"

bindings:
  { agentId: "wamm-survey-agent", match: { channel: "telegram", accountId: "wamm-survey" } }
                                                                              ^^^^^^^^^^^^
                                                                  а тут "wamm-survey" — НЕ совпадает!
```

Плагин context-meter-lite искал botToken так:
1. Находил binding для `wamm-survey-agent` + `channel=telegram` → `accountId = "wamm-survey"`
2. Искал `accounts["wamm-survey"]` → **не найден!** (ключ в accounts — `"wamm-survey-agent"`)
3. Fallback → первый попавшийся account → **broker** → футер шёл от бота broker'а

### Что сделали

Переименовали ключ в `channels.telegram.accounts`:
```
"wamm-survey-agent" → "wamm-survey"
```
Теперь account key совпадает с binding accountId.

**Почему не наоборот (binding → "wamm-survey-agent")?** Потому что тогда sessionKey содержал бы `wamm-survey-agent` дважды: `agent:wamm-survey-agent:telegram:wamm-survey-agent:direct:647960541` — путанно.

### Побочный эффект

После переименования нужно было удалить старую direct-сессию wamm'а (у неё в sessionKey был встроен старый accountId `wamm-survey-agent`). При следующем сообщении сессия пересоздалась с правильным accountId.

---

## Проблема 2: Relay не мог доставить сообщение broker'у — "Channel is required"

### Что происходило

wamm вызывал `notify_agent({ to: "broker", message: "..." })`, relay отправлял RPC в gateway, но gateway отвечал ошибкой:

```
Error: Channel is required when multiple channels are configured: telegram, max
```

### Почему

На vps5 настроено два канала: telegram и max. Когда relay вызывал `callGatewayAgent()`, он не передавал параметр `channel`. Gateway не знал через какой канал доставлять ответ.

### Что сделали

Relay теперь извлекает `channel` из target sessionKey:
```
agent:broker:telegram:group:-5143576301
             ^^^^^^^^
             channel = "telegram"
```

```typescript
const targetParts = resolvedKey.match(/^agent:([^:]+):([^:]+):(?:[^:]+:)*?(direct|group):(.+)$/);
const targetChannel = targetParts?.[2]; // "telegram"
```

---

## Проблема 3: Relay не мог доставить ответ — "Delivering to Telegram requires target chatId"

### Что происходило

После фикса channel ошибка изменилась:
```
Error: Delivering to Telegram requires target <chatId>
```

Gateway запустил agent turn для broker'а, broker сгенерировал ответ, но gateway не знал **куда именно** его отправить в Telegram — не хватало chatId.

### Почему

RPC `method: "agent"` с `deliver: true` требует не только `channel`, но и `to` (chatId получателя). Relay передавал только `channel`, но не `to`.

### Что сделали

Relay извлекает `to` (peerId/chatId) из того же sessionKey:
```
agent:broker:telegram:group:-5143576301
                            ^^^^^^^^^^^^
                            to = "-5143576301"
```

```typescript
const targetTo = targetParts?.[4]; // "-5143576301"
```

---

## Проблема 4: Ответ broker'а приходил от бота wamm вместо бота broker'а

### Что происходило

Relay успешно доставил сообщение broker'у, broker ответил в группу, но сообщение в группе приходило от бота **"Подключение юридических лиц"** (wamm), а не от **"Передатчик сообщений от агента"** (broker).

### Почему

Первоначально relay передавал `accountId: targetAgentId` — то есть agentId (`"broker"`, `"wamm-survey-agent"`) использовался как accountId. Для broker'а это работало (agentId `"broker"` === accountId `"broker"`), но для wamm — нет (`"wamm-survey-agent"` !== `"wamm-survey"`).

Потом мы убрали accountId из RPC полностью — и gateway не знал через какого бота отправлять. Он брал первый попавшийся → wamm-бот.

Проблема усугублялась тем, что сессия broker'а создавалась через relay RPC (а не через обычное сообщение из Telegram), поэтому `origin` сессии был пустой `{}` — gateway не мог определить accountId из origin.

### Что сделали

Relay теперь строит маппинг `agentId:channel → accountId` из конфига bindings при старте:

```typescript
const accountIdMap = new Map<string, string>();
const bindings = (api.config as any)?.bindings ?? [];
for (const b of bindings) {
  if (b.agentId && b.match?.channel && b.match?.accountId) {
    accountIdMap.set(`${b.agentId}:${b.match.channel}`, b.match.accountId);
  }
}
// Результат: { "wamm-survey-agent:telegram": "wamm-survey", "broker:telegram": "broker" }
```

При вызове RPC relay резолвит accountId из этого маппинга:
```typescript
const targetAccountId = accountIdMap.get(`${targetAgentId}:${targetChannel}`);
// broker:telegram → "broker"
// wamm-survey-agent:telegram → "wamm-survey"
```

Теперь gateway знает через какого бота отправлять, даже если origin сессии пустой.

---

## Проблема 5: Context-meter показывал ложное "сжат с 19k" у wamm

### Что происходило

```
[wamm]   📊 10k / 200k (5%) — сжат с 19k    <-- 19k — это НЕ wamm, это broker!
[broker] 📊 19k / 200k (9%)
```

### Почему

context-meter-lite хранил `lastTokensByChat` с ключом только по `chatId`. Когда и wamm и broker пишут одному пользователю (chatId=647960541), они делят одну запись:

1. wamm отвечает → `lastTokens["647960541"] = 10k`
2. broker отвечает → `lastTokens["647960541"] = 19k` (перезаписал!)
3. wamm (напоминание) → `prevTokens=19k`, `current=10k` → `19k > 10k * 1.3` → "сжат с 19k"

### Что сделали

Ключ теперь `agentId:chatId`:
```typescript
const tokenKey = `${entry.agentId}:${chatId}`;
const prevTokens = lastTokensByChat.get(tokenKey);
lastTokensByChat.set(tokenKey, usage.totalTokens);
```

---

## Итого: что изменилось в файлах

### openclaw.json на vps5
- `channels.telegram.accounts`: ключ `"wamm-survey-agent"` → `"wamm-survey"`

### agent-relay-plugin/index.ts
- `callGatewayAgent()` теперь принимает и передаёт `channel`, `to`, `accountId` в WS RPC
- `notify_agent` tool: извлекает `channel`, `to`, `accountId` из target sessionKey + bindings map
- `fireReminder()`: то же самое
- HTTP endpoint `/notify`: то же самое
- При старте строится `accountIdMap` из конфига bindings

### context-meter-lite/index.ts
- `lastTokensByChat` ключится по `agentId:chatId` вместо `chatId`
- `getBotToken()` — без изменений (фикс accountId в openclaw.json решил проблему)

---

## Полезно знать

### agentId vs accountId — в чём разница

- **agentId** = кто обрабатывает сообщения (мозг). Задаётся в `agents.list[].id`
- **accountId** = через какого бота отправлять (канал). Задаётся в `bindings[].match.accountId` и как ключ в `channels.telegram.accounts`

Они могут совпадать (broker: agentId=`"broker"`, accountId=`"broker"`), а могут нет (wamm: agentId=`"wamm-survey-agent"`, accountId=`"wamm-survey"`).

### Формат sessionKey

```
agent:<agentId>:<channel>:[<accountId>:]<peerType>:<peerId>

Примеры:
agent:broker:telegram:group:-5143576301              (5 частей, без accountId)
agent:wamm-survey-agent:telegram:direct:647960541    (5 частей, без accountId)
agent:wamm-survey-agent:telegram:wamm-survey:direct:647960541  (6 частей, с accountId — старый формат)
```

Gateway может включать или не включать accountId в sessionKey — зависит от того, как создавалась сессия.

### Почему relay должен передавать channel, to, accountId

Когда relay будит агента через `callGatewayAgent()` с `deliver: true`, gateway должен знать:
1. **channel** — через какой канал доставлять (telegram, max, ...)
2. **to** — кому доставлять (chatId в Telegram)
3. **accountId** — через какого бота доставлять (какой botToken использовать)

Если сессия была создана через обычное сообщение из Telegram, gateway берёт всё это из `session.origin`. Но если сессия создана через relay RPC (первый вызов), origin может быть пустым — поэтому relay сам передаёт эти параметры.
