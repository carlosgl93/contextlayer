---
date: 2026-06-16
seq: "002"
type: feat
title: "feat: Embeddable chatbot widget — B2B JS snippet, multi-tenant chat, B2C context"
origin: docs/brainstorms/2026-06-13-importacion-contexto-ia-requirements.md (R16, R17, F4)
depends_on: docs/plans/2026-06-13-001-feat-importacion-pipeline-plan.md
---

# feat: Embeddable chatbot widget

## Summary

JS snippet (`<script src="https://cdn.contextlayer.io/widget.js" data-tenant="..."></script>`) que B2B customers dropean en su HTML. El widget levanta una UI de chat, identifica al visitante B2C via **implicit auth** (mismo patron OAuth-like passwordless que Plan 004): el visitor logueado en ContextLayer (`app.contextlayer.io` cookie `__Host-context-layer-session` + localStorage `context-layer-user`) es detectado por el widget via session-check cross-origin; si no esta logueado, el widget abre un popup a `auth.contextlayer.io/connect?tenant=X&redirect_uri=...`, el visitor confirma (1 click si ya logueado en ContextLayer, login Firebase si no), recibe un `visitorId` opaco (`vs_xxx`) firmado por ContextLayer, y el widget puede empezar a usar el perfil sintetizado de Track 1 + mantener conversaciones persistidas en `b2bTenants/{tenantId}/visitors/{visitorId}/conversations/...`. Multi-tenant estricto: cada B2B customer es un namespace aislado con config propia (system prompt, branding, providers LLM habilitados). Auth de dos capas: API key por tenant para config (server-side only) + implicit auth cross-origin para identificar al visitor.

**Business model:** Track 2 es B2B revenue. El B2C user sigue siendo gratis (per STRATEGY). El B2B customer paga por la API del widget; pricing TBD (ver Plan 003 + Plan 004 para la surface area completa de billing).

---

## Problem Frame

Track 1 esta cerrado: tenemos perfiles sintetizados en Firestore bajo `users/{uid}/profile/main`. F4 del brainstorm define que un sitio integrado (A3) consulta el perfil del visitante (A1) y lo usa como contexto para su IA.

Track 1 dejo la coleccion `siteAccess` stubbeada y los endpoints de grant sin implementar (`docs/plans/2026-06-13-001-feat-importacion-pipeline-plan.md` U8). Track 2 cierra ese gap desde el lado del **widget embebido**: el caso mas simple de A3, donde ContextLayer provee la UI de chat completa (no solo la inyeccion de contexto, que es Track 3).

Por que el widget vale como track propio, separado de la API de integracion (Track 4): el 80% de los B2B prospects no tienen IA implementada. Track 2 es el producto que se vende a un e-commerce que quiere "agregar IA" sin construir un chatbot. Track 4 es para el caso opuesto: el B2B que ya tiene bot y solo quiere el contexto.

---

## Requirements

**Widget runtime**

R1. El snippet se sirve desde un CDN propio (`cdn.contextlayer.io/widget.js`) y es unico para todos los tenants — la diferenciacion viene del `data-tenant` attribute + API key.
R2. El widget no bloquea el render del sitio host: carga async, monta el chat bubble solo cuando el DOM esta listo.
R3. El widget identifica al visitante via **implicit auth** (OAuth-like passwordless, mismo modelo que Plan 004): session-check cross-origin a `auth.contextlayer.io/session-check?tenant=X` con `credentials: 'include'`. La cookie `__Host-context-layer-session` (set por `app.contextlayer.io` cuando el visitor hizo login en ContextLayer) viaja, el server detecta al user, deriva `visitorId = hash(uid + tenantId)[:12]`. Si no esta logueado, widget abre popup cross-origin a `auth.contextlayer.io/connect?tenant=X&redirect_uri=...` → Firebase Auth UI (1 click si ya logueado) → callback con `visitorId` + signature → B2B lo guarda en sessionStorage. Cero copy-paste de tokens. Device nuevo: re-auth automatico via Firebase (edge case esperado, no blocker).
R4. La sesion expira cuando expira la Firebase Auth session del visitor (default 1h, refresh automatico). El widget re-ejecuta session-check si la respuesta indica sesion invalida; no hay token del B2B customer que rotar.
R5. La UI soporta streaming de tokens del LLM (no espera respuesta completa).
R6. El widget funciona en mobile (responsive, viewport-aware) y desktop. No requiere login del visitante para chatear (a menos que el B2B customer lo requiera via token issuance).

**Tenant config (B2B)**

R7. Cada tenant tiene un document en `b2bTenants/{tenantId}/config` con: system prompt, branding (color primario, logo URL, nombre visible), providers LLM permitidos y default, rate limits, allowed origin domains para CORS, `siteAccess` mode (auto-grant en session-check vs explicit opt-in).
R8. El tenant se identifica por un `tenantId` (slug) + un `apiKey` per-tenant (rotable, scoped a `widget:read` y `chat:write`). API key es server-side only — el widget la recibe via signed handshake con el script (el `widget.js` bundle incluye el handshake endpoint, no la key en claro) o meta tag (`<meta name="contextlayer-api-key">`) puesto por el B2B customer. La key NUNCA viaja en URL ni en `data-*` attributes del snippet publico.
R9. Cambios de config (system prompt, branding) son efectivos sin redeploy del snippet — el widget re-fetch config al montar.
R10. La API key se valida server-side en cada request del widget; el widget no la almacena en localStorage del visitante (CORS/XSS leakage). CORS: el widget hace `fetch` con `credentials: 'include'` para que la cookie cross-origin viaje; la API key va en header `Authorization: Bearer`, no en URL.

**Multi-tenant data isolation**

