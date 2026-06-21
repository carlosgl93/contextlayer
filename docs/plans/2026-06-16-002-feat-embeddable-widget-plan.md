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

JS snippet (`<script src="https://cdn.contextlayer.io/widget.js" data-tenant="..."></script>`) que B2B customers dropean en su HTML. El widget levanta una UI de chat, identifica al visitante B2C (vía session token del cliente B2B), lee su perfil sintetizado de Track 1 via API, y mantiene conversaciones persistidas en `b2bTenants/{tenantId}/visitors/{visitorId}/conversations/...`. Multi-tenant estricto: cada B2B customer es un namespace aislado con config propia (system prompt, branding, providers LLM habilitados). Auth de dos capas: API key por tenant para config y un visitor token de corta duracion para leer el perfil del visitante.

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
R3. El widget identifica al visitante via un token de sesion emitido por el backend del B2B customer. El B2B customer decide como emitirlo (cookie propia, link email, etc.); ContextLayer no lo emite.
R4. La sesion expira despues de 24h de inactividad; el widget re-pide token al B2B customer.
R5. La UI soporta streaming de tokens del LLM (no espera respuesta completa).
R6. El widget funciona en mobile (responsive, viewport-aware) y desktop. No requiere login del visitante para chatear (a menos que el B2B customer lo requiera via token issuance).

**Tenant config (B2B)**

R7. Cada tenant tiene un document en `b2bTenants/{tenantId}/config` con: system prompt, branding (color primario, logo URL, nombre visible), providers LLM permitidos y default, rate limits, allowed origin domains para CORS.
R8. El tenant se identifica por un `tenantId` (slug) + un `apiKey` per-tenant (rotable, scoped a `config:read` y `chat:write`).
R9. Cambios de config (system prompt, branding) son efectivos sin redeploy del snippet — el widget re-fetch config al montar.
R10. La API key se valida server-side en cada request del widget; el widget no la almacena en localStorage del visitante (CORS/XSS leakage).

**Multi-tenant data isolation**

R11. Las conversaciones de cada tenant viven en `b2bTenants/{tenantId}/visitors/{visitorId}/conversations/{conversationId}` y son inaccesibles cross-tenant (rules + admin SDK checks).
R12. El perfil del visitante B2C (leido de Track 1 `users/{uid}/profile/main`) **no se persiste** en el namespace del tenant — se lee en cada sesion via la API de perfil con el visitor token. Asi el visitante no "contamina" su perfil de Track 1 con data que solo vio en el sitio del B2B.
R13. Si el visitante borra su data en Track 1, el efecto es inmediato: el siguiente chat del widget no recibe perfil.

**LLM call surface**

R14. El LLM call se hace server-side (Fastify); el browser nunca ve la API key del provider LLM.
R15. Streaming responses: server emite tokens via SSE, widget los pinta incremental.
R16. Cada call se loggea con `tenantId`, `visitorId`, `provider`, `inputTokens`, `outputTokens`, `latencyMs` (mismo shape que el cost telemetry de Track 1).
R17. Per-tenant rate limit (configurable en `b2bTenants/{tenantId}/config.rateLimit`): default 100 mensajes/dia/visitante; admin del tenant puede subir/bajar.

**Cross-track**

R18. El widget consume el perfil via la API de Track 1 (a extender con endpoint `GET /api/v1/profile/visitor` que reciba visitor token + tenant id, ver Plan 003 + Plan 004).
R19. El LLM proxy es compartido con Plan 003 y Plan 004 — la abstraccion de provider se define una vez (en Plan 003 probablemente, ya que Plan 003 es el que arranca el shape del proxy).

---

## Key Technical Decisions

