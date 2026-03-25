# Agent Relay — фичи (25 мар 2026)

## 1. Factory pattern для notify_agent

**Проблема:** sandbox-агенты не получали `sessionKey` в `context` при вызове tool — OpenClaw не передаёт его в sandbox execution context. Auto-sign `[from: ...]` всегда был пустым.

**Решение:** Вместо прямой регистрации tool используем фабрику:

```typescript
// БЫЛО:
api.registerTool({
    name: "notify_agent",
    async execute(_id, params, context) {
        const callerKey = context?.sessionKey; // undefined для sandbox!
    }
});

// СТАЛО:
api.registerTool((ctx) => ({
    name: "notify_agent",
    async execute(_id, params) {
        const callerKey = ctx.sessionKey; // всегда есть!
    }
}));
```

**Почему работает:** `OpenClawPluginToolFactory` вызывается per-session на gateway (host-side). `ctx.sessionKey` заполняется gateway'ем до того, как execution попадает в sandbox. Тип `OpenClawPluginToolContext` содержит `sessionKey`, `agentId`, `messageChannel`, `requesterSenderId` и другие поля.

**Где найдено:** тип `OpenClawPluginToolFactory` в `dist/plugin-sdk/src/plugins/types.d.ts` (строка ~100), `registerTool` принимает `AnyAgentTool | OpenClawPluginToolFactory`.

**Файл:** `agent-relay-plugin/index.ts`

---

## 2. Auto-sign `[from: sessionKey]`

**Проблема:** wamm-survey-agent вручную составлял session key в тексте эскалации (`Session: agent:wamm-survey-agent:telegram:direct:SENDER_ID`). Модель часто ошибалась в формате или забывала sender_id.

**Решение:** Плагин автоматически добавляет `[from: sessionKey]` в начало каждого сообщения notify_agent. Broker парсит этот тег для обратной маршрутизации.

```
[from: agent:wamm-survey-agent:max:direct:170130617]
Escalation:
Client: Алия
Question: ...
```

**Что изменено:**
- `agent-relay-plugin/index.ts` — auto-sign через `ctx.sessionKey` из фабрики
- `vps5-configs/wamm-survey-AGENTS.md` — убрана секция "Определение своей сессии", убрано поле Session из шаблонов
- `vps5-configs/broker-AGENTS.md` — broker теперь парсит `[from: ...]` вместо поля `Session:` в тексте

---

## 3. `[client: имя @username]` тег

**Проблема:** broker не знал имя и username клиента — эта информация была только в metadata входящего сообщения, недоступна на уровне tool execute.

**Решение:** Двухэтапное кэширование sender metadata:

1. Хук `message_received` ловит `senderName` и `senderUsername` из metadata
2. Для кастомных каналов (Max) `sessionKey` приходит как `undefined` в `message_received`, поэтому данные сохраняются в `pendingSender`
3. Хук `before_agent_start` привязывает `pendingSender` к `sessionKey` (который здесь уже доступен)

```typescript
let pendingSender = null;

api.on("message_received", (event, ctx) => {
    if (ctx?.sessionKey) {
        senderCache.set(ctx.sessionKey, { name, username });
    } else {
        pendingSender = { name, username };  // Max: sessionKey undefined
    }
});

api.on("before_agent_start", (_event, ctx) => {
    if (pendingSender && ctx?.sessionKey) {
        senderCache.set(ctx.sessionKey, pendingSender);
        pendingSender = null;
    }
});
```

**Результат:**
- Telegram: `[client: Алия @aliya_arkhangelsk]`
- Max: `[client: Алия]` (Max API не даёт username)

**Файл:** `agent-relay-plugin/index.ts`

---

## 4. targetAliases — `to: "broker"`

**Проблема:** Агент писал `sessionKey: "agent:broker:telegram:group:-5143576301"` — длинная строка, которую модель могла исказить.

**Решение:** Короткие алиасы в конфиге плагина:

```json
"targetAliases": {
    "broker": "agent:broker:telegram:group:-5143576301"
}
```

Агент пишет:
```
notify_agent({ to: "broker", message: "..." })
```

Плагин резолвит алиас в полный sessionKey. Если алиас не найден — возвращает ошибку со списком доступных.

**Что изменено:**
- `agent-relay-plugin/index.ts` — параметр `to` в tool, резолвинг через `targetAliases`
- `openclaw.plugin.json` — `targetAliases` в configSchema (обязательно, т.к. `additionalProperties: false`)
- `openclaw.json` на vps5 — `targetAliases: { "broker": "..." }` в config плагина
- `vps5-configs/wamm-survey-AGENTS.md` — шаблоны с `to: "broker"` вместо sessionKey

**Важно:** при добавлении нового поля в конфиг плагина — обновлять и `openclaw.plugin.json` (configSchema), иначе gateway крашится с `must NOT have additional properties`.

---

## 5. autoSign per-agent

**Проблема:** broker при ответе wamm-survey-agent'у тоже добавлял `[from: agent:broker:telegram:group:-5143576301]` — wamm видел технические теги, которые ему не нужны.

**Решение:** Конфигурируемый auto-sign per-agent:

```json
"autoSign": {
    "wamm-survey-agent": true,
    "broker": false
}
```

- `wamm → broker`: sign=true — broker видит `[from: ...]` + `[client: ...]` для маршрутизации
- `broker → wamm`: sign=false — агент получает чистое сообщение

```typescript
const callerAgent = callerKey?.match(/^agent:([^:]+):/)?.[1];
const shouldSign = callerAgent ? (autoSignConfig[callerAgent] ?? true) : true;
```

**Файлы:** `agent-relay-plugin/index.ts`, `openclaw.plugin.json`, `openclaw.json`

---

## 6. Документация: 4 слоя кэша AGENTS.md

**Проблема:** После обновления AGENTS.md агент продолжал видеть старую версию. Выяснили что AGENTS.md кэшируется в 4 местах + JSONL сессии.

**Где хранится:**

| # | Путь | Что это |
|---|------|---------|
| 1 | `~/.openclaw/workspace-<agent>/AGENTS.md` | Workspace (исходник) |
| 2 | `~/.openclaw/agents/<agent>/AGENTS.md` | AgentDir (копия!) |
| 3 | `~/.openclaw/sandboxes/agent-<agent>-*/` | Sandbox workspace (монтируется в Docker) |
| 4 | Docker контейнеры | Запущенные sandbox'ы |
| 5 | JSONL сессии | Агент помнит старый AGENTS.md из истории |

**Полная процедура обновления:**
```bash
# 1-2. Загрузить AGENTS.md в оба места (paramiko/scp)
# 3. rm -rf ~/.openclaw/sandboxes/agent-<agent>-*
# 4. docker rm -f $(docker ps -a --format '{{.Names}}' | grep openclaw-sbx-agent-<agent>)
# 5. rm ~/.openclaw/agents/<agent>/sessions/<sessionId>.jsonl
# 6. Удалить запись из sessions.json
```

**Записано в:** README.md (секция "Обновление AGENTS.md для sandbox-агентов")