R11. Las conversaciones de cada tenant viven en `b2bTenants/{tenantId}/visitors/{visitorId}/conversations/{conversationId}` y son inaccesibles cross-tenant (rules + admin SDK checks).
R12. El perfil del visitante B2C (leido de Track 1 `users/{uid}/profile/main`) **no se persiste** en el namespace del tenant — se lee en cada sesion via Plan 004 B2B profile endpoint `GET /api/v1/b2b/profile?visitor_id=vs_xxx` con la API key del tenant en header. El `visitor_id` viene del implicit auth (session-check). Asi el visitante no "contamina" su perfil de Track 1 con data que solo vio en el sitio del B2B.
R13. Si el visitante borra su data en Track 1, el efecto es inmediato: el siguiente chat del widget no recibe perfil.

**LLM call surface**

R14. El LLM call se hace server-side (Fastify); el browser nunca ve la API key del provider LLM.
R15. Streaming responses: server emite tokens via SSE, widget los pinta incremental.
R16. Cada call se loggea con `tenantId`, `visitorId`, `provider`, `inputTokens`, `outputTokens`, `latencyMs` (mismo shape que el cost telemetry de Track 1).
R17. Per-tenant rate limit (configurable en `b2bTenants/{tenantId}/config.rateLimit`): default 100 mensajes/dia/visitante; admin del tenant puede subir/bajar.

**Cross-track**

R18. El widget consume el perfil via Plan 004 B2B profile endpoint (`GET /api/v1/b2b/profile?visitor_id=vs_xxx`) con API key del tenant en header. El `visitor_id` viene del implicit auth flow (session-check + auth-connect popup). Plan 004 es owner del profile endpoint; Track 2 lo consume, no lo duplica.
R19. El LLM proxy es compartido con Plan 003 y Plan 004 — la abstraccion de provider se define una vez (en Plan 003, ya que Plan 003 arranca el shape del proxy con MiniMax M3 → DeepSeek chain).

---

## Key Technical Decisions

**Widget como Web Component, no iframe.** Web Component (`<contextlayer-chat>`) vive en el DOM del sitio host, hereda estilos via CSS custom properties que el B2B customer puede setear, no requiere iframe sandboxing. Iframe fue la alternativa; descartada por: (a) cross-origin del LLM stream requiere proxy adicional, (b) pierde tema del sitio host, (c) no permite que el bot lea contexto de la pagina actual (e.g. el producto que el visitante esta mirando). Trade-off conocido: el widget puede romper estilos del host si los CSS custom properties no estan bien aislados; mitigado con `all: revert-layer` en un shadow boundary interno.

**Implicit auth via cookie + localStorage + cross-origin auth popup (mismo modelo que Plan 004).** El B2B customer NO emite JWT. El widget detecta al visitor via session-check cross-origin: cuando el visitor esta logueado en ContextLayer (`app.contextlayer.io` seteo cookie `__Host-context-layer-session` con `SameSite=None; Secure` + localStorage `context-layer-user`), el widget hace `fetch('https://auth.contextlayer.io/api/v1/widget/session-check?tenant=acme', { credentials: 'include', mode: 'cors' })`, la cookie viaja, el server detecta al user, deriva `visitorId = hash(uid + tenantId)[:12]` deterministico, lazy-crea `siteAccess` si no existe. Si no esta logueado, el widget abre un popup cross-origin a `auth.contextlayer.io/connect?tenant=acme&redirect_uri=...`, Firebase Auth UI (1 click si ya logueado en ContextLayer), callback con `visitorId + HMAC-SHA256 signature` → B2B guarda en sessionStorage. Cero copy-paste de tokens, cero coordinacion fuera-de-banda. Conversion esperada >70% (vs <5% con JWT emitido por B2B). Trade-off: dependemos de `auth.contextlayer.io` disponible; si cae, el widget no autentica nuevos visitors, pero los ya autenticados siguen funcionando. Mitigacion: mismo SLA que el resto de la plataforma.

**Visitor ID = hash(uid + tenantId), no hash(visitorToken).** Determinista, cross-tenant unico: el mismo uid tiene `vs_aaa` en tenant X, `vs_bbb` en tenant Y. El B2B customer nunca ve el `uid` interno. El `siteAccess` se crea lazy on first session-check (no requiere paso explicito del visitor). Privacy: el B2B no sabe quien es el visitor (no tiene email); solo ContextLayer lo sabe (porque el visitor es nuestro user de Track 3). Esto invierte el modelo del plan original (donde el B2B tenia email y ContextLayer tenia token opaco) — el visitor B2C queda en control: borra su data en Track 1, y todos los B2B pierden acceso inmediatamente (cascade revoke via Cloud Function, ver Plan 004 U2).

**Per-tenant namespace en Firestore, no un `tenantId` field global.** Cada tenant tiene su propio sub-tree en Firestore (`b2bTenants/{tenantId}/...`). Esto permite security rules estrictas: las rules de un tenant no pueden leer/escribir data de otro tenant sin un path traversal explicito. La alternativa (un solo collection con `tenantId` field) es fragil — un bug en una query filtra data cross-tenant. Trade-off: queries globales (e.g. "todos los tenants activos") requieren `listCollections` en vez de una query simple.

**System prompt del tenant + perfil del visitante concatenados.** El system prompt del B2B customer define la personalidad y el scope del bot. El perfil del visitante se inserta como un bloque estructurado despues del system prompt. El LLM recibe ambos como contexto. Trade-off: el system prompt largo + perfil largo puede acercarse al context window; mitigado con summarization del perfil (similar al cascade de Track 1, ver Plan 003).

**Sin UI de admin en V1.** El tenant se configura via Firestore console o un script CLI; no hay dashboard web. El B2B customer edita su `b2bTenants/{tenantId}/config` directamente o via `pnpm tsx scripts/tenant-config.ts set <tenantId> <key> <value>`. La UI de admin es un track separado (potencial revenue, deferred).

