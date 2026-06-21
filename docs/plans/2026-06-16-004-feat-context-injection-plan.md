---
date: 2026-06-16
seq: "004"
type: feat
title: "feat: Context injection — B2B API surface for existing chatbots, server-side fetch + MCP server"
origin: docs/brainstorms/2026-06-13-importacion-contexto-ia-requirements.md (R16, R17, F4)
depends_on:
  - docs/plans/2026-06-13-001-feat-importacion-pipeline-plan.md
  - docs/plans/2026-06-16-002-feat-embeddable-widget-plan.md
  - docs/plans/2026-06-16-003-feat-consumer-chatbot-app-plan.md
---

# feat: Context injection

## Summary

API + MCP server que un B2B customer (con su propio chatbot/AI feature ya implementado) usa para inyectar el perfil sintetizado del visitante en su pipeline. Dos superficies: (a) REST API server-side fetch — el B2B customer llama a la API desde su backend con API key (header) + `visitorId` (query param), recibe el perfil JSON, lo prepende al system prompt de su bot. (b) MCP server (`mcp.contextlayer.io`) que expone tools (`get_user_profile`, `get_user_signals`) para bots que soportan MCP (Claude, Cursor, etc.). El linking visitor ↔ ContextLayer user es **implicit via localStorage + cross-origin auth popup** (patron estandar de OAuth/passwordless): el visitor que ya esta logueado en ContextLayer (`context-layer-user` key en localStorage de `app.contextlayer.io`) es reconocido automaticamente cuando entra al sitio del B2B; el widget abre un popup a `auth.contextlayer.io/connect?tenant=X&redirect_uri=...`, el visitor confirma (1 click si ya esta logueado, login Firebase si no), recibe un `visitorId` opaco (`vs_xxx`) firmado por ContextLayer, lo guarda en su session, y el B2B puede empezar a fetchear. Cero copy-paste de codigos, cero coordinacion fuera-de-banda.

**Business model:** B2B revenue. Pricing: per-call (por cada profile fetch) o per-visitor-connected (cuota mensual). TBD en pricing track; el rate limit + metering es el primer entregable de este plan.

---

## Problem Frame

STRATEGY.md posiciona a ContextLayer como "red de contexto" que se vende a B2B customers. Track 2 (widget) cubre el caso del B2B que no tiene IA y quiere nuestro chat UI. Track 4 cubre el caso opuesto: el B2B que ya tiene un chatbot funcionando (Intercom Fin, custom RAG, Claude API directo) y quiere mejorarlo con contexto del visitante sin reemplazar su stack.

F4 del brainstorm define el flow: A3 (sitio integrado) consulta el perfil de A1 (visitante) via la API de ContextLayer, verifica que A1 otorgo acceso, y devuelve el perfil sintetizado para que A3 lo use como contexto.

Track 1 dejo este flow sin implementar: la coleccion `siteAccess` esta stubbeada, no hay endpoint de grant, no hay API de fetch cross-user. Track 4 cierra ese gap con la superficie completa de integracion B2B, separada de la UI (Track 2).

**Por que localStorage + auth popup (no linking code)**: el flow original de este plan usaba linking codes one-time (`cl-link-XXXX-XXXX`, 15min, single-use) que el visitor generaba en `/settings/links` y entregaba al B2B. Conversion esperada: <5% (4-5 pasos, copy-paste entre apps distintas, coordinacion fuera-de-banda). El flow implicit via localStorage es el patron estandar de OAuth/passwordless auth (asi funcionan "Sign in with Google", Magic Links, etc): 2-3 pasos, todo dentro del browser, zero copy-paste. El visitor en device nuevo simplemente re-hace el auth (entendible, edge case). Razonamiento detallado en la seccion "Auth model" de KTD mas abajo.

---

## Requirements

**Server-side API surface**

R1. `GET /api/v1/inject/profile?visitor_id=<id>` retorna el perfil sintetizado del visitante. Auth: API key del B2B customer en header `Authorization: Bearer <b2bKey>`. Retorna `200 { profile: {...} }` o `404 { error: "no_profile" }` si el visitante no tiene perfil, o `403 { error: "not_connected" }` si el visitante no concedio acceso a este B2B.
R2. `GET /api/v1/inject/signals?visitor_id=<id>&types=<csv>` retorna solo las senales solicitadas (`preferences`, `personalFacts`, `activeIntentions`, `domainsOfInterest`). Mismo auth. Optimizacion: el B2B customer puede pedir solo lo que necesita (menos tokens en el system prompt).
R3. `POST /api/v1/inject/context` es el endpoint "smart" que retorna el system prompt ya construido: recibe `{ visitor_id, custom_system_prompt?, include_types? }` y retorna `{ system_prompt, token_count, model_recommendation }`. El B2B customer puede usar esto directo sin construir el prompt ellos mismos.
R4. Rate limits por B2B customer: default 1000 calls/dia, 100 calls/min (configurable per B2B). 429 con `Retry-After` header si excede.
R5. Response time objetivo: p95 < 200ms para R1/R2 (read de Firestore), p95 < 500ms para R3 (incluye token counting).
R6. **No streaming**: estos endpoints son sync (single response). El streaming es del LLM del B2B customer, no nuestro.

**MCP server surface**

R7. MCP server en `mcp.contextlayer.io` con tools:
- `get_user_profile(visitor_id: string) -> { profile: object }` — mismo shape que R1
- `get_user_signals(visitor_id: string, types: string[]) -> { signals: object }` — mismo shape que R2
- `get_system_prompt(visitor_id: string, custom_addition?: string) -> { system_prompt: string, token_count: number }` — mismo shape que R3
- `list_connections() -> { visitors: [{ id, connected_at, scopes }] }` — para bots que quieren saber a que profiles tienen acceso
R8. Auth al MCP server: misma API key (Bearer) que el API REST. El server MCP traduce las tool calls a calls internos al mismo backend.
R9. El MCP server se describe a si mismo via `tools/list`: nombre, descripcion, input schema, output schema. Compatible con Claude Desktop, Cursor, y otros MCP clients.

**Connection / grant flow (implicit via localStorage + cross-origin auth popup)**