**Widget como Web Component, no iframe.** Web Component (`<contextlayer-chat>`) vive en el DOM del sitio host, hereda estilos via CSS custom properties que el B2B customer puede setear, no requiere iframe sandboxing. Iframe fue la alternativa; descartada por: (a) cross-origin del LLM stream requiere proxy adicional, (b) pierde tema del sitio host, (c) no permite que el bot lea contexto de la pagina actual (e.g. el producto que el visitante esta mirando). Trade-off conocido: el widget puede romper estilos del host si los CSS custom properties no estan bien aislados; mitigado con `all: revert-layer` en un shadow boundary interno.

**Visitor token emitido por el B2B customer, no por ContextLayer.** El B2B customer corre su propio auth (cookie de session, login, etc.) y emite un token de corta duracion que ContextLayer acepta como prueba de identidad del visitante. Esto evita que ContextLayer maneje PII del visitante (email, password) y mantiene la responsabilidad de auth donde ya existe. El token es un JWT firmado con la API key del tenant + un HMAC sobre `visitorId` + `expiresAt`. Trade-off: el B2B customer tiene que implementar un endpoint que emita el token; documentado en el onboarding kit.

**Per-tenant namespace en Firestore, no un `tenantId` field global.** Cada tenant tiene su propio sub-tree en Firestore (`b2bTenants/{tenantId}/...`). Esto permite security rules estrictas: las rules de un tenant no pueden leer/escribir data de otro tenant sin un path traversal explicito. La alternativa (un solo collection con `tenantId` field) es fragil — un bug en una query filtra data cross-tenant. Trade-off: queries globales (e.g. "todos los tenants activos") requieren `listCollections` en vez de una query simple.

**System prompt del tenant + perfil del visitante concatenados.** El system prompt del B2B customer define la personalidad y el scope del bot. El perfil del visitante se inserta como un bloque estructurado despues del system prompt. El LLM recibe ambos como contexto. Trade-off: el system prompt largo + perfil largo puede acercarse al context window; mitigado con summarization del perfil (similar al cascade de Track 1, ver Plan 003).

**Sin UI de admin en V1.** El tenant se configura via Firestore console o un script CLI; no hay dashboard web. El B2B customer edita su `b2bTenants/{tenantId}/config` directamente o via `pnpm tsx scripts/tenant-config.ts set <tenantId> <key> <value>`. La UI de admin es un track separado (potencial revenue, deferred).

**Chat history persistida por tenant, no por visitante global.** Un visitante que chatee con dos tenants tiene dos historiales independientes. Esto refleja la realidad: lo que el usuario le dijo al bot de un e-commerce no es relevante para el bot de otro. Trade-off: si el visitante quiere "mi historial de chat con todos mis bots", no existe — eso seria un producto distinto.

**Visitor ID = hash del visitor token, no email.** El visitante se identifica por `hash(visitorToken)` en el namespace del tenant. Esto evita que el email del visitante (PII) termine en logs de Firestore o indices. El link entre `hash(visitorToken)` y el email real vive solo en el backend del B2B customer. Trade-off: si el visitante cambia de token (logout/login), el historial "se pierde" desde la perspectiva del tenant (nuevo hash, nuevo sub-namespace). Es el comportamiento correcto — el B2B customer decidio que esa sesion es otra identidad.

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
│   │   ├── widget-chat.ts          # POST /api/v1/widget/chat (SSE stream del LLM)
│   │   ├── visitor-token.ts        # POST /api/v1/widget/visitor-token (verifica JWT del B2B customer, emite session token)
│   │   └── b2b-profile.ts          # GET /api/v1/widget/profile (perfil del visitante para el LLM context, con scope check)
│   ├── widget/
│   │   ├── mount.ts                # bootstrap del Web Component
│   │   ├── chat-ui.ts              # render del bubble + panel
│   │   ├── stream.ts               # cliente SSE
│   │   └── tokens.ts               # manejo del visitor token (refresh, expiry)
│   ├── b2b/
│   │   ├── tenants.ts              # CRUD de tenants (admin only, no public API)
│   │   ├── tenant-config.ts        # read/validate config per tenant
│   │   ├── visitor-auth.ts         # verify visitor token, derive visitorId
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
    H[HTML del sitio host] -->|script data-tenant=acme| W[widget.js]
    W -->|GET /widget/config?tenant=acme| WC[Widget config + branding]
    W -->|POST /widget/visitor-token| VT[Visitor token issuance]
    VT -->|verify JWT con API key del tenant| B2B_AUTH[Auth del B2B customer]
    B2B_AUTH -->|emite visitorToken + visitorId| VT
    VT -->|response| W
  end

  subgraph "ContextLayer API (Fastify)"
    WC -->|read b2bTenants/acme/config| FS1[(Firestore)]
    VT -->|verify JWT| VT2[Visitor auth check]
    VT2 -->|scope: tenant=acme + visitorId| W

    W -->|GET /widget/profile| BP[b2b-profile route]
    BP -->|verify visitor token| VA[visitor-auth]
    VA -->|get users/{visitorId}/profile/main| FS2[(Firestore Track 1)]
    FS2 -->|profile JSON| BP
    BP -->|profile| W

    W -->|POST /widget/chat (SSE)| CH[widget-chat route]
    CH -->|verify visitor token| VA
    CH -->|fetch tenant config| TC[tenant-config]
    TC -->|read| FS1
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