**Chat history persistida por tenant, no por visitante global.** Un visitante que chatee con dos tenants tiene dos historiales independientes. Esto refleja la realidad: lo que el usuario le dijo al bot de un e-commerce no es relevante para el bot de otro. Trade-off: si el visitante quiere "mi historial de chat con todos mis bots", no existe — eso seria un producto distinto.

**Visitor ID = hash(uid + tenantId), no email.** El visitante se identifica por `hash(uid + tenantId)[:12]` (base62) en el namespace del tenant. Determinista, cross-tenant unico: el mismo uid tiene `vs_aaa` en tenant X, `vs_bbb` en tenant Y. Esto evita que el email del visitante (PII) termine en logs de Firestore o indices del tenant. El B2B customer nunca ve el `uid` interno — solo el `visitorId` opaco. Trade-off: si el visitor B2C cambia de sesion (logout/login en ContextLayer), el `visitorId` se mantiene estable (mismo uid, mismo hash); pero si el visitor borra su cuenta en Track 1, el cascade revoke apaga el `siteAccess` y el B2B pierde acceso (correcto — es el visitor decidiendo).

**Subresource Integrity (SRI) en el script tag del widget.** El bundle se sirve desde `cdn.contextlayer.io/widget.v{N}.js` con un hash SHA-384 pinned en el snippet que el B2B customer incrusta: `<script src="...widget.v3.js" integrity="sha384-..." crossorigin="anonymous" data-tenant="..."></script>`. Sin SRI, un compromiso del CDN sirve codigo malicioso que se ejecuta en el contexto de origen del sitio host del B2B customer — robo de cookies, exfiltration de form data, keylogging del chat. El hash se regenera en cada release; el onboarding kit publica el snippet con el hash actual y los B2B customers lo actualizan al upgradear. Trade-off: el B2B customer tiene que mantener el snippet sincronizado con la version. Alternativa descartada: dynamic load (`fetch` + verify + `eval`) — peor DX, peor CSP compatibility, mismo riesgo si el verify es client-side. La version pin en el filename (`widget.v3.js`) permite cache-busting sin tocar el hash. El release pipeline (`scripts/release-widget.ts`) calcula el hash, lo publica en `docs/widget-snippets.md` por version, y falla el release si el hash de un build anterior cambia retroactivamente.

---

## Output Structure

```
contextlayer/
├── public/
│   └── widget/
│       ├── widget.js               # bundle del widget (entry point)
│       ├── widget.css              # estilos base + custom properties
│       └── chat-bubble.svg         # icono del bubble
├── src/
│   ├── routes/
│   │   ├── widget-config.ts        # GET /api/v1/widget/config?tenant=... (config del tenant + branding)
│   │   ├── widget-session-check.ts # GET /api/v1/widget/session-check?tenant=X (implicit auth detect: cookie viaja, server returns visitorId)
│   │   ├── widget-chat.ts          # POST /api/v1/widget/chat (SSE stream del LLM, visitorId del cookie o query param)
│   │   └── b2b-profile.ts          # GET /api/v1/b2b/profile?visitor_id=vs_xxx (perfil del visitante, Plan 004 endpoint que Track 2 consume)
│   ├── widget/
│   │   ├── mount.ts                # bootstrap del Web Component + session-check
│   │   ├── auth-popup.ts           # window.open cross-origin a auth.contextlayer.io/connect, postMessage handshake
│   │   ├── chat-ui.ts              # render del bubble + panel
│   │   ├── stream.ts               # cliente SSE
│   │   └── visitor-session.ts      # guarda visitorId en sessionStorage tras callback del popup
│   ├── b2b/
│   │   ├── tenants.ts              # CRUD de tenants (admin only, no public API)
│   │   ├── tenant-config.ts        # read/validate config per tenant
│   │   ├── visitor-id.ts           # hash(uid + tenantId)[:12] determinista
│   │   ├── siteaccess.ts           # lazy-create siteAccess record on first session-check
│   │   └── chat-history.ts         # write/read conversations en b2bTenants/...
│   ├── llm/                        # cross-track proxy (definido en Plan 003)
│   └── firestore/
│       ├── tenant-rules.test.ts    # tests de las security rules multi-tenant
│       └── tenant-rules.rules      # security rules de b2bTenants (admin-only write desde server)
└── scripts/
    ├── tenant-config.ts            # CLI: read/set tenant config
    ├── tenant-bootstrap.ts         # CLI: crear tenant nuevo con config inicial
    └── release-widget.ts           # build bundle, calcular SRI hash, publicar snippet en docs/widget-snippets.md
```

`docs/widget-snippets.md` (versionado, fuera de `src/`): tabla de versiones con URL + integrity hash + snippet completo listo para copiar. Cada release actualiza este archivo; el onboarding kit linkea a la ultima version.

---

## High-Level Technical Design