R10. **Implicit auth detection**: cuando el widget del Track 2 carga en el sitio del B2B, hace un request cross-origin a `auth.contextlayer.io/session-check?tenant=X` que retorna `{ authenticated: true|false, visitorId?: "vs_xxx" }`. La deteccion funciona asi: el browser del visitor tiene una cookie `__Host-context-layer-session` (SameSite=None, Secure) seteada por `auth.contextlayer.io` cuando el visitor hizo login en la app de Track 3. Esa cookie es lo que el widget checkea (no el localStorage de `app.contextlayer.io`, que es cross-origin y no accesible). El localStorage `context-layer-user` en `app.contextlayer.io` es el cache client-side de la sesion activa; el server detecta via cookie, no via localStorage. Si `authenticated: true`, el widget tiene un `visitorId` y puede empezar a chatear (o el B2B puede fetchear perfil).
R11. **Auth popup para visitor no logueado**: si el widget recibe `authenticated: false`, muestra un boton "Sign in with ContextLayer" en el chat bubble. Click abre un popup cross-origin a `auth.contextlayer.io/connect?tenant=<id>&redirect_uri=<encoded>&state=<csrf>`. El popup muestra Firebase Auth UI (email/password, Google). Si el visitor ya tiene sesion valida (cookie presente), Firebase hace redirect automatico sin mostrar UI. Si no, el visitor hace login (1-2 clicks). Tras auth exitosa, el popup redirect a `redirect_uri?visitor_id=vs_xxx&signature=hmac&expires_at=ts`. El sitio del B2B captura los params, valida la firma con su API key, guarda el `visitorId` en la session del visitor (cookie httpOnly del B2B, no en localStorage del visitor — eso seria accessible al script del B2B).
R12. **Signature del callback (anti-tampering)**: el `visitorId` retornado en el callback viene firmado con HMAC-SHA256(`serverSecret`, `visitorId + expiresAt + tenantId`). El B2B customer verifica la firma antes de confiar en el `visitorId`. Esto evita que un attacker pueda inventar `visitorId`s llamando directamente al callback URL. El `expiresAt` default es 24h (renovable via re-auth).
R13. **Server-side fetch (uso normal del B2B)**: una vez el B2B tiene el `visitorId` (en la cookie de session del visitor), su backend puede llamar `GET /api/v1/inject/profile?visitor_id=<vs_xxx>` con API key en header `Authorization: Bearer`. El `visitorId` puede vivir en: (a) la cookie httpOnly del B2B (recomendado), (b) el session storage del server-side framework del B2B, (c) donde el B2B quiera — no le imponemos estructura. El B2B nunca tiene que manejar "tokens persistentes adicionales".
R14. **Revocacion desde el visitor**: el visitor puede revocar el acceso a un B2B desde `/settings/links` en la app de Track 3 → efecto: marca `b2bTenants/{tenantId}/siteAccess/{visitorId}.revokedAt = now()`. El siguiente fetch del B2B retorna `403 not_connected`. El `visitorId` queda inutil para siempre (no se reusa para otro visitor).
R15. **Visitor audit dashboard**: el visitor puede ver que B2B customers tienen acceso activo a su perfil, desde cuando, y cuantos accesos han hecho. Lista visible en `/settings/links` con audit log resumido (ultimos 30 dias, contadores por B2B). Detalle completo (timestamp por acceso) en `/settings/audit` (ver U4).

**Auth y seguridad**

R16. La API key del B2B customer (mismo shape que Track 2, scope `inject:read`) se valida en cada request. La key nunca aparece en URLs (siempre en header `Authorization: Bearer`). El `visitorId` es opaco y no contiene PII (no es un email, no es un uid interno de ContextLayer).
R17. El `visitorId` no expira por si solo — el grant persiste hasta que el visitor lo revoque. El B2B customer rota su API key via CLI de Track 2; el `visitorId` sigue valido (la rotacion de key no invalida grants).
R18. Rate limit per-B2B customer (default 1000 calls/dia, 100 calls/min) + per-`visitorId` (default 100 calls/dia/visitor, para evitar que un B2B abuse de un visitor especifico). 429 con `Retry-After`.
R19. Audit log: cada fetch (B2B customer id, `visitorId`, timestamp, endpoint, duracion) se loggea async en `b2bTenants/{tenantId}/siteAccess/{visitorId}/accessLog/{timestamp}`. El visitor puede ver el log desde `/settings/audit`. NO se loggea el contenido del perfil retornado — solo metadata.

**Cross-track**

R20. La auth de Track 2 (per-tenant API key con scopes) se reusa aqui. Las API keys de un B2B customer tienen scopes `{config:read, chat:write, inject:read}` (config + chat son Track 2; inject es Track 4).
R21. El LLM proxy de Track 3 **no** se usa en Track 4. El B2B customer ya tiene su LLM. Track 4 solo provee el contexto.
R22. El endpoint `GET /api/v1/widget/profile` de Track 2 (perfil del visitante para el chat route) se unifica con `GET /api/v1/inject/profile` de Track 4. Mismo backend, distintos paths por compatibilidad.

---

## User Stories

Las historias siguen el formato "Como [rol], quiero [accion], para [beneficio]" y mapean 1:1 a las R-IDs.

**B2C visitor (B2C user de ContextLayer, el que importa data y chatea en la app de Track 3)**

- **US-1.** Como B2C visitor que ya esta logueado en ContextLayer, quiero que el widget del sitio del B2B me reconozca automaticamente cuando entro, para no tener que hacer un setup adicional ni entregar codigos. (R10, R12)
- **US-2.** Como B2C visitor que no esta logueado en ContextLayer y entra al sitio de un B2B customer, quiero poder hacer sign-in en 1-2 clicks via un popup, para que el B2B pueda usar mi contexto sin friccion. (R11)
- **US-3.** Como B2C visitor, quiero que mi email/PII nunca sea expuesto al B2B customer, para mantener mi privacidad. El B2B solo recibe un `visitorId` opaco. (R16, R-I4)
- **US-4.** Como B2C visitor, quiero ver que B2B customers tienen acceso a mi perfil y poder revocar el acceso cuando quiera, para tener control sobre mi data. (R14, R15)
- **US-5.** Como B2C visitor en un device nuevo, quiero poder re-autenticarme rapidamente, para usar ContextLayer igual que en mi device habitual. (R11, edge case documentado)
- **US-6.** Como B2C visitor que borra mi data en Track 1, quiero que todos los B2B customers conectados pierdan acceso inmediatamente, para no dejar data "fantasma" en sus sistemas. (R-I2 cascade)
- **US-7.** Como B2C visitor, quiero ver un audit log de quien accedio a mi perfil y cuando, para detectar abuso. (R15, R19)

**B2B customer developer (engineer del B2B que implementa la integracion)**

- **US-8.** Como B2B developer, quiero recibir el `visitorId` via callback firmado tras el auth popup, para almacenarlo en la cookie de session del visitor sin tener que manejar tokens adicionales. (R12, R13)
- **US-9.** Como B2B developer, quiero verificar la firma del callback con mi API key, para asegurarme que el `visitorId` viene de ContextLayer y no de un attacker que invento el param. (R12)
- **US-10.** Como B2B developer, quiero hacer `GET /api/v1/inject/profile?visitor_id=vs_xxx` con API key en header desde mi backend, para inyectar el perfil del visitor en el system prompt de mi chatbot en <200ms (p95). (R1, R5)
- **US-11.** Como B2B developer, quiero poder pedir solo las senales que necesito (`?types=preferences,personalFacts`) para reducir tokens en el system prompt. (R2)
- **US-12.** Como B2B developer, quiero un endpoint "smart" `POST /api/v1/inject/context` que retorne el system prompt ya construido, para no tener que armarlo yo. (R3)
- **US-13.** Como B2B developer, quiero ver errores claros con codigos estructurados (`not_connected`, `no_profile`, `rate_limited`) para manejar cada caso en mi UI. (R1, R4)
- **US-14.** Como B2B developer, quiero rate limits por-mi-tenant Y por-visitor, para que un visitor abusivo no me consuma mi quota. (R4, R18)
- **US-15.** Como B2B developer que usa Claude Desktop / Cursor, quiero poder llamar `tools/call get_user_profile` con `visitor_id` como argumento, para integrar ContextLayer como MCP tool. (R7, R8, R9)

**B2B customer admin (PM o lead del B2B que monitorea el uso)**

- **US-16.** Como B2B admin, quiero ver cuantos fetches hizo mi backend al API de ContextLayer este mes, para dimensionar mi plan y detectar abuso. (R18, U6 metering)
- **US-17.** Como B2B admin, quiero que mi API key sea rotable sin invalidar los `visitorId`s ya emitidos, para no perder acceso a mis visitors activos. (R-I3)
- **US-18.** Como B2B admin no-tecnico, quiero un flow de signup self-serve via CLI (`pnpm tsx scripts/tenant-onboard.ts`) para crear mi tenant, obtener mi API key, y configurar mi system prompt sin tocar codigo. (Track 2 overlap, mencionado en R-I3)

**ContextLayer operator (equipo interno)**