### U3. Widget config endpoint + visitor token issuance

**Goal:** API endpoints que el widget llama al montar: `GET /api/v1/widget/config?tenant=acme` y `POST /api/v1/widget/visitor-token`.

**Requirements:** R1, R7, R8, R9, R10.

**Dependencies:** U1, U2.

**Files:**
- `src/routes/widget-config.ts`
- `src/routes/visitor-token.ts`
- `src/b2b/visitor-auth.ts`
- `src/middleware/tenant-api-key.ts`

**Approach:** `GET /api/v1/widget/config?tenant=acme` recibe `Authorization: Bearer <apiKey>` en el header, valida la key (lookup por `keyHash`), verifica que el origin del request esta en `allowedOrigins`, y retorna el config del tenant (system prompt, branding, providers, rate limit). `POST /api/v1/widget/visitor-token` recibe `{ tenantId, visitorToken }` donde `visitorToken` es un JWT firmado por el B2B customer con su `apiKey` como secret. El server verifica la firma, extrae `visitorId` y `expiresAt`, y emite un session token propio de ContextLayer (firmado con una key del sistema) que el widget usa para llamadas subsecuentes.

**JWT shape (B2B → ContextLayer):**
```json
{
  "iss": "acme",
  "visitorId": "user_abc123",
  "exp": 1735689600
}
```

Firmado con HMAC-SHA256 usando la `apiKey` del tenant. El endpoint verifica la firma contra la key de ContextLayer (que es el `keyHash` reverso — no, mejor: la key se guarda en claro en el server una vez al emitir, con `keyMaterial` encrypted at rest usando KMS o un secret derivado del `FIREBASE_SERVICE_ACCOUNT`). Trade-off: la API key tiene que vivir en el server en algun formato reversible para verificar HMACs. Mitigacion: encriptar con AES-256-GCM usando una master key del entorno (`WIDGET_API_KEY_ENCRYPTION_KEY`).

**Test scenarios:**
- Request a `/widget/config` sin Authorization → 401
- Request con API key invalida → 401 con `{ error: "invalid_api_key" }`
- Request con API key valida pero origin no en `allowedOrigins` → 403
- Request con API key valida y origin allowed → 200 con config completo
- `/widget/visitor-token` con JWT firmado correctamente → 200 con session token
- JWT con firma invalida → 401
- JWT expirado → 401
- Session token emitido tiene `expiresIn: 86400` (24h)
- Cambiar el `systemPrompt` en `tenant-config.ts` se refleja en el siguiente `/widget/config` request sin redeploy del snippet

**Verification:** Crear tenant `acme` con config conocido; `curl` con API key retorna el config; `curl` con un JWT firmado con la misma key emite session token.

### U4. Widget bundle (Web Component)

