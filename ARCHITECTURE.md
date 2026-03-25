# Agent Relay — архитектура, идеи и риски

## Исходная проблема

На vps5 работают два агента:
- **wamm-survey-agent** (sandbox) — общается с клиентами в Telegram и Max
- **broker** (без sandbox) — посредник, пересылает эскалации в группу поддержки

Клиент пишет wamm-survey-agent'у, тот не может ответить → эскалирует broker'у → broker пишет в группу поддержки → менеджер отвечает → broker пересылает ответ обратно wamm → wamm пишет клиенту.

**Главная сложность:** sandbox-агент изолирован от gateway. Он не знает свой session key, не может отправлять в чужие сессии, не имеет доступа к plugin API.

---

## Эволюция решений

### v1: curl через hooks (март 2026)

```
wamm (sandbox) → curl POST /hooks/escalate → gateway → broker
```

**Проблема:** wamm должен вручную составлять session key (`agent:wamm-survey-agent:telegram:direct:SENDER_ID`) в JSON payload curl'а. Модель часто ошибалась в формате, забывала sender_id, путала каналы.

### v2: notify_agent tool через agent-relay плагин (22 мар 2026)

```
wamm → notify_agent({ sessionKey: "agent:broker:...", message: "..." }) → gateway WS RPC → broker
```

**Улучшение:** нативный tool вместо curl. Но session key всё ещё передавался вручную.

**Проблема auto-sign:** плагин пытался добавить `[from: callerKey]` автоматически, но `context.sessionKey` был `undefined` для sandbox-агентов — OpenClaw не передаёт sessionKey в tool execute context для sandbox.

### v3: factory pattern + targetAliases (25 мар 2026)

```
wamm → notify_agent({ to: "broker", message: "Escalation:\nClient: Алия\nQuestion: ..." })
                                    ↓ плагин автоматически:
                     [from: agent:wamm-survey-agent:max:direct:170130617]
                     [client: Алия]
                     Escalation: ...
                                    ↓
                                  broker
```

**Ключевое открытие:** `registerTool` принимает не только tool, но и **фабрику** (`OpenClawPluginToolFactory`). Фабрика вызывается per-session на gateway (host-side), и `ctx.sessionKey` всегда доступен — даже для sandbox-агентов.

### v4: set_reminder (26 мар 2026)

```
wamm → set_reminder({ minutes: 30, message: "напомнить про договор" })
                      ↓
              плагин сохраняет в reminders.json + setTimeout
                      ↓ через 30 минут
              callGatewayAgent → wamm (та же сессия)
                      ↓
              wamm пишет клиенту напоминание
```

**Идея:** sandbox-агент не имеет cron tool, но плагин на хосте может ставить таймеры и доставлять сообщения через gateway WS RPC. Никакого broker'а в цепочке.

---

## Текущая архитектура

### Компоненты плагина

```
agent-relay/index.ts
├── Device Identity (Ed25519) — аутентификация в gateway WS
├── callGatewayAgent() — WebSocket RPC для отправки agent turn
├── notify_agent tool (factory pattern)
│   ├── targetAliases — to:"broker" → полный sessionKey
│   ├── auto-sign [from: sessionKey] — из ctx.sessionKey фабрики
│   ├── [client: name @username] — из senderCache
│   ├── autoSign per-agent — broker.sign=false
│   └── allowedTargets ACL
├── set_reminder tool (factory pattern)
│   ├── minutes / time параметры
│   ├── reminders.json persistence
│   ├── singleton (remindersInitialized)
│   └── dedup (проверка файла перед отправкой)
├── senderCache (message_received + before_agent_start)
├── HTTP server /notify (fallback endpoint)
└── System event fallback (enqueueSystemEvent)
```

### Потоки данных

**Эскалация (wamm → broker → менеджер):**
```
Клиент → wamm-survey-agent
           │ notify_agent({ to: "broker", message: "Escalation:..." })
           ↓
     agent-relay plugin
           │ ctx.sessionKey → [from: agent:wamm:...:direct:170130617]
           │ senderCache → [client: Алия @aliya_arkhangelsk]
           │ targetAliases["broker"] → agent:broker:telegram:group:-5143576301
           ↓
     callGatewayAgent (WS RPC)
           ↓
     broker (в группе поддержки)
           │ парсит [from: ...] → сохраняет в escalations.json
           │ пишет в группу: "🆘 Клиент Алия хочет уточнить: ..."
           ↓
     Менеджер отвечает в группе
           ↓
     broker
           │ notify_agent({ sessionKey: из escalations.json })
           │ autoSign: false → чистое сообщение без тегов
           ↓
     wamm-survey-agent → клиенту
```

**Напоминание (wamm → плагин → wamm):**
```
Клиент: "напомни через 30 минут про договор"
           ↓
     wamm-survey-agent
           │ set_reminder({ minutes: 30, message: "напомнить про договор" })
           ↓
     agent-relay plugin
           │ ctx.sessionKey → сохраняет в reminders.json
           │ setTimeout(30 * 60_000)
           ↓
     ... 30 минут ...
           ↓
     plugin: fireReminder()
           │ проверяет dedup в reminders.json
           │ callGatewayAgent → та же сессия wamm
           ↓
     wamm-survey-agent
           │ получает "Напоминание: напомнить про договор"
           │ пишет клиенту: "Алия, напоминаю про договор аренды! 📋"
```

---