- **US-19.** Como operator, quiero que el `siteAccess` se cree lazy on first session-check (no requiera un grant explicito del visitor), para que la conversion de "visitor que entro al sitio" a "B2B con acceso al perfil" sea la mas alta posible. (R10, R12, R-I2)
- **US-20.** Como operator, quiero que el `visitorId` sea determinista por (uid, tenantId), para que el B2B no tenga que mantener un mapping y la cache del browser funcione cross-session. (R-I4, R-I2)
- **US-21.** Como operator, quiero que un Cloud Function cascade revoque todos los `siteAccess` de un visitor cuando borra su data en Track 1, para garantizar que no queda data "fantasma" expuesta. (U2 cascade trigger)
- **US-22.** Como operator, quiero load tests que validen 1000 req/s con p95 < 200ms, para asegurar que la plataforma aguanta trafico B2B real. (U6 load test)

---

## Key Technical Decisions

**Server-side API como superficie primaria, MCP como bonus.** La mayoria de los B2B customers con su propio chatbot tienen backend custom (Node, Python, Go) que ya hace fetch de otras APIs. El REST endpoint con API key en el header es el patron mas simple y universal — no requiere cookies cross-site, no requiere tokens persistentes adicionales, no requiere handshakes extra. El MCP server es para un subset especifico: developers que usan Claude Desktop, Cursor, o un framework que ya soporta MCP como primer-class. Hacer ambos dobla el codigo, pero el MCP server es thin (traduce tool calls al mismo backend).

**Auth model: implicit via localStorage + cross-origin auth popup (patron OAuth-like passwordless).** La deteccion del visitor en el sitio del B2B funciona asi: (1) cuando el visitor hace login en `app.contextlayer.io`, seteamos dos cosas: (a) una cookie `__Host-context-layer-session` con `SameSite=None; Secure` (visible cross-site, sirve para que `auth.contextlayer.io` identifique al user desde el popup del B2B), (b) un `localStorage["context-layer-user"]` en `app.contextlayer.io` (cache client-side, no accesible cross-origin). (2) Cuando el visitor entra al sitio del B2B con el widget cargado, el widget hace un request a `auth.contextlayer.io/session-check?tenant=X` (cross-origin via `fetch` with `credentials: 'include'`) — la cookie viaja, el server sabe quien es. (3) Si esta autenticado, retorna `{ visitorId: "vs_xxx" }` (creado on-the-fly si no existe para este tenant). (4) Si no, widget muestra "Sign in" → popup cross-origin a `auth.contextlayer.io/connect?tenant=X&redirect_uri=...` → Firebase Auth UI (1 click si ya logueado) → callback con `visitorId + signature` → B2B guarda en cookie de session httpOnly. El localStorage no se expone cross-origin (es un detalle interno de la app de Track 3, no de Track 4). Trade-off: dependemos de `auth.contextlayer.io` disponible para el sign-in flow. Si cae, el widget no puede autenticar nuevos visitors, pero los ya autenticados siguen funcionando (cookie sigue valida). Mitigacion: mismo SLA que el resto de la plataforma. **Device nuevo**: el visitor tiene que re-autenticarse, lo cual regenera la cookie y el localStorage. Esperado, no es un blocker.

**API key (header) + visitorId (query) como composicion de auth.** Cada request del B2B customer al API requiere dos cosas: (a) la API key del B2B customer en `Authorization: Bearer <b2bKey>` (prueba que el caller es un B2B customer legitimo y resuelve `tenantId`), (b) el `visitorId` (opaco, formato `vs_<12 chars>`, entregado via callback firmado tras el auth popup) en query. El server verifica que existe `b2bTenants/{tenantId}/siteAccess/{visitorId}` con `revokedAt: null` y resuelve el `contextLayerUid` interno. Sin el API key no se llega al lookup. Sin el `visitorId` no se resuelve el uid. Trade-off: el B2B customer tiene que almacenar el `visitorId` en su sistema (cookie httpOnly recomendada). La alternativa (solo API key + email del visitor) rompe la privacidad (email es PII).

**Visitor identifier opaco, unico por (visitor, B2B) — no global.** El `visitorId` se genera como `hash(uid + tenantId)` truncado a 12 chars alfanumericos con prefijo `vs_`. Determinista (mismo visitor + mismo tenant → mismo visitorId siempre) pero unico cross-tenant (mismo visitor tiene `vs_aaa` en B2B X, `vs_bbb` en B2B Y, ninguno de los dos expone el `uid` interno de ContextLayer). Esto preserva portabilidad: cada B2B customer ve su propio namespace. Si el visitor revoca acceso en B2B X, su `vs_aaa` queda inutil, pero `vs_bbb` (B2B Y) sigue activo. Si el visitor borra su data en Track 1, ambos `vs_xxx` quedan con `revokedAt` automatico (cascade via Cloud Function trigger).

**No streaming + no LLM proxy.** Track 4 es read-only del perfil, no generacion. El B2B customer tiene su LLM (probablemente multi-provider via su propia abstraccion), no queremos imponer el nuestro. La latencia de la API es solo de Firestore read, no LLM.

**Endpoint `inject/context` que retorna el system prompt pre-construido.** Ademas de los endpoints raw (`inject/profile`, `inject/signals`), un endpoint "smart" que retorna el prompt listo para usar. Esto baja la barrera de adopcion: el B2B customer no tiene que saber como construir el prompt (que perfil, en que orden, con que prefijo, etc.). Trade-off: opinionated — el B2B customer pierde control sobre el shape exacto del prompt. Mitigacion: `custom_system_prompt` parameter permite override parcial. Documentado.

---

## Output Structure

```
contextlayer/
├── src/
│   ├── routes/
│   │   ├── inject.ts                # GET /api/v1/inject/profile, /signals, /context (server-side API, B2B-facing)
│   │   ├── auth-connect.ts          # GET /api/v1/auth/connect (popup landing, Firebase Auth UI)
│   │   ├── auth-callback.ts         # GET /api/v1/auth/callback (emite visitorId + signature, redirect_uri)
│   │   ├── auth-session.ts          # GET /api/v1/auth/session-check?tenant=X (cross-origin session detection)
│   │   ├── siteaccess.ts            # GET /api/v1/me/siteaccess, DELETE /api/v1/me/siteaccess/{visitorId} (visitor dashboard)
│   │   └── audit.ts                 # GET /api/v1/me/audit (visitor ve su access log)
│   ├── inject/
│   │   ├── profile-fetch.ts         # core: getProfile(tenantId, visitorId) → profile
│   │   ├── prompt-builder.ts        # construye el system prompt final
│   │   ├── token-counter.ts         # tiktoken o similar para contar tokens pre-call
│   │   ├── visitor-id.ts            # derive/generate visitorId = hash(uid + tenantId)[:12]
│   │   ├── callback-signer.ts       # HMAC-SHA256 firma del callback payload
│   │   └── rate-limiter.ts          # per-B2B + per-visitorId limits
│   ├── siteaccess/
│   │   ├── create.ts                # lazy-create siteAccess on first session-check
│   │   ├── revoke.ts                # visitor-initiated revoke
│   │   ├── list.ts                  # visitor ve sus siteAccess activos
│   │   └── verify.ts                # check de siteAccess en cada fetch
│   ├── audit/
│   │   ├── log.ts                   # write async del access log
│   │   └── read.ts                  # visitor ve quien accedio a su perfil
│   ├── mcp/                         # MCP server (sub-track)
│   │   ├── server.ts                # MCP server entry
│   │   ├── tools.ts                 # tool definitions (get_user_profile, etc.)
│   │   └── auth.ts                  # API key + visitorId en MCP context
│   └── ...                          # Track 1, 2, 3 modules (reusa)
└── scripts/
    ├── verify-audit.ts              # test E2E: auth, fetch, revoke, verificar audit log
    └── load-test-inject.ts          # k6 o artillery script para validar rate limits
```