**Goal:** El bundle JS que el B2B customer incluye en su sitio. Levanta el Web Component, monta el chat bubble, gestiona el visitor token, abre el panel de chat.

**Requirements:** R1, R2, R5, R6.

**Dependencies:** U3 (los endpoints que consume).

**Files:**
- `public/widget/widget.js`
- `public/widget/widget.css`
- `src/widget/mount.ts`
- `src/widget/chat-ui.ts`
- `src/widget/tokens.ts`
- `src/widget/stream.ts`

**Approach:** Bundle con `esbuild` (anadir a `package.json`), target ES2020, output a `public/widget/widget.js`. Entry point lee el `data-tenant` attribute del `<script>` tag, hace `fetch('/api/v1/widget/config?tenant=...')` con la API key (pasada via data attribute, **NO** — eso la expone en el HTML; alternativa: el B2B customer pone la API key en un `<meta name="contextlayer-api-key">` tag o un `window.contextlayerConfig` global). Trade-off: el approach del data-attribute es simple pero inseguro (cualquiera que vea el HTML ve la key). El approach del meta tag o global es lo que se usa en producto (Intercom, Drift, etc.). Documentado en onboarding.

El Web Component es un `customElements.define('contextlayer-chat', ...)`. Cuando se instancia, llama a los endpoints, lee el branding, monta el bubble (boton circular abajo-derecha por default, posicion configurable via CSS custom property), y al click abre el panel de chat. La sesion se mantiene en `sessionStorage` (no `localStorage` — expira al cerrar tab).

**Test scenarios:**
- Script tag con `data-tenant="acme"` pero sin API key → no monta, loggea error claro en consola
- Widget monta bubble en posicion default (`bottom-right`)
- Click en bubble abre panel de chat con input field
- CSS custom property `--contextlayer-primary` sobreescribe el color del bubble
- Widget en un sitio con CSP estricta que bloquea scripts inline → falla con error claro (no silent fail)
- Widget en mobile viewport (375px) → bubble en bottom-right no choca con el contenido
- Sesion persiste durante navegacion SPA del sitio host (no se pierde al cambiar de ruta)
- Sesion se borra al cerrar tab (verificar `sessionStorage`)
- **SRI:** script tag con `integrity="sha384-..."` y `crossorigin="anonymous"`; hash mismatch → browser rechaza el script con error claro en consola
- **SRI release:** `scripts/release-widget.ts` genera el bundle, calcula SHA-384, lo publica en `docs/widget-snippets.md` con el snippet completo (URL + integrity + crossorigin); falla si el hash de un build previo cambia
- **CSP:** sitio host con CSP estricta que permite solo `'self'` en `script-src` rechaza el widget — documentado en onboarding (el B2B customer debe anadir `cdn.contextlayer.io` a `script-src`)

**Verification:** Incrustar el snippet en una pagina HTML de prueba, abrir en browser, ver el bubble; click → panel de chat; enviar mensaje → ver respuesta streamed.

### U5. Chat route + SSE streaming + LLM proxy integration

**Goal:** `POST /api/v1/widget/chat` recibe el mensaje del visitante, verifica session token, llama al LLM proxy (definido en Plan 003) con system prompt + perfil del visitante + historial de la conversacion, streamea los tokens de vuelta al widget via SSE, persiste la conversacion al final.

**Requirements:** R5, R11, R14, R15, R16, R17.

**Dependencies:** U1, U3, U4, y Plan 003 (LLM Proxy) merged.

**Files:**
- `src/routes/widget-chat.ts`
- `src/b2b/chat-history.ts`