## Риски и как мы их предотвратили

### 1. sessionKey undefined в sandbox

**Риск:** sandbox-агенты не получают sessionKey в tool execute context — auto-sign невозможен.

**Решение:** Factory pattern — `registerTool((ctx) => ({...}))`. Фабрика вызывается на gateway (host-side) per-session, ctx.sessionKey всегда доступен.

**Статус:** решено.

### 2. Агент вручную составляет session key

**Риск:** LLM может ошибиться в формате, забыть sender_id, перепутать канал. Обратная маршрутизация сломана.

**Решение:** Двухуровневое:
- auto-sign `[from: ...]` — плагин сам подставляет sessionKey
- targetAliases `to: "broker"` — агент вообще не знает session key

**Статус:** решено.

### 3. Модель всё равно вписывает Session в message

**Риск:** Даже с новым AGENTS.md модель по инерции добавляет `Session: ...` в текст сообщения (видела в training data или в старой истории).

**Решение:**
- Убрали все упоминания session key из AGENTS.md
- Явный запрет: "НЕ добавляй Session в message"
- Убрали слова "session key" из текста (модель цеплялась за `твой_session_key`)

**Статус:** решено (после нескольких итераций).

### 4. AGENTS.md не обновляется — 4 слоя кэша

**Риск:** Обновили AGENTS.md в workspace, но агент видит старую версию из agentDir/sandbox/JSONL.

**Решение:** Документированная процедура (README):
1. workspace-<agent>/AGENTS.md
2. agents/<agent>/AGENTS.md
3. rm -rf sandboxes/agent-<agent>-*
4. docker rm -f контейнеры
5. Удалить JSONL сессии + запись из sessions.json

**Статус:** решено, задокументировано.

### 5. Duplicate reminder delivery

**Риск:** Плагин загружается для каждого агента (wamm, broker, ...). Каждый инстанс читает reminders.json и ставит свой таймер → напоминание отправляется N раз.

**Решение:**
- `remindersInitialized` singleton — только первый инстанс загружает reminders
- Dedup в `fireReminder()` — проверяет что reminder ещё в файле перед отправкой
- Удаление из файла **до** delivery (не после) — prevents race

**Статус:** решено.

### 6. Reminders теряются при рестарте

**Риск:** setTimeout не переживает рестарт gateway.

**Решение:** Persistence в `reminders.json`:
- При set_reminder — сохраняем в файл
- При старте плагина — читаем файл, восстанавливаем таймеры
- Если fireAt уже прошёл — отправляем сразу
- После delivery — удаляем из файла

**Статус:** решено, протестировано (рестарт во время ожидания — reminder доставлен).

### 7. message_received не даёт sessionKey для Max

**Риск:** Кастомные channel-плагины (Max) не передают sessionKey в хуке message_received → senderCache не заполняется → [client: ...] тег пустой.

**Решение:** Двухэтапное кэширование:
- `message_received` — сохраняем имя в pendingSender (sessionKey пока нет)
- `before_agent_start` — привязываем pendingSender к sessionKey (который здесь уже доступен)

**Статус:** решено.

### 8. configSchema additionalProperties: false

**Риск:** При добавлении нового поля в конфиг плагина без обновления манифеста — gateway крашится.

**Решение:** Всегда обновлять `openclaw.plugin.json` (configSchema) при добавлении полей. Добавлено в чеклист деплоя.

**Статус:** решено (наступали дважды).

---

## Оставшиеся риски / TODO

### 1. pendingSender — race condition при параллельных сообщениях

Если два клиента напишут одновременно с разных каналов, `pendingSender` может перезаписаться. Решение: использовать Map по channelId+senderId вместо одной переменной.

**Серьёзность:** низкая (маловероятный сценарий, последствие — неправильное имя в [client:]).

### 2. reminders.json — нет retry при failed delivery

Если `callGatewayAgent` вернёт ошибку при доставке напоминания — reminder удаляется из файла и теряется. Можно добавить retry с backoff.

**Серьёзность:** низкая (gateway обычно доступен, ошибки редки).

### 3. Большое количество reminders

Все таймеры в памяти через setTimeout. При тысячах reminders может быть проблема. Для production-scale нужен proper scheduler (cron, at, или БД).

**Серьёзность:** низкая (текущий масштаб — единицы reminders).

### 4. Timezone parsing

Парсинг абсолютного времени (`time: "2026-03-26T12:00"`) с timezone'ом через Intl API — работает, но может быть хрупким для edge cases (DST переходы, нестандартные форматы).

**Серьёзность:** средняя. Можно улучшить при необходимости.

---

## Конфигурация на vps5

```json
{
  "plugins": {
    "entries": {
      "agent-relay": {
        "enabled": true,
        "config": {
          "authToken": "relay-notify-2026",
          "gatewayToken": "...",
          "port": 18790,
          "allowedTargets": {
            "wamm-survey-agent": ["agent:broker:telegram:group:-5143576301"],
            "broker": ["agent:wamm-survey-agent:*"]
          },
          "targetAliases": {
            "broker": "agent:broker:telegram:group:-5143576301"
          },
          "autoSign": {
            "wamm-survey-agent": true,
            "broker": false
          },
          "defaultTimezone": "Asia/Yekaterinburg"
        }
      }
    }
  }
}
```

tools.allow для wamm-survey-agent: `notify_agent`, `set_reminder`
tools.allow для broker: `notify_agent`