---

## High-Level Technical Design

```mermaid
flowchart TB
  subgraph "Visitor browser"
    APP[app.contextlayer.io<br/>localStorage: context-layer-user<br/>cookie: __Host-context-layer-session]
    B2BSITE[b2b-customer.com<br/>widget.js loaded]
    B2BSITE -.->|session-check fetch<br/>credentials: include| AUTH_CTX
  end

  subgraph "ContextLayer auth domain"
    AUTH_CTX[auth.contextlayer.io<br/>validates __Host-context-layer-session cookie]
    AUTH_CTX -->|authenticated| VID[derive visitorId = hash(uid + tenantId)[:12]]
    VID -->|first time: lazy create siteAccess| FS1[(Firestore siteAccess)]
    VID -->|return visitorId| B2BSITE
    AUTH_CTX -.->|not authenticated| POPUP[Popup: Firebase Auth UI]
    POPUP -->|login OK| AUTH_CTX
    AUTH_CTX -->|redirect_uri?visitor_id=vs_xxx&signature=hmac&expires_at| B2BSITE
  end

  subgraph "B2B Customer Backend"
    B2BBE[b2b-customer.com backend]
    B2BSITE -->|cookie httpOnly: visitorId| B2BBE
    B2BBE -->|GET /inject/profile?visitor_id=vs_xxx| API[ContextLayer API]
  end

  subgraph "ContextLayer API"
    API -->|Authorization: Bearer b2bKey| INJ[inject.ts route]
    INJ -->|verify API key| KA[API key auth]
    KA -->|tenantId| SA[siteAccess verify: siteAccess/{visitorId} exists + revokedAt null]
    SA -->|contextLayerUid| FS2[(Firestore profile)]
    FS2 -->|profile/main| PB[prompt-builder]
    PB -->|token count| TC[token-counter]
    PB -->|system prompt final| INJ
    INJ -->|enqueue audit log| AL[Audit log async write]
    INJ -->|200 response| API
    API -->|profile + system prompt| B2BBE
    B2BBE -->|prepend to LLM call| LLM[Su LLM]
    LLM -->|response| B2BBE
  end

  subgraph "MCP path (alternative for MCP-aware bots)"
    MCPBOT[Claude Desktop / Cursor / MCP-aware bot]
    MCPBOT -->|tools/call get_user_profile visitor_id=vs_xxx| MCP[MCP server]
    MCP -->|same backend| INJ
  end
```

**Firestore schema (anadido al de Track 1 + Track 2):**

```
users/{uid}
  # (la coleccion linkingCodes ya no existe; el flow de auth es implicit)

b2bTenants/{tenantId}
  siteAccess/{visitorId}        # visitorId = hash(uid + tenantId)[:12] con prefijo "vs_"
    contextLayerUid: string     # interno, no expuesto al B2B customer
    grantedAt: Timestamp        # primer session-check o auth-connect exitoso
    lastAccessedAt: Timestamp
    revokedAt: Timestamp | null # null = activo; timestamp = revocado por visitor
    accessCount: number         # counter de fetches
    accessLog/{timestamp}       # subcollection
      endpoint: string          # '/inject/profile', '/inject/signals', '/inject/context'
      durationMs: number
      requestId: string

  rateLimits/{windowId}         # daily counter
    callCount: number
    windowStart: Timestamp
```

**Visitor ID derivation:**

```
visitorId = "vs_" + hash(uid + tenantId)[:12]
```

Donde `hash` es SHA-256, los primeros 12 chars alfanumericos (base62 encoding). Determinista: el mismo (uid, tenantId) siempre produce el mismo `visitorId`. Unico cross-tenant: el mismo uid tiene `vs_aaa` en tenant X, `vs_bbb` en tenant Y. El B2B customer nunca ve el `uid` interno. El siteAccess se crea lazy on first session-check (no requiere paso explicito del visitor).

**Endpoints shape:**

```
GET /api/v1/auth/session-check?tenant=<id>
Headers: (cookie __Host-context-layer-session viaja automaticamente con credentials: 'include')
Response 200: { authenticated: true, visitorId: "vs_a8k2p9f3x", tenantId: "<id>" }
Response 200: { authenticated: false, signInUrl: "https://auth.contextlayer.io/connect?..." }
Response 400: { error: "missing_tenant" }

GET /api/v1/auth/connect?tenant=<id>&redirect_uri=<url>&state=<csrf>
Response 302: redirect a Firebase Auth UI hosted en auth.contextlayer.io
            (si el user ya esta logueado via cookie, Firebase hace redirect inmediato sin UI)
Response 200: HTML con Firebase Auth UI (email/password, Google)

GET /api/v1/auth/callback?visitor_id=<vs_xxx>&signature=<hmac>&expires_at=<ts>&state=<csrf>
Response 302: redirect a redirect_uri con params en query
              (el sitio del B2B captura, valida signature con API key, guarda visitorId)
Response 400: { error: "invalid_state" }            # CSRF check fail
Response 400: { error: "invalid_signature" }        # HMAC no valida
Response 400: { error: "expired" }                  # expires_at < now

GET /api/v1/inject/profile?visitor_id=<vs_xxx>
Headers: Authorization: Bearer <b2bKey>
Response 200: { profile: { preferences: [...], personalFacts: [...], ... }, fetchedAt: ... }
Response 401: { error: "invalid_api_key" }
Response 403: { error: "not_connected" }              # siteAccess no existe o revocado
Response 404: { error: "no_profile" }                 # visitor no importo en Track 1
Response 429: { error: "rate_limited", retryAfter: <seconds> }

GET /api/v1/inject/signals?visitor_id=<vs_xxx>&types=preferences,personalFacts
Headers: same
Response 200: { signals: { preferences: [...], personalFacts: [...] }, fetchedAt: ... }

POST /api/v1/inject/context
Headers: same
Body: { visitor_id: string, custom_system_prompt?: string }
Response 200: { system_prompt: string, token_count: number, model_recommendation: "claude-3.5-sonnet" }
```

---

## Implementation Units

### U1. Implicit auth via cross-origin session-check + connect popup

**Goal:** El widget del Track 2 detecta si el visitor esta logueado en ContextLayer (via cookie cross-origin) y obtiene un `visitorId` deterministico. Si no esta logueado, abre un popup cross-origin a `auth.contextlayer.io/connect` que completa Firebase Auth y retorna un callback firmado con `visitorId`. El siteAccess se crea lazy on first detection.

**Requirements:** R10, R11, R12, R13.

**Dependencies:** Track 1 (Firebase Auth), Plan 002 (widget que dispara el session-check), Plan 003 (app donde el visitor esta logueado).

**Files:**
- `src/inject/visitor-id.ts` (derive `visitorId = hash(uid + tenantId)[:12]`)
- `src/inject/callback-signer.ts` (HMAC-SHA256 firma del callback payload)
- `src/routes/auth-session.ts` (`GET /api/v1/auth/session-check?tenant=X`)
- `src/routes/auth-connect.ts` (`GET /api/v1/auth/connect?tenant=X&redirect_uri=...&state=...`)
- `src/routes/auth-callback.ts` (`GET /api/v1/auth/callback` — emite visitorId + signature, redirect)
- `src/siteaccess/create.ts` (lazy-create siteAccess on first session-check)
- `src/firestore/siteaccess.ts` (operaciones CRUD de siteAccess)

**Approach:**