```mermaid
flowchart TB
  subgraph "B2B Customer Site (host)"
    H[HTML del sitio host] -->|script data-tenant=acme + meta api-key| W[widget.js]
    W -->|GET /widget/config + Auth header| WC[Widget config + branding]
    W -->|GET /widget/session-check<br/>credentials: include| SC[Session check]
    SC -->|cookie viaja| AUTH_CTX[auth.contextlayer.io]
    AUTH_CTX -->|verifies Firebase session| FS_AUTH[(Firebase Auth)]
    AUTH_CTX -->|uid| VID[visitorId = hash(uid + tenantId) :12]
    VID -->|lazy create| FS_SA[(siteAccess/vs_xxx)]
    AUTH_CTX -->|visitorId| W

    W -.->|if not authenticated| POPUP[window.open auth.contextlayer.io/connect]
    POPUP -->|Firebase Auth UI| AUTH_CTX
    AUTH_CTX -->|postMessage visitorId| W
  end

  subgraph "ContextLayer API (Fastify)"
    WC -->|read b2bTenants/acme/config| FS1[(Firestore)]

    W -->|GET /b2b/profile?visitor_id=vs_xxx<br/>Auth: tenant API key| BP[Plan 004 b2b-profile route]
    BP -->|verify visitorId| VA[visitor-id check]
    VA -->|get users/{uid}/profile/main| FS2[(Firestore Track 1)]
    FS2 -->|profile JSON| BP
    BP -->|profile| W

    W -->|POST /widget/chat (SSE)<br/>cookie + Auth header| CH[widget-chat route]
    CH -->|verify session cookie| AUTH_CTX
    CH -->|fetch tenant config| TC[tenant-config]
    TC -->|read| FS1
    CH -->|fetch profile| BP
    CH -->|call LLM proxy| LP[LLM Proxy (Plan 003)]
    LP -->|streaming tokens| CH
    CH -->|append message| FS3[(b2bTenants/acme/visitors/{vid}/conversations)]
    CH -->|SSE stream| W
    W -->|paint tokens| U[Chat UI]
  end
```

**Firestore schema (multi-tenant, anadido al de Track 1):**

```
b2bTenants/{tenantId}
  config
    systemPrompt: string
    branding: { primaryColor, logoUrl, displayName }
    allowedProviders: ["openai", "anthropic", "google", "openrouter"]
    defaultProvider: "openai"
    rateLimit: { messagesPerVisitorPerDay: 100 }
    allowedOrigins: ["https://acme.com", "https://www.acme.com"]
    updatedAt: Timestamp

  apiKeys/{keyId}
    keyHash: string          # SHA-256 de la key real; la key solo se retorna al crear
    scopes: ["config:read", "chat:write"]
    createdAt: Timestamp
    lastUsedAt: Timestamp
    active: boolean

  visitors/{visitorId}
    conversations/{conversationId}
      provider: string
      messages: [{role, content, timestamp}]
      createdAt: Timestamp
      lastMessageAt: Timestamp
      tokenCountIn: number
      tokenCountOut: number
```

**Cross-track data flow:**

- **Track 1 → Track 2:** `users/{uid}/profile/main` (perfil del B2C) se lee via Plan 003 API (`GET /api/v1/widget/profile` con visitor token). El perfil NO se copia al namespace del tenant.
- **Track 2 → Track 1:** el chat del B2B customer no escribe al perfil del B2C. El usuario decidio en Track 1 que su perfil es lo que el importo, no lo que los bots de terceros le preguntaron. (Esto es debatable; ver Open Question OQ-W2.)
- **Plan 003 → Track 2:** la abstraccion `LLM Proxy` se define en Plan 003; Track 2 la consume via `src/llm/`. Multi-provider (OpenAI, Anthropic, Google, OpenRouter) con la misma interfaz.

---

## Implementation Units

### U1. Firestore schema multi-tenant + security rules

**Goal:** Definir el sub-tree `b2bTenants/{tenantId}/...` con rules estrictas de aislamiento cross-tenant, y dejar admin SDK paths para los writes server-side.

**Requirements:** R10, R11, R13.

**Dependencies:** U1 de Track 1 (Firebase Admin SDK ya inicializado).

**Files:**
- `firestore.rules` (anadir las rules de `b2bTenants`)
- `src/firestore/tenant-rules.test.ts`

**Approach:** Rules para `b2bTenants/{tenantId}/...`:
- `config`: read solo desde el cliente con `apiKey` valida via custom claim (no — la API key no es un Firebase Auth token, es server-side only). Entonces: read del config desde el browser NO es directo; pasa por `GET /api/v1/widget/config` que valida la API key server-side.
- `apiKeys`: read/write solo desde Admin SDK (no client access).
- `visitors/{visitorId}/conversations/...`: read/write solo desde Admin SDK. Browser no toca Firestore directamente.

El Admin SDK bypassa rules. Server-side checks en `src/b2b/tenant-config.ts` son la fuente de verdad de autorizacion: cada read/write incluye `tenantId` en la query y se valida contra el path destino.

**Test scenarios:**
- Cliente A intenta leer `b2bTenants/tenantB/config` → denied
- Cliente A intenta escribir `b2bTenants/tenantA/visitors/X/conversations/Y` sin pasar por Admin SDK → denied
- Admin SDK escribe en `b2bTenants/tenantA/visitors/X/conversations/Y` → allowed
- Read de `b2bTenants/tenantA/apiKeys/{keyId}` desde cliente → denied
- Security rules test corre contra Firestore emulator

**Verification:** `pnpm test` corre los tests de rules; output muestra "5/5 deny, 2/2 admin-allow".

### U2. Tenant config + API key issuance CLI

**Goal:** Crear tenants via CLI con config inicial y emitir API keys.

**Requirements:** R7, R8.

**Dependencies:** U1.

**Files:**
- `scripts/tenant-bootstrap.ts`
- `scripts/tenant-config.ts`
- `src/b2b/tenants.ts`

**Approach:** `tenant-bootstrap.ts` toma `tenantId` + config inicial (system prompt, branding, providers permitidos, rate limits) y crea el documento `b2bTenants/{tenantId}/config`. Emite una API key (`cl_` prefix + 32 bytes random, base64url) y la muestra UNA vez al operador (no se almacena en claro, solo el hash SHA-256). `tenant-config.ts` lee/setea campos individuales.