**Approach:** Request body: `{ tenantId, conversationId?, message }`. Server: (1) verifica session token, extrae `visitorId`. (2) Lee `b2bTenants/{tenantId}/config` (system prompt, default provider). (3) Lee perfil del visitante via `GET users/{visitorId}/profile/main` (con Admin SDK, scoped al visitorId del token). (4) Construye messages array: `[{role: 'system', content: systemPrompt + '\n\nUser profile:\n' + JSON.stringify(profile)}, ...conversationHistory, {role: 'user', content: message}]`. (5) Llama LLM proxy con streaming. (6) Pipe tokens al SSE response. (7) Al cerrar el stream, persiste `b2bTenants/{tenantId}/visitors/{visitorId}/conversations/{conversationId}` con messages + tokenCount.

Rate limiting: counter en Firestore (`b2bTenants/{tenantId}/rateLimits/{visitorId}.messagesToday`) con TTL de 24h via `firestore.FieldValue.serverTimestamp() + 86400000`; increment por cada mensaje; reject si > `rateLimit.messagesPerVisitorPerDay`.

**Test scenarios:**
- Request sin session token → 401
- Request con session token valido pero `tenantId` no matchea el token → 403
- Mensaje normal → LLM proxy llamado, tokens streameados, conversacion persistida
- Conversacion existente (conversationId provisto) → historial se incluye en el messages array
- Nueva conversacion (conversationId null) → se crea con ID auto-generado
- Rate limit exceeded → 429 con `Retry-After` header
- Provider falla mid-stream → server emite SSE event `error` y cierra la conexion limpiamente
- Dos requests concurrentes del mismo visitante → procesan en paralelo (no lock global)
- Token counts (input + output) se loggean con `tenantId`, `visitorId`, `provider`

**Verification:** Chat en el widget: enviar 3 mensajes seguidos, ver respuestas streamed; tras cerrar, `firestore.getDoc('b2bTenants/acme/visitors/{vid}/conversations/{cid}')` muestra los 6 mensajes (3 user + 3 assistant).

### U6. B2B profile API (cross-track con Plan 003)

**Goal:** Endpoint `GET /api/v1/widget/profile` que el chat route usa para obtener el perfil del visitante con scope check (visitorId del session token, no del request body).

**Requirements:** R12, R13, R18.

**Dependencies:** U3 (visitor auth), Plan 003 (B2B API patterns).

**Files:**
- `src/routes/b2b-profile.ts`

**Approach:** Recibe session token (Bearer) en el header. Verifica token, extrae `visitorId` y `tenantId`. Query: `firestore.getDoc('users/{visitorId}/profile/main')`. Retorna el profile JSON. **No** persiste el perfil en el namespace del tenant. Si el documento no existe (visitante no importo data en Track 1), retorna `{ profile: null }` y el chat route ajusta el system prompt para no incluir el bloque "User profile".

**Test scenarios:**
- Request con session token valido + visitorId con perfil → 200 con profile JSON
- Request con session token valido + visitorId sin perfil → 200 con `{ profile: null }`
- Request sin session token → 401
- Visitor intenta acceder al perfil de otro visitor (manipulando el token) → 401
- Track 1 delete (`DELETE /api/v1/user/data`) del visitor → siguiente request a esta API retorna `{ profile: null }` (no error)

**Verification:** Visitor A importa data (Track 1), abre widget en sitio B2B, primer chat incluye su perfil en el system prompt; visitor A borra su data en Track 1, segundo chat no incluye perfil.

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
- Plan 003 (consumer app) y Plan 004 (context injection) producen la abstraccion `LLM Proxy` y la API de perfil. Track 2 los consume.
- Firebase project `context-layer-93a65` sigue siendo el unico namespace usado; no se anaden proyectos.
- B2B customer puede emitir un JWT firmado con HMAC-SHA256. Documentado en onboarding kit (no construido en este plan).
- Browsers target: ultimas 2 versiones de Chrome, Firefox, Safari, Edge. IE11 fuera de scope.
- CDN: Cloudflare o equivalente (TBD). El bundle es estatico, no requiere edge compute.
- Web Crypto API disponible en el browser (todos los target lo tienen). Usado para verificar el session token si el widget lo necesita localmente (no es el caso en V1 — el server verifica).
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