**Flow 1 — visitor YA logueado en ContextLayer:**
1. Visitor entra al sitio del B2B (ej. `acme.com`). El widget de Plan 002 ya esta cargado.
2. Widget ejecuta: `fetch('https://auth.contextlayer.io/api/v1/auth/session-check?tenant=acme', { credentials: 'include', mode: 'cors' })`. La cookie `__Host-context-layer-session` viaja automaticamente.
3. Server en `auth.contextlayer.io`:
   - Lee la cookie, extrae `uid` (Firebase Auth user ID).
   - Deriva `visitorId = "vs_" + sha256(uid + "acme").slice(0, 12)`.
   - Lazy create `b2bTenants/acme/siteAccess/{visitorId}` si no existe (con `grantedAt = now`).
   - Retorna `{ authenticated: true, visitorId: "vs_a8k2p9f3x", tenantId: "acme" }`.
4. Widget guarda `visitorId` en la session del visitor (cookie httpOnly seteada por el backend del B2B, o postMessage al backend del B2B para que lo guarde).
5. B2B puede empezar a fetchear `GET /inject/profile?visitor_id=vs_a8k2p9f3x` con su API key.

**Flow 2 — visitor NO logueado:**
1. Visitor entra al sitio del B2B sin estar logueado en ContextLayer.
2. Widget ejecuta session-check, recibe `{ authenticated: false, signInUrl: "..." }`.
3. Widget muestra "Sign in with ContextLayer" en el chat bubble.
4. Visitor hace click → `window.open('https://auth.contextlayer.io/api/v1/auth/connect?tenant=acme&redirect_uri=https%3A%2F%2Facme.com%2Fcallback&state=<csrf>')`.
5. Popup carga el endpoint connect:
   - Si el visitor ya tiene sesion valida (cookie presente), Firebase hace redirect inmediato al callback sin UI.
   - Si no, muestra Firebase Auth UI (email/password, Google).
6. Tras auth exitosa, Firebase redirect a `/api/v1/auth/callback?visitor_id=...&signature=...&expires_at=...&state=...`.
7. Server en callback:
   - Valida `state` contra el cookie/state-store (CSRF protection).
   - Firma: `signature = HMAC-SHA256(serverSecret, visitorId + expiresAt + tenantId)`. (El serverSecret es derivado del `b2bKey` del tenant — el B2B puede recomputarlo para validar.)
   - Redirect 302 a `redirect_uri?visitor_id=vs_xxx&signature=...&expires_at=...`.
8. El sitio del B2B (`acme.com/callback`) captura los query params, valida la firma con su API key, guarda el `visitorId` en la cookie de session del visitor (httpOnly, Secure, SameSite=Lax).
9. Popup se cierra, widget re-ejecuta session-check (ahora autenticado), recibe `visitorId`, listo.

**Edge case — device nuevo:** la cookie no esta. El visitor hace Flow 2 completo. Esperado, no es blocker.

**Edge case — visitor borra su data en Track 1:** un Cloud Function trigger (`onUpdate(users/{uid})`) hace cascade `revokedAt = now()` en todos los `siteAccess/{visitorId}` donde `contextLayerUid = uid`. El siguiente fetch del B2B retorna 403.

**Test scenarios:**
- Visitor con sesion activa en ContextLayer entra a sitio del B2B → widget session-check retorna `{ authenticated: true, visitorId: "vs_xxx" }` → siteAccess creado con `revokedAt: null`, `accessCount: 0`
- Visitor sin sesion → session-check retorna `{ authenticated: false, signInUrl: ... }`
- Visitor hace click "Sign in" → popup abre Firebase Auth → tras login OK, callback retorna visitorId firmado
- Callback con `state` invalido (CSRF) → 400, no emite visitorId
- Callback con `signature` invalida → 400
- Callback con `expires_at < now` → 400 expired
- Mismo visitor + mismo tenant → siempre mismo visitorId (determinista)
- Mismo visitor + tenant A vs tenant B → visitorIds distintos (cross-tenant uniqueness)
- B2B customer valida signature con su API key → firma valida, acepta visitorId
- B2B customer con API key incorrecta no puede validar signature (porque serverSecret es derivado del b2bKey correcto)
- Visitor borra data en Track 1 → Cloud Function trigger revoca todos los siteAccess cross-tenant del uid
- Visitor revoca un siteAccess especifico desde `/settings/links` → siguiente fetch con ese visitorId retorna 403, pero otros siteAccess del mismo visitor siguen activos

**Verification:** E2E: visitor logueado en ContextLayer abre sitio del B2B, widget session-check retorna visitorId sin intervencion manual. Visitor sin sesion: click "Sign in", popup Firebase, login OK, callback con visitorId firmado, B2B guarda en session, llama `/inject/profile` con API key, recibe 200 con perfil. Visitor revoca desde `/settings/links`, siguiente fetch retorna 403.

### U2. siteAccess storage + verify + revoke

**Goal:** Persistir siteAccess, verificar la existencia + no-revocado en cada fetch, permitir revoke desde el visitor dashboard.

**Requirements:** R13, R14, R15, R18.

**Dependencies:** U1.

**Files:**
- `src/siteaccess/verify.ts`
- `src/siteaccess/revoke.ts`
- `src/siteaccess/list.ts`
- `src/routes/siteaccess.ts`
- `src/firestore/siteaccess.ts`
- `src/firestore/siteaccess.test.ts`

**Approach:** `siteaccess.ts` en Firestore: schema segun HTD. CRUD operations:
- `createSiteAccess(tenantId, contextLayerUid, visitorId)` → returns void (visitorId derivado por U1 via `hash(uid + tenantId)`, no requiere parametro del B2B)
- `getSiteAccess(tenantId, visitorId)` → returns siteAccess o null
- `revokeSiteAccess(tenantId, visitorId)` → set `revokedAt: now()`, mantiene el doc para audit
- `listSiteAccessForUser(contextLayerUid)` → query all siteAccess across tenants where uid matches
- `verifySiteAccess(tenantId, visitorId)` → returns `{ active: boolean, contextLayerUid: string | null }` — atomic check: exists + `revokedAt: null`

**Cascade revoke via Cloud Function:** trigger `onUpdate(users/{uid})` que detecta cambios al perfil (delete, wipe) y marca `revokedAt = now()` en todos los `siteAccess/{visitorId}` donde `contextLayerUid = uid`. Implementacion: Cloud Function exportada, deployada via Firebase Functions o como cron en el backend Fastify. Decidir en planning de U2 vs U3.

`/api/v1/me/siteaccess` (autenticado como visitor, retorna Firebase ID token) lista los siteAccess del user actual con metadata: nombre del B2B customer, `visitorId` (los primeros 6 chars visibles para que el user pueda identificar), `grantedAt`, `accessCount`, `lastAccessedAt`. `/api/v1/me/siteaccess/{visitorId}/revoke` (DELETE) revoca un siteAccess. Efecto inmediato: el siguiente fetch del B2B customer con ese `visitorId` retorna 403.

**Test scenarios:**
- Visitor A con sesion activa entra a sitio B2B X por primera vez → siteAccess creado automaticamente en `b2bTenants/X/siteAccess/{vs_xxx}` con `accessCount: 0`, `grantedAt: now`
- Visitor A entra a sitio B2B X por segunda vez → mismo `vs_xxx` (determinista), `grantedAt` no cambia, `accessCount` tampoco
- `verifySiteAccess(X, vs_xxx)` → returns `{ active: true, contextLayerUid: '...' }`
- Visitor A entra a sitio B2B Y (distinto tenant) → `vs_yyy` distinto, siteAccess separado
- Visitor A revoca siteAccess de B2B X → `verifySiteAccess(X, vs_xxx)` → `{ active: false, ... }`
- Visitor A no puede revocar siteAccess de Visitor B → 403
- Visitor A borra su data en Track 1 → cascade trigger marca TODOS los siteAccess del uid como revoked
- Listar siteAccess del visitor A → retorna todos los siteAccess donde uid == A.uid, agrupados por tenant
- SiteAccess revocado aparece en la lista con `status: "revoked"` + `revokedAt` para audit
- Rate limit per-visitorId: el rate limiter de U6 verifica `accessCount` por `visitorId` no por B2B