**Test scenarios:**
- `pnpm tsx scripts/tenant-bootstrap.ts create acme --system-prompt "..." --primary "#0066cc"` crea el tenant y emite key
- Re-ejecutar con el mismo `tenantId` falla con error claro (no overwrite silencioso)
- `pnpm tsx scripts/tenant-config.ts set acme rateLimit.messagesPerVisitorPerDay 500` actualiza el campo
- API key emitida tiene formato `cl_<43 chars>`; SHA-256 se persiste en `apiKeys/{keyId}.keyHash`
- `pnpm tsx scripts/tenant-config.ts list` lista todos los tenants con sus configs (read-only)

**Verification:** Tras ejecutar el script, `firestore.getDoc('b2bTenants/acme/config')` retorna el config creado; el hash de la API key esta en `apiKeys/{keyId}`.

### U3. Widget config + session-check endpoints (implicit auth)

**Goal:** API endpoints que el widget llama al montar: `GET /api/v1/widget/config?tenant=acme` (config + branding, requires tenant API key) y `GET /api/v1/widget/session-check?tenant=X` (implicit auth detect, requires Firebase session cookie cross-origin).

**Requirements:** R1, R3, R7, R8, R9, R10.

**Dependencies:** U1, U2, Plan 003 (B2C auth context), Plan 004 U1 (session-check endpoint pattern).

**Files:**
- `src/routes/widget-config.ts`
- `src/routes/widget-session-check.ts`
- `src/b2b/visitor-id.ts` (hash determinista)
- `src/b2b/siteaccess.ts` (lazy-create)
- `src/middleware/tenant-api-key.ts`

**Approach:**

`GET /api/v1/widget/config?tenant=acme`: el widget pasa la API key en `Authorization: Bearer <apiKey>` (header, no URL). El middleware `tenant-api-key.ts` valida: (1) extrae `keyHash = SHA-256(apiKey)`, (2) lookup en `b2bTenants/{tenantId}/apiKeys/{keyId}` por `keyHash`, (3) verifica `active: true`, (4) verifica que `origin` del request esta en `config.allowedOrigins`, (5) verifica scope (`widget:read` o `chat:write` segun endpoint). Response: config JSON (system prompt, branding, providers, rate limit, `siteAccess` mode).

`GET /api/v1/widget/session-check?tenant=X`: el browser hace `fetch` con `credentials: 'include'` y `mode: 'cors'`. La cookie `__Host-context-layer-session` (set por `app.contextlayer.io` via `Set-Cookie: __Host-context-layer-session=...; SameSite=None; Secure; Path=/`) viaja al server de ContextLayer. El server: (1) extrae la session cookie, (2) verifica via Firebase Admin SDK que es valida (`auth.verifySessionCookie`), (3) obtiene `uid`, (4) deriva `visitorId = SHA-256(uid + tenantId)[:12]` (base62), (5) check `siteAccess/{visitorId}`: si no existe, lazy-create con `grantedAt: serverTimestamp, revokedAt: null, accessCount: 0`. Response: `{ authenticated: true, visitorId: "vs_xxx" }`. Si la cookie no esta o expiro: `{ authenticated: false, signInUrl: "https://auth.contextlayer.io/connect?tenant=X&redirect_uri=..." }`. El widget muestra el sign-in CTA que abre el popup.

**Test scenarios:**
- Request a `/widget/config` sin Authorization → 401 `{ error: "missing_api_key" }`
- Request con API key invalida → 401 `{ error: "invalid_api_key" }`
- Request con API key valida pero origin no en `allowedOrigins` → 403 `{ error: "origin_not_allowed" }`
- Request con API key valida y origin allowed → 200 con config completo
- `/widget/session-check` con cookie `__Host-context-layer-session` valida + tenant X → 200 `{ authenticated: true, visitorId: "vs_..." }`
- `/widget/session-check` con cookie valida + tenant X, segunda llamada → mismo `visitorId` (determinista)
- `/widget/session-check` con cookie valida + tenant Y → `visitorId` distinto (cross-tenant unico)
- `/widget/session-check` sin cookie o cookie expirada → 200 `{ authenticated: false, signInUrl: "..." }`
- Cambiar `systemPrompt` en `tenant-config.ts` se refleja en el siguiente `/widget/config` request sin redeploy del snippet
- `siteAccess/{visitorId}` se crea lazy on first session-check; segundo check no duplica

**Verification:** Crear tenant `acme` con config conocido; `curl` con API key retorna el config; `curl` con una Firebase session cookie de un B2C user valido al endpoint `/widget/session-check?tenant=acme` retorna `{ authenticated: true, visitorId: "vs_..." }`. Visitor ID es determinista cross-call.

### U4. Widget bundle (Web Component + implicit auth + auth popup)

**Goal:** El bundle JS que el B2B customer incluye en su sitio. Levanta el Web Component, ejecuta session-check implicit auth, abre popup cross-origin si el visitor no esta logueado, monta el chat bubble, abre el panel de chat.

**Requirements:** R1, R2, R3, R4, R5, R6.

**Dependencies:** U3 (los endpoints que consume), Plan 003 (B2C auth context expone `auth.contextlayer.io`).

**Files:**
- `public/widget/widget.js`
- `public/widget/widget.css`
- `src/widget/mount.ts`
- `src/widget/auth-popup.ts`
- `src/widget/visitor-session.ts`
- `src/widget/chat-ui.ts`
- `src/widget/stream.ts`

**Approach:** Bundle con `esbuild` (anadir a `package.json`), target ES2020, output a `public/widget/widget.js`. Entry point `mount.ts`:

1. Lee `data-tenant` del `<script>` tag y la API key de `<meta name="contextlayer-api-key">` (NO de data attribute — eso expone la key en el HTML).
2. Fetch `/api/v1/widget/config?tenant=X` con `Authorization: Bearer <apiKey>`. Si 401/403 → log error claro, no monta.
3. Si 200 → fetch `/api/v1/widget/session-check?tenant=X` con `credentials: 'include', mode: 'cors'`. La cookie `__Host-context-layer-session` viaja automaticamente.
4. Si `{ authenticated: true, visitorId: "vs_xxx" }` → guarda visitorId en `sessionStorage`, monta bubble.
5. Si `{ authenticated: false, signInUrl }` → monta bubble con un CTA "Sign in to ContextLayer" en lugar del chat. Click → `auth-popup.ts` abre `window.open(signInUrl, 'contextlayer-auth', 'width=480,height=640')`. Popup carga Firebase Auth UI. Tras login, callback a `auth.contextlayer.io/connect/callback?redirect_uri=...&visitor_id=...&signature=...` → popup hace `window.opener.postMessage({ type: 'contextlayer-auth-success', visitorId }, origin)` y se cierra.
6. Widget escucha el postMessage, valida `event.origin === 'https://auth.contextlayer.io'`, guarda visitorId en sessionStorage, re-monta el chat.

El Web Component es un `customElements.define('contextlayer-chat', ...)`. CSS custom properties (`--contextlayer-primary`, `--contextlayer-position`) permiten al B2B customer customizar sin tocar el bundle.

**Test scenarios:**
- Script tag con `data-tenant="acme"` pero sin `<meta name="contextlayer-api-key">` → no monta, error claro en consola
- Widget en sitio donde visitor ya esta logueado en ContextLayer → session-check retorna `{ authenticated: true }`, bubble monta inmediatamente sin popup
- Widget en sitio donde visitor NO esta logueado → bubble monta con CTA "Sign in"; click abre popup; tras login, bubble se actualiza a chat input
- Popup postMessage con `event.origin` distinto a `https://auth.contextlayer.io` → ignorado (origin validation)
- Popup postMessage con `visitorId` mal firmado → ignorado (signature verification)
- Widget en sitio con CSP estricta que bloquea scripts inline → falla con error claro (no silent fail)
- Widget en mobile viewport (375px) → bubble en bottom-right no choca con el contenido
- visitorId persiste en sessionStorage durante navegacion SPA; se borra al cerrar tab
- Visitor en device nuevo (sin cookie) → widget muestra CTA, popup hace login, funciona normal
- **SRI:** script tag con `integrity="sha384-..."` y `crossorigin="anonymous"`; hash mismatch → browser rechaza el script
- **SRI release:** `scripts/release-widget.ts` genera bundle, calcula SHA-384, publica en `docs/widget-snippets.md`
- **CSP:** sitio host con CSP estricta que permite solo `'self'` en `script-src` rechaza el widget — documentado en onboarding (B2B customer debe anadir `cdn.contextlayer.io` a `script-src` + `connect-src` para los endpoints cross-origin)

**Verification:** Incrustar el snippet en una pagina HTML de prueba, abrir en browser (con sesion de ContextLayer activa en otra tab), ver el bubble sin popup; cerrar sesion, refrescar → CTA aparece; click → popup → login → chat input. Enviar mensaje → respuesta streamed.

### U5. Chat route + SSE streaming + LLM proxy integration

**Goal:** `POST /api/v1/widget/chat` recibe el mensaje del visitante, verifica implicit auth via session cookie o `visitor_id` query param + API key, llama al LLM proxy (Plan 003) con system prompt + perfil del visitante + historial de la conversacion, streamea los tokens via SSE, persiste al final.

**Requirements:** R5, R11, R14, R15, R16, R17.

**Dependencies:** U1, U3, U4, Plan 003 (LLM Proxy merged), Plan 004 U3 (profile endpoint merged).

**Files:**
- `src/routes/widget-chat.ts`
- `src/b2b/chat-history.ts`

**Approach:** Request: `POST /api/v1/widget/chat` con `Authorization: Bearer <apiKey>` (tenant API key) + `Cookie: __Host-context-layer-session=...` (cross-origin, viaja via `credentials: 'include'`). O alternativamente para tests: `?tenant=acme&visitor_id=vs_xxx` con API key en header. Body: `{ conversationId?, message }`.

Server: (1) middleware `tenant-api-key.ts` valida API key + origin. (2) Auth check: si cookie presente, `verifySessionCookie` → `uid` → `visitorId = hash(uid + tenantId)[:12]`. Si no cookie pero `visitor_id` query + API key, usar el query param (modo test / B2B backend integration). (3) Verifica `siteAccess/{visitorId}.revokedAt === null`. (4) Lee `b2bTenants/{tenantId}/config` (system prompt, default provider, rate limit). (5) Llama `GET /api/v1/b2b/profile?visitor_id=vs_xxx` con API key (proxy interno a Plan 004 endpoint) → profile JSON. (6) Construye messages: `[{role: 'system', content: systemPrompt + '\n\nUser profile:\n' + JSON.stringify(profile)}, ...conversationHistory, {role: 'user', content: message}]`. (7) Llama LLM proxy con streaming. (8) Pipe tokens al SSE response. (9) Al cerrar stream, persiste `b2bTenants/{tenantId}/visitors/{visitorId}/conversations/{conversationId}` con messages + tokenCount. Increment `siteAccess/{visitorId}.accessCount`.

Rate limiting: counter en `b2bTenants/{tenantId}/rateLimits/{visitorId}.messagesToday` con TTL de 24h. Increment por mensaje, reject si > `rateLimit.messagesPerVisitorPerDay`. Retorna 429 con `Retry-After`.