**Verification:** Visitor A concede acceso a B2B X, fetch funciona, visitor A revoca, fetch falla con 403. Visitor B no ve el siteAccess de A en su lista.

### U3. Inject API endpoints (profile, signals, context)

**Goal:** Los endpoints REST que el B2B customer llama para inyectar el perfil en su chatbot pipeline: `profile` (fetch del perfil completo), `signals` (fetch de senales especificas), `context` (fetch del system prompt pre-construido). El auth flow de linking se hace via U1 (session-check + connect popup), U3 es solo los read endpoints.

**Requirements:** R1, R2, R3, R4, R5, R6.

**Dependencies:** U1, U2.

**Files:**
- `src/routes/inject.ts`
- `src/inject/profile-fetch.ts`
- `src/inject/prompt-builder.ts`
- `src/inject/token-counter.ts`
- `src/inject/rate-limiter.ts`
- `src/routes/inject.test.ts`

**Approach:** Tres handlers:

1. `GET /api/v1/inject/profile?visitor_id=<vs_xxx>`:
   - Auth: verify API key (resuelve `tenantId`).
   - Verifica siteAccess: `verifySiteAccess(tenantId, visitorId)` → si `!active`, 403 not_connected.
   - Rate limit check (per-tenant, per-visitorId).
   - Read `users/{contextLayerUid}/profile/main`.
   - Enqueue audit log (endpoint, duracion).
   - Increment `siteAccess.{visitorId}.accessCount` + `lastAccessedAt`.
   - Return profile.

2. `GET /api/v1/inject/signals?visitor_id=<vs_xxx>&types=<csv>`:
   - Mismo flow que `profile`, pero `types` query param filtra que campos incluir.
   - 400 si `types` no es uno de `preferences | personalFacts | activeIntentions | domainsOfInterest`.

3. `POST /api/v1/inject/context`:
   - Body: `{ visitor_id, custom_system_prompt? }`.
   - Mismo flow que `profile` + `signals`.
   - Construye system prompt (base + profile + custom).
   - Cuenta tokens con tiktoken.
   - Recomienda modelo segun `tokenCount` (e.g. >100k → claude-3.5-sonnet con 200k context).
   - Retorna `{ system_prompt, token_count, model_recommendation }`.

**Test scenarios:**
- Request a `/inject/profile` con API key valido + `visitor_id` con siteAccess activo + uid con perfil → 200 con profile
- Request sin API key → 401
- Request con API key pero sin `visitor_id` → 400
- Request con `visitor_id` que no tiene siteAccess para este tenant → 403 not_connected
- Request con `visitor_id` revocado → 403 not_connected
- Request con `visitor_id` valido pero uid sin perfil (no importo en Track 1) → 404 no_profile
- Request a `/inject/signals?types=preferences,personalFacts` → 200 con solo esos dos campos
- Request con `types=invalid_type` → 400
- Request a `/inject/context` con `custom_system_prompt` → system prompt incluye base + profile + custom
- Token count en la response es exacto (verificar con texto conocido + tiktoken)
- Rate limit exceeded (per-tenant o per-visitorId) → 429 con Retry-After
- Audit log entry aparece en `siteAccess/{vid}/accessLog/{ts}` con `endpoint`, `durationMs`
- Increment de `accessCount` se refleja en `siteAccess/{vid}.accessCount`
- Cross-tenant: `visitor_id` con siteAccess en tenant A, request con API key de tenant B → 403

**Verification:** E2E: B2B customer hace 100 fetches a `/inject/profile?visitor_id=<vs>` → todos 200; fetch 101 → 429. Verificar audit log tiene 100 entries en `siteAccess/{vid}/accessLog`.

### U4. Visitor audit log + site access dashboard

**Goal:** El visitor puede ver que B2B customers accedieron a su perfil y revocar siteAccess grants.

**Requirements:** R14, R15, R19.

**Dependencies:** U2, U3.

**Files:**
- `src/audit/log.ts`
- `src/audit/read.ts`
- `src/routes/audit.ts`
- `src/app/settings/SiteAccessList.tsx` (frontend en la app de Track 3, vista `/settings/links`)

**Approach:** El audit log se escribe async desde U3 en `b2bTenants/{tenantId}/siteAccess/{visitorId}/accessLog/{ts}` con `{ endpoint, durationMs, status, ip }`. La vista `/settings/links` (que ya existe por U1, extended en U4) lista:
- SiteAccess activos: nombre del B2B customer, `grantedAt` (cuando el visitor entro por primera vez al sitio), `lastAccessedAt`, `accessCount` (ultimas 24h / 7d / 30d derivado del subcollection accessLog).
- SiteAccess revocados: igual + `revokedAt`.
- Accesos recientes: ultimos 50 entries del subcollection accessLog, agrupados por siteAccess.

Boton "Revoke" por siteAccess. Confirmation modal explicando que el B2B customer no podra fetchar mas el perfil (el `visitorId` quedara inutil).

**Test scenarios:**
- Visitor A abre `/settings/links` → ve 2 siteAccess activos (B2B X, B2B Y) con `grantedAt` de cada uno
- Visitor A ve access log: 15 accesos de B2B X en las ultimas 24h, 3 de B2B Y
- Visitor A click "Revoke" en B2B X → confirmation modal, click "Confirm" → siteAccess revocado
- Tras revoke, la lista muestra B2B X como "Revoked" + timestamp
- Visitor A no ve siteAccess de Visitor B (rules de Firestore + auth check)
- Audit log entries son inmutables (no se pueden borrar desde el dashboard, solo via Track 1 delete all)
- Counters `accessCount`/`lastAccessedAt` del padre se actualizan en paralelo al accessLog

**Verification:** E2E: B2B customer X hace 5 fetches del perfil de A, A abre siteAccess dashboard, ve 5 accesos, revoca X, siguiente fetch de X → 403.

### U5. MCP server

**Goal:** Servidor MCP en `mcp.contextlayer.io` que expone los mismos endpoints como tools. Auth: API key del B2B (header) + `visitor_id` (argument del tool call). El B2B que usa MCP ya resolvio el visitorId fuera del flow MCP (via el flow de U1 en su app host que dispara el popup).

**Requirements:** R7, R8, R9.

**Dependencies:** U3 (el backend que las tools llaman).

**Files:**
- `src/mcp/server.ts`
- `src/mcp/tools.ts`
- `src/mcp/auth.ts`
- `src/mcp/mcp.test.ts`

**Approach:** Servidor MCP standalone (subprocess o container separado) que:
1. Acepta conexiones MCP desde clients (Claude Desktop, Cursor, custom).
2. En `initialize`, intercambia capabilities. Auth via header `Authorization: Bearer <b2bKey>` en la conexion MCP. Resuelve `tenantId`.
3. `tools/list` retorna la lista de tools con schemas.
4. `tools/call` con `name=get_user_profile, arguments={visitor_id}`:
   - Verifica siteAccess: `verifySiteAccess(tenantId, visitor_id)`. Si no activo, error "not_connected".
   - Llama `profile-fetch.ts` (mismo modulo que U3).
   - Retorna el resultado.

El auth es mas simple que la propuesta original: el B2B customer configura el MCP client con su `b2bKey` (header), y pasa `visitor_id` como argumento en cada tool call. No hay tokens persistentes en el contexto MCP. El B2B customer es responsable de mantener el mapping `visitor_id → user` en su lado (lo decidio al hacer el link).

**Test scenarios:**
- MCP server `initialize` con API key valida → 200 con capabilities
- MCP server `initialize` con API key invalida → 401
- `tools/list` retorna 4 tools con schemas correctos
- `tools/call get_user_profile` con `visitor_id` + siteAccess activo → retorna profile
- `tools/call get_user_profile` con `visitor_id` no conectado → error "not_connected"
- `tools/call get_user_profile` con `visitor_id` de otro tenant → error "not_connected"
- `tools/call get_user_signals` con `types=["preferences"]` → retorna solo preferences
- `tools/call get_system_prompt` con `custom_addition` → retorna prompt con custom al final
- `tools/call list_siteaccess` → retorna lista de `visitorId` conectados (no devuelve profile)
- Rate limit aplica tambien a tool calls
- Audit log se escribe tambien desde MCP path (con `source: "mcp"`)

**Verification:** Conectar Claude Desktop al MCP server, configurar API key en el init, usar el tool `get_user_profile` con un `visitor_id` desde un prompt de Claude → retorna el perfil, Claude lo usa en su respuesta.

### U6. Rate limiter + metering + load test

**Goal:** Rate limiting robusto, metering de uso para futuro pricing, y un load test que valide que el sistema aguanta trafico real.

**Requirements:** R4, R18, R19.

**Dependencies:** U3.

**Files:**
- `src/inject/rate-limiter.ts`
- `src/inject/rate-limiter.test.ts`
- `scripts/load-test-inject.ts`

**Approach:** Rate limiter basado en counter en Firestore con TTL:
- Per-tenant daily: `b2bTenants/{tenantId}/rateLimits/{YYYY-MM-DD}.callCount`
- Per-tenant per-minute: `b2bTenants/{tenantId}/rateLimits/{YYYY-MM-DDTHH-MM}.callCount`
- Per-visitorId daily: `b2bTenants/{tenantId}/siteAccess/{visitorId}/rateLimits/{YYYY-MM-DD}.callCount`

`checkLimit(tenantId, visitorId)` retorna `{allowed, retryAfter?}`. Implementacion: read de los 3 counters (o cached read si hay un cache layer), check, increment. Cache layer: `node-lru-cache` con TTL de 10s para evitar hot reads en Firestore.

Load test: `scripts/load-test-inject.ts` usando `autocannon` o `k6`. Simula 100 concurrent B2B customers haciendo 10 req/s cada uno (1000 req/s total). Mide p50/p95/p99 latency, error rate. Target: p95 < 200ms, error rate < 0.1%.

**Test scenarios:**
- 100 fetches en 1 minuto desde el mismo tenant → primeros 100 OK, fetch 101 → 429 con Retry-After=60
- 1000 fetches en 1 dia desde el mismo tenant → fetch 1001 → 429 con Retry-After=<seconds until midnight>
- 100 fetches en 1 dia desde el mismo visitorId → fetch 101 → 429
- Load test: 1000 req/s, p95 < 200ms, error rate < 0.1%
- Cache hit en el rate limiter: 10 reads del mismo counter → 1 read a Firestore
- Counter TTL: counter del dia anterior ya no se cuenta
- Session-check rate limit: 1000 `GET /api/v1/auth/session-check` calls/dia/tenant → fetch 1001 → 429 (anti-abuse contra probing de cookies cross-origin)

**Verification:** `pnpm tsx scripts/load-test-inject.ts` muestra el reporte; p95 < 200ms, error rate < 0.1%.

---

## Scope Boundaries

**Deferred for later**

- Browser-side fetch (option 4 del brainstorm): V1 es server-side only. Browser-side requiere CORS + exposicion de la API key, no vale el trade-off de seguridad.
- RAG tool (option 2 del brainstorm): V1 provee el perfil completo, el B2B customer decide cuando usarlo. RAG sofisticado (retrieve solo lo relevante al query) es V2.
- Webhooks al B2B customer cuando el perfil del visitor cambia (re-import, manual edit). V2.
- Real-time push del perfil al B2B customer (en vez de pull). V2 con WebSocket o SSE persistente.
- Multi-region / data residency (GDPR, data localization). V2 con deploy en EU.
- Bulk endpoints (`/inject/profiles?visitor_ids=<csv>`). V1 es one-at-a-time.
- GraphQL API. REST es suficiente para V1.
- Webhook signing / event delivery para "profile updated". V2.

**Outside this product's identity**

- Track 4 NO es un LLM provider. No proveemos chat, no proveemos completions. Solo contexto.
- Track 4 NO es un CRM. No almacenamos historial de interacciones B2B-customer ↔ visitor.
- Track 4 NO es un helpdesk. El B2B customer maneja su propia logica de soporte.

**Deferred to Follow-Up Work**

- Pricing track: definir per-connection vs per-call, free tier, paid tier. U6 (rate limiter + metering) es la base tecnica, pero el pricing model es un track de negocio separado.
- Self-serve onboarding del B2B customer (hoy es via Track 2 CLI). V2 introduce un dashboard web.
- "Profile freshness" indicator: cuanto tiempo tiene el perfil, cuando fue la ultima actualizacion, etc. El B2B customer podria querer saber. V2.

---

## Dependencies / Assumptions

- Track 1 cerrado. `users/{uid}/profile/main` existe y es leible.
- Track 2 produce el sistema de API keys per-tenant con scopes y el widget que dispara el session-check. Track 4 lo extiende con el scope `inject:read` y los endpoints `/api/v1/auth/*`.
- Track 3 produce la app de B2C user donde el visitor hace login (Firebase Auth). El widget de Track 2 detecta esa sesion via la cookie `__Host-context-layer-session` (seteada por Track 3 cuando el visitor hace login).
- El B2B customer recibe el `visitorId` via callback firmado tras el auth popup — no hay coordinacion fuera-de-banda. El B2B solo necesita implementar (a) el session-check cross-origin desde su frontend, (b) el handler del callback URL, (c) la verificacion de signature con su API key. Documentado en onboarding kit.
- Browsers target: ultimas 2 versiones de Chrome, Firefox, Safari, Edge. Cross-origin cookies con `SameSite=None; Secure` requieren HTTPS en todos lados.
- MCP clients target: Claude Desktop, Cursor, y otros que adopten MCP. Lista viva en `docs/mcp-clients.md`. El MCP path asume que el B2B ya resolvio el visitorId via el flow normal (el tool call lo pasa como argumento).
- Los B2B customers pueden hacer HTTPS desde sus backends. No soportamos HTTP plano.
- El "no loggeo contenido del perfil" es un compromiso de producto. El audit log registra que se accedio, no que se devolvio.

---

## Open Questions

**OQ-I1.** [RESOLVED → REST server-side] Mecanismo de inyeccion primario: REST server-side como superficie primaria, MCP como bonus para los pocos que lo soportan. Server-side permite que el B2B customer mantenga su API key fuera del browser y tenga control total sobre cuando fetchear.