**Test scenarios:**
- Request sin Authorization y sin cookie/visitor_id → 401
- Request con API key valida + cookie valida + tenant match → 200, SSE stream funciona, conversacion persistida
- Request con API key valida + cookie valida + tenant mismatch (cookie de otro tenant) → 403
- Request con API key valida + `visitor_id` query (modo test) → 200, perfil fetch correcto
- Mensaje normal → LLM proxy llamado, tokens streameados, conversacion persistida con `tokenCountIn`/`tokenCountOut`
- Conversacion existente (conversationId provisto) → historial incluido en messages array
- Nueva conversacion (conversationId null) → creada con ID auto-generado
- Rate limit exceeded → 429 con `Retry-After`
- Provider falla mid-stream → SSE `event: error` + cierre limpio del stream
- Dos requests concurrentes del mismo visitante → procesan en paralelo (no lock global)
- Token counts loggeados con `tenantId`, `visitorId`, `provider`
- `siteAccess.revokedAt` no nulo (cascade revoke de Plan 004) → 403 `{ error: "access_revoked" }`

**Verification:** Widget en sitio de prueba: enviar 3 mensajes, ver respuestas streamed. `firestore.getDoc('b2bTenants/acme/visitors/{vid}/conversations/{cid}')` muestra los 6 mensajes (3 user + 3 assistant) con tokenCount. `siteAccess/{vid}.accessCount` == 3.

### U6. B2B profile fetch via Plan 004 endpoint (cross-track)

**Goal:** El chat route (U5) y el widget (U4) leen el perfil del visitante via Plan 004 B2B profile endpoint. Track 2 NO duplica este endpoint — consume el de Plan 004. Si Plan 004 no esta merged al ejecutar U6, U5 hace la llamada directa al Firestore con Admin SDK (fallback), y se refactoriza cuando Plan 004 merge.

**Requirements:** R12, R13, R18.

**Dependencies:** Plan 004 U3 (B2B profile endpoint). Si Plan 004 no esta listo, fallback a lectura directa de `users/{uid}/profile/main` con Admin SDK.

**Files:**
- `src/b2b/profile-client.ts` (wrapper sobre Plan 004 endpoint con fallback)

**Approach:** Funcion `fetchB2BProfile(tenantId, visitorId, apiKey): Promise<Profile | null>`. Intenta `GET https://api.contextlayer.io/api/v1/b2b/profile?visitor_id=${visitorId}` con `Authorization: Bearer ${apiKey}`. Si la respuesta es 200 → retorna profile JSON. Si 404 (visitor no existe) → retorna null. Si 503 / network error → fallback a `firestore.getDoc('users/{uid}/profile/main')` re-derivando el uid desde el visitorId (lookup en `siteAccess/{visitorId}.uid`). Esto solo es necesario si Plan 004 no esta merged al deploy de U6.

**Test scenarios:**
- Visitor A con perfil en Track 1 + session-check exitoso → fetchB2BProfile retorna profile JSON
- Visitor A sin perfil (nunca importo) → fetchB2BProfile retorna null
- Visitor A borra su data en Track 1 (`DELETE /api/v1/user/data`) → siguiente fetchB2BProfile retorna null
- Plan 004 endpoint caido → fallback a Admin SDK funciona (con test mocking del fetch failure)
- visitorId invalido → 404 desde Plan 004, null retornado

**Verification:** Visitor A importa data (Track 1), abre widget en sitio B2B, primer chat incluye su perfil en el system prompt; visitor A borra su data en Track 1, segundo chat no incluye perfil (profile == null, system prompt ajustado).

---

## Scope Boundaries

**Deferred for later**

- UI de admin web para gestionar tenants (system prompt editor, branding, rate limits). V1 es CLI + Firestore console.
- Multi-idioma del widget (i18n del UI del chat). V1 es Ingles + Espanol hardcoded.
- File upload dentro del chat (e.g. el visitante sube una imagen). V1 es text-only.
- Voice / TTS / STT.
- Webhooks al backend del B2B customer en eventos del chat (e.g. "lead captured").
- Custom domain para el widget (el B2B customer hostea el bundle en su CDN).

**Outside this product's identity**

- El widget es un chat B2C. No es un helpdesk, no es un CRM, no es un ticketing system.
- El B2B customer NO accede a `users/{uid}/profile/main` directamente — solo via la API de ContextLayer con scope check. Esto preserva el control de privacidad del visitante.

**Deferred to Follow-Up Work**

- Track 4 (context injection) puede ser consumido por el widget via una flag `useExternalBot: true` que deshabilita el chat UI y solo emite el perfil al bot del B2B customer. Out of scope para este plan; coordinar con Plan 004.
- Plan 003 define la abstraccion `LLM Proxy` con un set base de providers. Si un B2B customer quiere un provider custom (e.g. su propio modelo fine-tuneado), eso es una extension del proxy, no de Track 2.

---

## Dependencies / Assumptions

- Track 1 (import pipeline) cerrado y verificado. Perfiles existen en `users/{uid}/profile/main`.
- Plan 003 (consumer app) cerrado. Proveee el contexto de auth B2C (`app.contextlayer.io` con cookie `__Host-context-layer-session` + Firebase Auth).
- Plan 004 (context injection) mergeado antes que U3+ de este plan. Proveee el profile endpoint (`GET /api/v1/b2b/profile`) y el patron session-check (`auth.contextlayer.io`). Si Plan 004 no esta listo, U6 usa fallback a Admin SDK directo.
- Firebase project `context-layer-93a65` unico namespace; no se anaden proyectos.
- B2B customer NO emite JWT. El visitor B2C se identifica via implicit auth cross-origin.
- Browsers target: ultimas 2 versiones de Chrome, Firefox, Safari, Edge. IE11 fuera de scope.
- CDN: Firebase Hosting (recomendacion OQ-W1 resuelta) — consolida con el resto del stack. El bundle es estatico, no requiere edge compute.
- Web Crypto API disponible en todos los browsers target. Usado por el popup callback para validar la firma HMAC-SHA256 del visitorId.
- El bundle del widget es <50KB gzip. Linting: `esbuild --minify --sourcemap`.