**OQ-I2.** [RESUELTO 2026-06-20 → Auth flow implicit via localStorage + cross-origin auth popup, no connectionToken, no linking code] Auth entre B2B customer y nuestra API. Evolucion: el plan empezo con `connectionToken` JWT (rechazado por complejidad), luego pivoteo a `linkingCode` one-time (`cl-link-XXXX-XXXX`, 15min, single-use, copy-paste entre apps). El user lo volvio a rechazar: "yo pensaba dejar un localstorage key tipo `context-layer-user` y de ahi buscar para inyectar el contexto del usuario". Resolucion final: patron OAuth-like passwordless. El visitor logueado en ContextLayer tiene una cookie `__Host-context-layer-session` (SameSite=None; Secure, cross-site visible) + localStorage `context-layer-user` en `app.contextlayer.io` (client-side cache). El widget del B2B hace session-check cross-origin con `credentials: 'include'`, la cookie viaja, el server detecta al user, deriva `visitorId = hash(uid + tenantId)[:12]` deterministico, lazy-crea `siteAccess`. Si el visitor no esta logueado, widget abre popup cross-origin a `auth.contextlayer.io/connect?tenant=X&redirect_uri=...`, Firebase Auth UI (1 click si ya logueado), callback con `visitorId + HMAC-SHA256 signature + expires_at`. El B2B verifica la firma con su API key (serverSecret derivado del b2bKey), guarda el visitorId en cookie httpOnly. Conversion esperada: >70% (vs <5% con linking code). Device nuevo: re-auth, edge case esperado.

**OQ-I3.** [RESOLVED → Header + query param, determinista] El API key del B2B se pasa en header `Authorization: Bearer <b2bKey>` (constante por sesion). El `visitorId` se pasa en query param `?visitor_id=vs_xxx` (variable por request, una sesion del B2B puede manejar muchos visitors). El `visitorId` es determinista (mismo uid + mismo tenantId = mismo visitorId siempre), asi que el B2B no necesita pedirlo cada vez — puede cachearlo en la cookie de session del visitor.

**OQ-I4.** [RESOLVED → visitorId opaco determinista por (uid, tenant)] El `visitorId` se deriva como `vs_` + SHA-256(uid + tenantId)[:12]. El B2B nunca ve el `uid` interno de ContextLayer. Determinista: el mismo visitor en el mismo tenant siempre tiene el mismo visitorId, asi que el B2B no necesita mantener mapping — la cookie de session del visitor es suficiente. Cross-tenant uniqueness: el mismo visitor tiene visitorIds distintos en cada tenant (`vs_aaa` en acme, `vs_bbb` en shopify), ninguno expone el uid. Privacy: el visitorId es opaco y no contiene PII (no es email, no es hash de email).

**OQ-I5.** ¿Que pasa si el B2B customer pasa un `visitor_id` que no existe en su `siteAccess`? Mi default: 403 not_connected (mismo que si el siteAccess fue revocado). No distinguimos "no existe" de "revocada" para no filtrar informacion sobre que visitors existen. Resoluble en U3.

**OQ-I6.** ¿Pricing — per-visitor, per-call, o flat? TBD. El metering de U6 es la base tecnica, pero el modelo de pricing es un track de negocio. Resoluble fuera de este plan.

**OQ-I7.** ¿El B2B customer puede pedir "todas las senales excepto domainsOfInterest" sin tener que listar explicitamente las 3 que quiere? Mi default: no. El B2B customer tiene que listar explicitamente. Esto es mas seguro (no asume defaults que pueden cambiar) y self-documenting. Alternativa: `exclude_types` param. Resoluble en U3.

**OQ-I8.** ¿El endpoint `/inject/context` deberia ser opcional o el default recomendado? Mi default: default recomendado para reducir friccion de adopcion. El B2B customer que quiere control total usa `/inject/profile` + su propio prompt builder. Documentado en onboarding.

**OQ-I9.** ¿Soportamos re-sincronizacion automatica del perfil cuando el visitor re-importa? Mi default: pull-only, el B2B customer decide cuando fetchar (cache TTL del lado de ellos). Push (webhook) es V2. Resoluble fuera de este plan.

---

## Resolved Decisions

**R1. Auth model: 3 iteraciones hacia el patron OAuth-like passwordless.** El plan original proponia `connectionToken` (JWT firmado con HMAC-SHA256) + visitorId. El user lo rechazo por la complejidad: "¿API Key, que es un connectionToken?". Resolucion intermedia: API key sola (header) + linking code one-time (`cl-link-XXXX-XXXX`, 15min, single-use) que el visitor genera y entrega al B2B fuera-de-banda. El user lo volvio a rechazar: "yo pensaba dejar un localstorage key tipo `context-layer-user` y de ahi buscar para inyectar el contexto del usuario". Resolucion final: implicit auth via localStorage + cross-origin auth popup. El visitor logueado en ContextLayer tiene cookie `__Host-context-layer-session` (SameSite=None; Secure) + localStorage `context-layer-user` en `app.contextlayer.io`. El widget del B2B hace session-check cross-origin con `credentials: 'include'`, la cookie viaja, el server detecta al user, deriva `visitorId = hash(uid + tenantId)[:12]` deterministico, lazy-crea siteAccess. Si no esta logueado, widget abre popup a `auth.contextlayer.io/connect`, Firebase Auth UI, callback firmado con HMAC-SHA256. Cero copy-paste, conversion esperada >70% (vs <5% con linking code).

**R2. visitorId determinista derivado de (uid, tenantId).** En vez de generar `vs_<random>` al cierre del link flow, el visitorId se calcula deterministicamente: `vs_` + SHA-256(uid + tenantId)[:12]. Esto elimina el "grant flow" completamente — no hay paso donde el visitor主动amente concede acceso. El primer session-check cross-origin del B2B es lo que crea el siteAccess. Trade-off: un visitor no puede "pre-revocar" un B2B antes de que entre al sitio (el siteAccess se crea on first contact). Mitigacion: el visitor puede revocar en cualquier momento desde `/settings/links` y el cascade trigger revoca si borra su data.

**R3. Schema `siteAccess` consistente con Track 1 stub.** Track 1 dejo un stub de `siteAccess/` (sin endpoints). Track 4 adopta este nombre. La coleccion `linkingCodes` que existia en la version previa de este plan (y que era el corazon del flow de linking code) ahora se elimina completamente — el flow implicit no la necesita. Sin migracion: el plan anterior nunca escribio a `linkingCodes` (era plan, no codigo).

---

## Sources & Research

- Track 1: `docs/plans/2026-06-13-001-feat-importacion-pipeline-plan.md` (stub de `siteAccess` que Track 4 completa)
- Track 2: `docs/plans/2026-06-16-002-feat-embeddable-widget-plan.md` (auth de API keys per-tenant con scopes; reusado aqui)
- Track 3: `docs/plans/2026-06-16-003-feat-consumer-chatbot-app-plan.md` (LLM proxy, app donde vivira el connections dashboard)
- STRATEGY.md: "API de integracion" como track de revenue, B2B paga por acceso al perfil del visitante
- Origin brainstorm: `docs/brainstorms/2026-06-13-importacion-contexto-ia-requirements.md` (R16, R17, F4)
- MCP (Model Context Protocol): `https://modelcontextprotocol.io` — protocol para tools que bots pueden usar. Adoptado por Claude Desktop, Cursor, y otros. Tools via `tools/list` + `tools/call` sobre JSON-RPC.
- OAuth-like grant pattern: similar a "Sign in with Google" pero para data access en vez de identity. El visitor controla los scopes.
- Server-side fetch + API key: patron de Segment, mParticle, y otros CDP (Customer Data Platforms). El auth flow implicit via localStorage + cross-origin popup es el patron estandar de OAuth/passwordless (Google Sign-In, Magic Links, etc). El `visitorId` determinista `hash(uid + tenantId)[:12]` evita que el B2B mantenga un mapping interno — la cookie de session del visitor es suficiente.
- Tiktoken: `https://github.com/openai/tiktoken` — token counter para modelos OpenAI. Para Anthropic/Google, aproximacion con `gpt-tokenizer` o heuristic chars/4.
- Load testing: `autocannon` (Node, simple) o `k6` (Go, mas features). Mi default: `autocannon` por simplicidad.