---

## Open Questions

**OQ-W1.** ¿Donde se sirve `widget.js`? Opciones: (a) Cloudflare CDN delante de un bucket GCS/S3, (b) Firebase Hosting, (c) Vercel static. Recomiendo (b) Firebase Hosting para consolidar surface area con el resto del stack. Resoluble en planning o durante U4.

**OQ-W2.** ¿El chat del B2B customer contamina el perfil del B2C user en Track 1? Resuelto 2026-06-16: **no**. El chat en el widget del B2B customer no se escribe al perfil del B2C user. El visitante decidio en Track 1 que su perfil es lo que el importa, no lo que le dice a bots de terceros. (El comportamiento opuesto — si el chat contamina el perfil — aplica al B2C user chateando con su propia app de Track 3, no con widgets de B2B customers. Ver Plan 003 OQ-C3 resuelto.)

**OQ-W3.** ¿El B2B customer paga por mensaje, por MAU, o flat-fee? Pricing model es un track separado. Asumir pricing flat-fee + overage para V1; el rate limit del config es el knob de control de costo. Resoluble post-MVP.

**OQ-W4.** ¿Soporte para multiple conversaciones paralelas del mismo visitante? V1 asume una conversacion activa por tenant por visitor. Si el visitante abre dos tabs, comparten historial. Multi-thread es V2.

**OQ-W5.** ¿El widget soporta Markdown en las respuestas del bot? Mi recomendacion: si, con `react-markdown` o similar en el bundle. Trade-off: +15KB al bundle. Resoluble durante U4.

**OQ-W6.** ¿Que pasa si el LLM provider del tenant esta caido? Failover a otro provider de la lista `allowedProviders`? O devolver error al visitor? Mi default: failover, configurable via `config.fallbackProvider`. Documentar en U5.

**OQ-W7.** ¿Como se da de baja un tenant? `tenant-bootstrap.ts delete <tenantId>` debe (a) borrar todos los documents bajo `b2bTenants/{tenantId}/...`, (b) revocar todas las API keys, (c) opcionalmente borrar las conversaciones (GDPR right-to-erasure). Resoluble en U2.

**OQ-W8.** ¿Que pasa si el B2B customer olvida actualizar el snippet y queda con una version vieja del widget con un bug de seguridad conocido? El release pipeline deberia (a) loggear cuando un widget viejo (version < N) hace un request, (b) alertar al equipo de B2B customers. Resoluble durante U5 (telemetria) y fuera de scope del release tooling.

---

## Sources & Research

- Track 1 plan: `docs/plans/2026-06-13-001-feat-importacion-pipeline-plan.md` (esquema Firestore, auth pattern, cost telemetry shape)
- Track 1 cost model: `docs/plans/2026-06-13-002-feat-u5-cost-model-plan.md` (multi-provider baseline assumption)
- STRATEGY.md: B2B revenue model, F4 (B2B consulta perfil del visitante)
- Origin brainstorm: `docs/brainstorms/2026-06-13-importacion-contexto-ia-requirements.md` (R16, R17, F4)
- Intercom / Drift widget architecture: bundles estaticos servidos desde CDN del vendor; API key expuesta en el HTML (mitigada con dominio allowlist + rate limit per key); ver `https://www.intercom.com/help/en/articles/167-install-intercom-on-your-website` para el patron.
- Web Components + Shadow DOM: la opcion para no romper el CSS del host.
- SSE streaming: `EventSource` API para one-way, `fetch` + ReadableStream para two-way. Patron similar al de U5 pero con response streaming.
- Firebase Hosting: static + dynamic con Cloud Functions. Reusa el billing y el dominio del Firebase project.

---

## Resolved Decisions

**2026-06-16 — OQ-W2 (contamination del perfil por chat del widget).** El chat del B2B customer no contamina el perfil del B2C user en Track 1. Reflejado en R12 y en el KTD "Chat history persistida por tenant, no por visitante global". El comportamiento opuesto (chat que SI contamina) aplica solo al B2C user chateando con su propia app de Track 3 — ver Plan 003 resuelto del mismo dia.

**2026-06-20 — Auth model: implicit via localStorage + cross-origin auth popup (alineado con Plan 003/004).** Plan 002 original proponia "visitor token emitido por el B2B customer" (JWT firmado con la API key del tenant, B2B owns visitor identity). Evolucion: Plan 003 pivoteo a B2C user con cuenta en ContextLayer (cookie + localStorage); Plan 004 adopto implicit auth cross-origin para que el B2B no tenga que emitir tokens. Para mantener consistencia cross-track, Plan 002 se alinea con el modelo de Plan 004. Cambio de scope: R3, R4, R8, R10, R12, R18 reescritos; U3 (visitor-token endpoint) reemplazado por `widget-session-check`; U4 (widget bundle) ahora abre popup cross-origin; U5/U6 consumen el profile endpoint de Plan 004. El B2B customer ya no emite JWT — el visitor B2C se identifica via Firebase session cookie cross-origin + `visitorId = hash(uid + tenantId)[:12]`. Privacy tradeoff invertido: antes el B2B tenia email y ContextLayer tenia token opaco; ahora ContextLayer tiene el identity (es nuestro user) y el B2B tiene solo el visitorId opaco. Ventaja: el visitor B2C queda en control (borra data en Track 1 → cascade revoke apaga acceso a todos los B2B).

**2026-06-20 — OQ-W1 (CDN para widget.js).** Resuelto: Firebase Hosting. Consolida con el resto del stack (mismo billing, mismo dominio, mismo deploy pipeline). El bundle se sirve desde `cdn.contextlayer.io` con cache-control de 1 ano + SRI hash pinneado en el snippet.
