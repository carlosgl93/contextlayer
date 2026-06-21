---
date: 2026-06-16
seq: "003"
type: feat
title: "feat: Consumer chatbot app — B2C web app, hosted-first tier + BYOK opt-in"
origin: docs/brainstorms/2026-06-13-importacion-contexto-ia-requirements.md (A1, R5, R7)
depends_on:
  - docs/plans/2026-06-13-001-feat-importacion-pipeline-plan.md
  - docs/plans/2026-06-16-002-feat-embeddable-widget-plan.md
---

# feat: Consumer chatbot app

## Summary

Web app B2C (standalone, sin presencia del B2B) que reemplaza el uso personal de ChatGPT/Claude/Gemini. El usuario ve su perfil sintetizado de Track 1 inyectado en el system prompt, chatea con el LLM, y persiste sus conversaciones. **Hosted-first model**: por default ContextLayer provee el LLM (no BYOK), con rate limit de 100 msgs/dia y un paywall de top-up transaparente cuando se choca el limite (no subscription). BYOK queda como opt-in en Settings para power users / privacy-conscious. Chain de modelos price/quality-optimized: **MiniMax M3 primary, DeepSeek fallback**. El LLM proxy es compartido cross-track (consumido por Track 2 widget y Track 4 injection).

**Business model:** El B2C user arranca gratis (hosted, 100 msgs/dia). Cuando choca el limite, el modal le ofrece un top-up hasta fin de mes (no subscription, pago unico, tarjeta guardada para futuros top-ups). El mes que viene arranca free de nuevo. Power users con BYOK no nos cuestan tokens. Costo operacional = tokens hosted (chain M3/DeepSeek) + infraestructura del proxy + Stripe fees.

---

## Problem Frame

STRATEGY.md define al B2C user como el que importa su data gratis y se beneficia cuando un sitio integrado ya lo conoce. Track 1 (import) cierra el ciclo de import. Track 2 (widget) cierra el ciclo de delivery B2B. Track 3 (este plan) agrega el producto que el B2C user usa **en su dia a dia** — un reemplazo de ChatGPT que carga automaticamente su contexto de Track 1.

Por que es un track separado, no parte de Track 1: el B2C user que importa su data y luego abre ChatGPT pierde el contexto en la primera sesion. Track 3 es la superficie de uso que mantiene el contexto vivo entre sesiones y entre providers.

Por que multi-provider + BYOK (como opt-in): STRATEGY posiciona a ContextLayer como "red de contexto", no como wrapper de un LLM. Si atamos al user a un provider, rompemos la promesa de portabilidad. BYOK queda como opt-in para que el user mantenga su relacion con el provider si quiere; el hosted-first default usa una cadena portable (MiniMax M3 → DeepSeek).

**Por que hosted-first (no BYOK-only)**: el B2C user es no-tecnico. Pedirle que abra OpenAI, saque una API key, la pegue en ContextLayer, repita con Anthropic, repita con Gemini — el 70% cierra la pestaña antes de terminar. El hosted-first model baja la barrera a cero (un usuario nuevo puede chatear en 30 segundos, sin keys). BYOK queda como opt-in en Settings para los que ya tienen keys o quieren privacidad/unlimited. La cadena MiniMax M3 → DeepSeek da cobertura price/quality sin requerir eleccion del usuario.

---

## Requirements

**App surface (frontend)**

R1. Web app standalone (SPA) hosteada en el mismo Firebase project (`context-layer-93a65`). URL: `app.contextlayer.io` (subdomain de Firebase Hosting).
R2. Auth: Firebase Auth email/password + Google (mismo shape que Track 1; reusa la sesion del import pipeline).
R3. La vista principal es una interfaz de chat estilo ChatGPT (lista de conversaciones a la izquierda, panel activo al centro, input abajo).
R4. Las conversaciones se listan por titulo (auto-generado del primer mensaje, editable) + timestamp de ultima actividad.
R5. Streaming de tokens del LLM (mismo patron que Track 2): el texto aparece incremental, no espera respuesta completa.
R6. La UI soporta Markdown + code blocks con syntax highlighting.
R7. **Mobile first PWA.** El diseno parte del viewport mobile (375px); desktop escala desde ahi. La app es instalable como PWA (manifest.json + service worker basico para offline shell) en V1. Native apps (iOS/Android) son un track separado, deferred. Tests de UI corren con viewport 375px como baseline; desktop se valida adicionalmente.
R8. El perfil sintetizado de Track 1 se muestra en un panel lateral ("My Context") colapsable, con los 4 campos (preferences, facts, intentions, domains) y la opcion de refrescar manualmente.

**Hosted tier (default) + BYOK opt-in**

R9. **Default tier es hosted**: el usuario abre la app y chatea sin configurar nada. ContextLayer provee el LLM via un chain **MiniMax M3 primary → DeepSeek fallback** (price/quality optimized). El usuario no ve el switch de modelos — recibe respuestas y listo.
R10. **Rate limit: 100 mensajes/dia** en hosted tier. Contador en Firestore (`users/{uid}/usage/{YYYY-MM-DD}.messagesCount`). Se resetea a medianoche local del user (calculado desde timezone reportado en profile, default UTC).
R11. **Paywall transaparente al rate limit**: cuando el contador llega a 100, el siguiente request muestra un modal: "Te quedaste sin mensajes hoy. Paga $X para seguir hasta fin de mes." Pago unico via Stripe (Payment Intents one-shot, NO subscription). Tarjeta queda guardada en Stripe Customer object (no en ContextLayer) para futuros top-ups — siguiente vez que choca el limite, modal pre-llenado con "Confirmar pago de $X" (un click).
R12. **El mes que viene arranca free de nuevo**: el rate limit es 100 msgs/dia por dia calendario, no acumulable. Top-ups cubren solo el resto del mes en curso.
R13. **BYOK opt-in en Settings** (no default): un toggle "Use your own API keys" revela un wizard para configurar OpenAI, Anthropic, Google, OpenRouter. Las API keys se almacenan encriptadas client-side (Web Crypto API + una master key derivada de la sesion de Firebase) y nunca llegan al server de ContextLayer en claro. Una vez configurado BYOK, el rate limit hosted no aplica — el user paga directo al provider.
R14. **Chain MiniMax M3 → DeepSeek**: el proxy intenta MiniMax M3 primero. Si M3 responde <10s (latencia target), lo usa. Si timeout, error 5xx, o rate limit del provider → fallback automatico a DeepSeek (con el mismo system prompt + messages). El user no ve el switch. Metadata del fallback se loggea en `users/{uid}/usage/{date}.providerChain = ['minimax', 'deepseek']` para cost analysis.
R15. **Provider chain configurabilidad post-launch**: el chain por default es MiniMax M3 → DeepSeek, pero el `provider-chain.ts` es un modulo que permite cambiar el orden, agregar/quitar providers, o per-user overrides (e.g. "este user solo DeepSeek"). V1 no expone esto al user; V2 si (toggle "Advanced: pick your model chain").
R16. **ContextLayer no loggea contenido** de los mensajes: ni en Firestore, ni en stdout, ni en servicios externos. Solo metadata (timestamp, provider, token counts, latencia, `providerChain`).

**Context injection (el valor central)**

R17. Al iniciar una nueva conversacion, el LLM recibe como system prompt: (a) un system prompt base de ContextLayer, (b) el perfil sintetizado del usuario (leido de `users/{uid}/profile/main` en Track 1), (c) opcionalmente instrucciones custom del usuario (template de system prompt que el user edita).
R18. El perfil se re-lee en cada nueva conversacion (no se cachea). Si el usuario re-importa data en Track 1, las nuevas senales aparecen en la proxima conversacion sin accion manual.
R19. El system prompt custom del usuario es opcional. Default: solo el perfil + el base prompt.
R20. La ventana de contexto del LLM se monitorea: si `systemPrompt + profile + history` excede el context window del provider, las primeras N mensajes del historial se resumen via un LLM call barato (DeepSeek V3 mini o MiniMax M3 mini) y el summary reemplaza a los originales. Mismo patron que el "cascade" del U5 cost model.

**Persistencia y privacidad**

R21. Las conversaciones se persisten en `users/{uid}/chat/{conversationId}` con shape: `{ tier: 'hosted' | 'byok', provider, model, title, messages: [{role, content, timestamp}], createdAt, lastMessageAt, tokenCountIn, tokenCountOut, writebackStatus: 'pending' | 'synced' | 'opted_out' | 'failed' }`. **El chat SI alimenta el perfil de Track 1**: cuando una conversacion termina (o el usuario la marca como completada), el contenido se envia a re-sintesis via el LLM (mismo patron que el extractor de U5 en Track 1, usando el chain hosted o BYOK del user) y los signals extraidos se mergean con `users/{uid}/profile/main` con dedup por `(value, provider)`. Esto permite que el usuario continue conversaciones y/o comience nuevas con contexto acumulado. El usuario puede opt-out por conversacion (`writebackStatus: 'opted_out'`) o global desde Settings.
R22. El usuario puede borrar una conversacion individual o todas sus conversaciones. Borrar una conversacion **ya sincronizada al perfil** no remueve los signals que se extrajeron de ella (esos viven en el perfil). El usuario puede borrar todas las conversaciones y luego pedir re-sintesis del perfil desde el historial crudo importado original (vuelve al estado pre-chat). Borrar todas las conversaciones **no** borra el perfil ni el historial importado de Track 1.
R23. El usuario puede exportar todas sus conversaciones como JSON (data portability — promesa central de STRATEGY).
R24. El "context always fresh" es opt-in: el usuario puede desactivar la inyeccion del perfil por conversacion si quiere chatear sin contexto.

**Payments (hosted tier top-ups)**

R25. **Stripe integration one-shot**: el B2C user puede hacer un top-up de pago unico cuando choca el rate limit. NO es subscription. NO se renueva automaticamente. Cada pago cubre desde el momento del pago hasta fin de mes calendario (o un monto fijo, e.g. $10, lo que sea mayor). Stripe Customer guarda el metodo de pago para que el siguiente top-up sea un click.
R26. **Pricing transparente**: el modal muestra exactamente cuanto cuesta el top-up y cuantos mensajes cubre. Modelo price/quality-optimized: con chain MiniMax M3 → DeepSeek, $10 ≈ 2000-3000 mensajes (calibrar contra uso real despues del primer mes). El pricing se recalibra segun el cost telemetry de U5 + este plan.
R27. **Hosted tier gratis hasta fin de mes siguiente**: el rate limit es 100 msgs/dia por dia calendario, no acumulable. Si el user pago este mes (top-up), sigue con limite "ilimitado" hasta fin de mes en curso. El mes que viene arranca free de nuevo con 100 msgs/dia. Stripe webhook escucha `payment_intent.succeeded` y marca `users/{uid}/usage/{YYYY-MM}.paidThrough = endOfMonth`.

**Cross-track**

R28. El LLM proxy definido en este plan es consumido por Track 2 (widget) y Track 4 (injection). El shape del proxy es la decision arquitectonica central cross-track.
R29. La API de perfil (`GET /api/v1/widget/profile` de Track 2) se generaliza en este plan a `GET /api/v1/me/profile` para que el B2C user pueda leer su propio perfil desde la web app. El endpoint de Track 2 queda como un alias o se unifica.

---

## Key Technical Decisions

**Hosted-first con chain MiniMax M3 → DeepSeek.** El default tier es hosted. MiniMax M3 ya esta integrado en U5 de Track 1, baseURL `https://api.minimax.io/v1`, 1M token context, precio conocido. DeepSeek (V3 o R1) es el fallback por precio/calidad: significativamente mas barato que Claude/GPT, suficiente calidad para chat general. La cadena es automatica: M3 primero, DeepSeek si M3 falla (timeout 10s, 5xx, rate limit). El user no ve el switch. Post-launch la cadena es configurable (provider-chain.ts) pero V1 no expone al user. Trade-off: dependemos de MiniMax uptime. Mitigacion: DeepSeek siempre disponible como fallback + podemos rotar el primary si encontramos un vendor mejor post-launch.

**Rate limit hosted 100 msgs/dia con paywall de top-up, NO subscription.** El modelo de pago es transaparente y contextual: el user choca el limite → modal explica cuanto cuesta el top-up → pago unico via Stripe → user sigue hasta fin de mes. NO es una subscription mensual. NO se renueva automaticamente. El mes que viene arranca free de nuevo. Beneficio para el user: cero compromiso, paga solo cuando lo necesita, no se siente enganchado a un SaaS. Beneficio para nosotros: conversion en el momento exacto de dolor maximo (el user acaba de chocar el limite, esta engaged, va a pagar). Stripe guarda el metodo de pago para reducir friction del segundo top-up. Trade-off: ingresos menos predecibles que subscription, pero el LTV puede ser mayor (sin churn por "no uso" — los que pagan, pagan porque usan, no porque olvidan cancelar).

**BYOK opt-in para power users y privacy-conscious.** El toggle "Use your own API keys" vive en Settings, no es prominente. Las keys se encriptan client-side con Web Crypto API (master key derivada del Firebase ID token, AES-GCM, persistida en localStorage encriptada). Una vez BYOK activo, el rate limit hosted no aplica — el user paga directo al provider. Multi-provider: OpenAI, Anthropic, Google, OpenRouter. Trade-off: el flujo BYOK es friccion para el user que lo activa, pero es opt-in (los que llegan ahi ya estan motivados). Privacy benefit: el contenido de los mensajes no toca nuestros servers (van directo del browser al provider via proxy que forwardea, no almacena).

**LLM proxy como gateway stateless con chain de fallback.** El proxy de ContextLayer es un endpoint Fastify que recibe `{ tier: 'hosted' | 'byok', provider?, encryptedApiKey?, model?, messages, stream: true, maxLatencyMs?: 10000 }`. Para `tier: 'hosted'`, el proxy corre el chain MiniMax M3 → DeepSeek (intenta M3 con timeout 10s, fallback a DeepSeek si falla). Para `tier: 'byok'`, desencripta la API key del user (master key derivada del idToken en el server) y llama al provider configurado. Stream SSE de vuelta, loggea metadata (no contenido, no API key). Trade-off: en tier hosted, ContextLayer ve los mensajes en memoria durante el request. Aceptable: no se loggea, no se persiste, GDPR-compliant via "no almacenamos contenido". En tier BYOK, ContextLayer ve la API key desencriptada en memoria solo durante el request — no se loggea, no se persiste. La alternativa (browser habla directo al provider) evita el proxy pero pierde: (a) rate limiting centralizado para hosted, (b) control de costo hosted, (c) fallback entre providers hosted, (d) punto unico de observabilidad.

**Profile read en cada nueva conversacion, no por mensaje.** El system prompt se construye al inicio de la conversacion con el perfil completo de Track 1. Durante la conversacion, el perfil **no cambia** — los signals del chat se mergean al final (ver KTD de writeback mas abajo), no mid-stream. Esto es eficiente: 1 read de Firestore por conversacion para el prompt, 1 write al final para el writeback. Trade-off: si el usuario re-importa data en Track 1 mid-conversacion, no se refleja en esa conversacion. Aceptable: el usuario abre una nueva conversacion.

**Writeback del chat al perfil: trigger al cierre, opt-out por conversacion, dedup en el merge.** Cuando una conversacion termina (usuario la cierra explicitamente, app detecta >30min de inactividad, o el usuario click "Sync to profile now"), el contenido del user/assistant se envia al extractor LLM (mismo modulo `extraction/minimax.ts` de Track 1, configurado con el chain hosted o BYOK del user). Los signals extraidos se mergean con `users/{uid}/profile/main` usando el mismo dedup por `(value, provider)` que U6 de Track 1. El usuario puede opt-out por conversacion (boton "Don't add this to my profile" en el menu de la conversacion) o global (toggle en Settings: "Sync my chats to my profile" default ON). El campo `writebackStatus` en la conversacion trackea `pending | synced | opted_out | failed`. Trade-off: costo de LLM (1 call por conversacion al cierre) — aceptable: hosted tier ContextLayer subsidia, BYOK tier el user paga. Beneficio: el perfil del usuario crece con cada interaccion, no solo con cada import.

**PWA en V1 con mobile first, no V1.5.** La app es instalable desde el browser (manifest.json + service worker para offline shell + add to home screen prompt) en V1. El diseno parte del viewport mobile (375px) — touch targets >=44px, gestos nativos (swipe back, pull to refresh), no hover-only interactions. Desktop escala desde ahi (sidebar mas ancho, panel chat en grid). Native apps (iOS/Android) son deferred. Trade-off: PWA no tiene push notifications, no tiene acceso a contactos/calendario, no tiene deep linking con otras apps. Aceptable para V1 — son features V2+.

**Chat history separada de Track 1 import.** Las conversaciones del B2C user en este producto viven en `users/{uid}/chat/{conversationId}`. No en `users/{uid}/conversations/{provider_providerId}` (esa es la coleccion de Track 1 para el historial importado). La razon: el chat del B2C user es un stream separado que el user quiere buscar/editar como "mis chats", distinto del "historial que importe". El writeback extrae signals de los chats y los mergea al perfil, pero los mensajes crudos del chat NO se copian a la coleccion de conversaciones importadas.

**Stripe one-shot (no subscription).** Pago unico via Payment Intents. Stripe Customer guarda metodo de pago (no en ContextLayer) para reducir friction del segundo top-up. NO usamos Subscriptions API. NO autorenovacion. El mes que viene el user arranca free de nuevo — el top-up fue solo para "llegar a fin de mes".

**Native app fuera de scope.** V1 es PWA mobile-first (ver KTD de PWA). Native (iOS/Android) es un track separado, deferred a cuando haya retencion que lo justifique.

---

## Output Structure

```
contextlayer/
├── public/                          # Firebase Hosting root
│   ├── index.html                   # SPA entry
│   ├── app.js                       # bundle (Vite o esbuild)
│   └── app.css
├── src/
│   ├── routes/
│   │   ├── chat.ts                  # POST /api/v1/me/chat (proxy + SSE stream; respeta rate limit hosted)
│   │   ├── chat-history.ts          # CRUD de /users/{uid}/chat/...
│   │   ├── chat-writeback.ts        # POST /api/v1/me/chat/{cid}/sync, /opt-out (writeback a Track 1)
│   │   ├── me-profile.ts            # GET /api/v1/me/profile (read del perfil propio, sin scope check)
│   │   ├── me-export.ts             # GET /api/v1/me/export (export completo como JSON)
│   │   ├── me-usage.ts              # GET /api/v1/me/usage (messagesCount, paidThrough, tier)
│   │   ├── payments.ts              # POST /api/v1/me/topup (crea PaymentIntent), webhook /api/v1/stripe/webhook
│   │   └── paywall.ts               # GET /api/v1/me/paywall-status (booleano: choco limite + topup offer)
│   ├── app/                         # frontend code (SPA)
│   │   ├── main.tsx                 # entry point
│   │   ├── auth.tsx                 # Firebase Auth flow
│   │   ├── chat/
│   │   │   ├── ChatList.tsx
│   │   │   ├── ChatPanel.tsx
│   │   │   ├── MessageBubble.tsx
│   │   │   ├── StreamHandler.ts
│   │   │   └── PaywallModal.tsx     # modal que aparece al chocar rate limit (deep link a Stripe Checkout)
│   │   ├── settings/
│   │   │   ├── TierDisplay.tsx      # "Free tier: 100 msgs/dia" + estado de topup
│   │   │   ├── ByokKeys.tsx         # BYOK config (colapsado, opt-in)
│   │   │   ├── SystemPrompt.tsx     # custom system prompt
│   │   │   ├── ContextToggle.tsx    # opt-in/out de inyeccion de perfil
│   │   │   └── WritebackToggle.tsx  # opt-in/out global de chat → profile writeback
│   │   ├── context/
│   │   │   └── ContextPanel.tsx     # panel "My Context" con el perfil
│   │   └── crypto/
│   │       ├── key-manager.ts       # master key derive/encript/decript
│   │       └── provider-keys.ts     # encript/decript de API keys por provider
│   ├── llm/                         # LLM Proxy cross-track
│   │   ├── proxy.ts                 # entry: recibe request, forwardea al provider adapter
│   │   ├── provider-chain.ts        # hosted: chain MiniMax M3 → DeepSeek con fallback
│   │   ├── providers/
│   │   │   ├── minimax.ts           # adapter MiniMax M3 (hosted primary, ya integrado en U5 Track 1)
│   │   │   ├── deepseek.ts          # adapter DeepSeek (hosted fallback)
│   │   │   ├── openai.ts            # adapter OpenAI (BYOK)
│   │   │   ├── anthropic.ts         # adapter Anthropic (BYOK)
│   │   │   ├── google.ts            # adapter Google/Gemini (BYOK)
│   │   │   └── openrouter.ts        # adapter OpenRouter (BYOK)
│   │   ├── streaming.ts             # SSE pipe desde provider hacia browser
│   │   ├── context-window.ts        # monitoring + cascade summarization
│   │   ├── rate-limiter.ts          # counter 100 msgs/dia hosted (Firestore + cache)
│   │   └── no-log.ts                # assertion tests que el proxy no persiste contenido
│   ├── payments/
│   │   ├── stripe.ts                # wrapper del SDK de Stripe (Payment Intents one-shot, NO Subscriptions)
│   │   ├── topup.ts                 # crea PaymentIntent, valida amount, marca paidThrough
│   │   └── webhook.ts               # escucha payment_intent.succeeded → marca paidThrough en Firestore
│   ├── firestore/
│   │   ├── chat-history.ts          # write/read de users/{uid}/chat/...
│   │   ├── chat-writeback.ts        # state machine writeback (pending → synced/opted_out/failed)
│   │   └── usage.ts                 # write/read de users/{uid}/usage/{YYYY-MM-DD}.messagesCount + paidThrough
│   ├── extraction/
│   │   └── chat-writeback.ts        # wrapper del extractor de Track 1 (config hosted o BYOK segun user.tier)
│   └── ...                          # Track 1 modules (reusa)
```

---

## High-Level Technical Design

```mermaid
flowchart TB
  subgraph "Browser (B2C user)"
    UI[SPA: ChatList + ChatPanel + ContextPanel + PaywallModal]
    CRYPTO[Key Manager: BYOK keys encrypted, opcional]
    UI -.->|only if BYOK ON| CRYPTO
    UI -->|stream| SSE[SSE client]
  end

  subgraph "ContextLayer API (Fastify)"
    CHAT[POST /api/v1/me/chat]
    PROF[GET /api/v1/me/profile]
    EXPORT[GET /api/v1/me/export]
    USAGE[GET /api/v1/me/usage]
    PAYWALL[GET /api/v1/me/paywall-status]
    TOPUP[POST /api/v1/me/topup]
    STRIPE_WEBHOOK[POST /api/v1/stripe/webhook]
    PROXY[LLM Proxy + provider-chain]
    RATE[Rate Limiter: 100 msgs/dia hosted]
    CTXWIN[Context Window Monitor + Cascade]

    CHAT -->|verify Firebase ID token| AUTH
    CHAT -->|check rate limit + paidThrough| RATE
    RATE -->|429 if limit hit| PAYWALL
    CHAT -->|tier=byok: decrypt apiKey| DECRYPT[Server-side decrypt masterKey]
    CHAT -->|tier=hosted: skip decrypt| PROXY
    DECRYPT -->|apiKey in memory| PROXY
    PROXY -->|hosted: chain MiniMax → DeepSeek| CHAIN[Provider chain]
    PROXY -->|byok: provider config| ADAPTER[Provider adapter]
    CHAIN -->|MiniMax first| M3[MiniMax M3]
    M3 -.->|timeout/5xx/rate-limit| DS[DeepSeek]
    ADAPTER -->|streaming tokens| CTXWIN
    CTXWIN -->|SSE pipe| CHAT
    CHAT -->|SSE| SSE
    CHAT -->|metadata only: tokens, latency, providerChain| LOG[Telemetry]
    SSE -->|paint| UI

    PROF -->|read users/{uid}/profile/main| FS[(Firestore)]
    PROF -->|profile JSON| UI

    EXPORT -->|read users/{uid}/chat/* + profile| FS
    EXPORT -->|JSON download| UI

    USAGE -->|read users/{uid}/usage/{date}| FS
    USAGE -->|tier + count + paidThrough| UI

    PAYWALL -->|if limit hit: pricing + amount| UI
    UI -->|click Top up| TOPUP
    TOPUP -->|create PaymentIntent| STRIPE[Stripe API]
    STRIPE -->|redirect to Checkout| UI
    STRIPE -->|payment_intent.succeeded| STRIPE_WEBHOOK
    STRIPE_WEBHOOK -->|mark users/{uid}/usage/{YYYY-MM}.paidThrough| FS
  end

  subgraph "External (hosted: ContextLayer paga)"
    M3API[MiniMax M3 API]
    DSAPI[DeepSeek API]
  end

  subgraph "External (BYOK: user paga)"
    OPENAI[OpenAI API]
    ANTHRO[Anthropic API]
    GOOGLE[Google AI API]
    OR[OpenRouter]
  end

  M3 --> M3API
  DS --> DSAPI
  ADAPTER -->|HTTPS| OPENAI
  ADAPTER -->|HTTPS| ANTHRO
  ADAPTER -->|HTTPS| GOOGLE
  ADAPTER -->|HTTPS| OR
```

**LLM Proxy interface (cross-track):**

```typescript
// directional — naming and shape only
interface ProxyRequest {
  tier: 'hosted' | 'byok'
  // hosted: provider chain automatico, no se especifica
  // byok: provider + model explicitos
  provider?: 'openai' | 'anthropic' | 'google' | 'openrouter'  // required if tier=byok
  model?: string                                              // required if tier=byok
  apiKey?: string              // required if tier=byok, desencriptada server-side
  messages: ChatMessage[]
  systemPrompt: string
  stream: true
  maxLatencyMs?: number        // hosted only: timeout para el chain (default 10000)
  maxTokens?: number
  temperature?: number
}

interface ProxyEvent {
  // streaming: uno por token
  type: 'token'
  delta: string
  provider: 'minimax' | 'deepseek' | 'openai' | ...   // quien emitio este token (util para chain)
}
// al cerrar el stream
| { type: 'done', usage: { inputTokens, outputTokens }, providerChain: string[] }
| { type: 'error', code: string, message: string }
```

Cada adapter implementa la misma interfaz hacia el proxy, exponiendo los detalles del provider (headers, request body shape, SSE event format). El proxy no sabe cual provider es — solo llama al adapter. En `tier: 'hosted'`, el `provider-chain.ts` corre la cadena MiniMax M3 → DeepSeek y reporta cual respondio en `ProxyEvent.provider` y `done.providerChain`.

**Firestore schema (anadido al de Track 1):**

```
users/{uid}
  chat/{conversationId}
    provider: string
    model: string
    title: string                       # auto-generated, editable
    messages: [
      { role: 'user' | 'assistant' | 'system', content: string, timestamp: Timestamp }
    ]
    systemPromptOverride: string | null # null = default (base + profile)
    contextInjectionEnabled: boolean    # default true
    writebackStatus: 'pending' | 'synced' | 'opted_out' | 'failed'  # default 'pending'
    writebackLastAttemptAt: Timestamp | null
    writebackError: string | null
    createdAt: Timestamp
    lastMessageAt: Timestamp
    tokenCountIn: number
    tokenCountOut: number
```

---

## Implementation Units

### U1. LLM Proxy core (cross-track foundation)

**Goal:** Modulo `src/llm/proxy.ts` que recibe un `ProxyRequest`, llama al adapter del provider correspondiente, streamea tokens via SSE, y loggea metadata (no contenido).

**Requirements:** R9, R14, R16, R28.

**Dependencies:** Track 1 (Fastify, server foundation).

**Files:**
- `src/llm/proxy.ts`
- `src/llm/streaming.ts`
- `src/llm/no-log.ts`
- `src/llm/providers/openai.ts`
- `src/llm/providers/anthropic.ts`
- `src/llm/providers/google.ts`
- `src/llm/providers/openrouter.ts`

**Approach:** `proxy.ts` exporta una funcion `streamProxy(req: ProxyRequest, onEvent: (e: ProxyEvent) => void): Promise<{usage}>`. Internamente, hace lookup del adapter por `req.provider`, llama `adapter.streamChat(req, onEvent)`. El adapter traduce el request al shape del provider, abre la conexion HTTPS, parsea el SSE del provider, emite `ProxyEvent` por cada token. Al final, retorna usage. **No** hay cache, **no** hay retry automatico (eso es del cliente), **no** hay persistencia.

Adapter pattern: cada adapter implementa `streamChat(req, onEvent): Promise<{usage}>`. Las diferencias entre providers (auth header, request body, SSE format) viven en el adapter. El proxy no las conoce.

**Test scenarios:**
- Request a OpenAI adapter con un mensaje y apiKey mock → emite tokens y done event
- Request a Anthropic adapter → emite tokens con el formato correcto de Anthropic SSE
- Request a OpenRouter adapter con model `anthropic/claude-3.5-sonnet` → forwardea a OpenRouter, recibe respuesta
- Request a Google adapter con un mensaje → emite tokens
- Provider retorna error (401, 429, 500) → adapter emite `error` event con code y message
- `no-log` test: ejecutar 100 requests con contenido marcado (`UNIQUE_STRING_XYZ`), verificar que `UNIQUE_STRING_XYZ` no aparece en ningun log de stdout, Firestore, ni archivo
- `no-log` test: ejecutar 100 requests, verificar que la `apiKey` no aparece en logs
- Streaming funciona: tokens se emiten en orden, no se agrupan al final

**Verification:** `scripts/verify-no-log.ts` envia 100 requests con contenido unico, grep en Firestore + logs retorna 0 matches. Test E2E: el proxy stream un chat real, los tokens llegan al browser en orden.

### U2. Crypto key manager (BYOK client-side)

**Goal:** Modulo frontend que genera la master key, la encripta con PBKDF2 derivado del idToken de Firebase, y encripta/desencripta las API keys de los providers con AES-GCM.

**Requirements:** R13.

**Dependencies:** U1 (para tests E2E).

**Files:**
- `src/app/crypto/key-manager.ts`
- `src/app/crypto/provider-keys.ts`
- `src/app/crypto/key-manager.test.ts`

**Approach:** `key-manager.ts` exporta:
- `deriveMasterKey(idToken: string, salt: Uint8Array): Promise<CryptoKey>` — PBKDF2-SHA256, 100k iteraciones, 32 bytes
- `encryptApiKey(plaintext: string, masterKey: CryptoKey): Promise<{ciphertext, iv}>` — AES-GCM 256
- `decryptApiKey(ciphertext: Uint8Array, iv: Uint8Array, masterKey: CryptoKey): Promise<string>`
- `getOrCreateMasterKey(): Promise<CryptoKey>` — busca en sessionStorage; si no existe, genera random + deriva del idToken + guarda encriptada

`provider-keys.ts` mantiene un map `{provider: {ciphertext, iv}}` en `localStorage`. En cada sesion, lee el map, desencripta con la master key, expone al UI.

**Test scenarios:**
- Generar masterKey con un idToken mock → misma masterKey se regenera con mismo idToken
- Encriptar + desencriptar una API key → recupera el original exacto
- `getOrCreateMasterKey` la primera vez genera y guarda; la segunda vez lee de sessionStorage
- Logout limpia sessionStorage → siguiente login re-deriva la masterKey (puede ser la misma o distinta, no importa — la masterKey encriptada en localStorage sigue valida si se re-deriva con el mismo idToken)
- Si el user cambia de password / re-auth → Firebase emite nuevo idToken → masterKey derivada es distinta → API keys encriptadas se vuelven irrecuperables → user re-ingresa las keys (documentado en UX)
- AES-GCM IV es unico por encriptacion (no se reutiliza)

**Verification:** En la app, ingresar una OpenAI API key, refrescar el browser (no logout), la key sigue ahi; logout + login, la key se pierde (user re-ingresa).

### U3. Settings UI (Provider keys + system prompt + context toggle)

**Goal:** Vista de Settings donde el B2C user configura sus providers, API keys, system prompt custom, y el toggle de context injection.

**Requirements:** R13, R19, R24.

**Dependencies:** U2 (crypto).

**Files:**
- `src/app/settings/ProviderKeys.tsx`
- `src/app/settings/SystemPrompt.tsx`
- `src/app/settings/ContextToggle.tsx`
- `src/app/settings/Settings.test.tsx`

**Approach:** Tres secciones colapsables en `/settings`:

0. **Tier (read-only display):** muestra "Free tier: 100 msgs/dia" o "Paid tier: unlimited until {endOfMonth}". Si user choco el limite, el boton "Top up $X" aparece aqui (deep link al modal de Stripe top-up de U9).
1. **BYOK (colapsado por default, opt-in):** un toggle "Use your own API keys" arriba. Si OFF, esta seccion esta colapsada y no es prominente. Si ON, se expande para mostrar la lista de providers (OpenAI, Anthropic, Google, OpenRouter). Cada uno tiene un input para la API key (password field), un boton "Test" que hace un request pequeno al provider, y un indicador "Connected" / "Invalid key". Default provider selector.

2. **System Prompt:** textarea con el system prompt custom del user. Boton "Reset to default". Preview del prompt final (default + profile + custom) en un panel read-only.

3. **Context Injection:** toggle "Include my ContextLayer profile in conversations" (default ON). Explicacion: "When ON, your imported profile (preferences, facts, intentions, domains) is sent to the AI as context. You can disable per conversation."

**Test scenarios:**
- Settings carga → tier display muestra "Free tier: 100 msgs/dia" (hosted default, no BYOK)
- BYOK toggle OFF → seccion de providers colapsada, no visible
- BYOK toggle ON → seccion se expande, muestra lista de providers
- Ingresar OpenAI API key valida con BYOK ON → "Connected" aparece, llamada de test retorna OK
- Ingresar API key invalida → "Invalid key" aparece, llamada de test retorna error especifico
- Cambiar default BYOK provider → siguiente nueva conversacion usa el nuevo default (solo si BYOK ON; si OFF, ignora)
- Custom system prompt se guarda en Firestore bajo `users/{uid}/settings/systemPrompt`
- Toggle context injection OFF → siguiente nueva conversacion no incluye el perfil en el system prompt
- Preview del prompt final refleja los cambios en tiempo real
- Si user pago top-up este mes → tier display muestra "Paid tier: unlimited until 2026-06-30"

**Verification:** E2E: user hosted-default chatea 5 mensajes, abre settings, ve "Free tier: 100 msgs/dia", BYOK toggle colapsado. Activa BYOK, configura OpenAI, chatea 5 mas mensajes, ve en settings que ya no esta en hosted. Desactiva BYOK, vuelve a hosted.

### U4. Chat list + Chat panel + streaming

**Goal:** UI principal de chat: lista de conversaciones a la izquierda, panel activo al centro, streaming de tokens.

**Requirements:** R3, R4, R5, R6, R7. (R10 enforces hosted rate limit at the proxy level for hosted-tier conversations.)

**Dependencies:** U1 (proxy), U2 (crypto), U3 (settings).

**Files:**
- `src/app/chat/ChatList.tsx`
- `src/app/chat/ChatPanel.tsx`
- `src/app/chat/MessageBubble.tsx`
- `src/app/chat/StreamHandler.ts`
- `src/app/chat/chat.test.tsx`

**Approach:** Layout tipo ChatGPT. Click en una conversacion carga sus mensajes. Click en "+" crea nueva conversacion. El input field en el bottom acepta texto, Enter envia, Shift+Enter nueva linea. Boton "Stop" durante streaming aborta el SSE connection.

Titulo auto-generado: el primer mensaje del user se trunca a 50 chars y se usa como titulo. Editable con click.

Markdown rendering: `react-markdown` con `remark-gfm` para tables/strikethrough, `rehype-highlight` para syntax highlighting. Code blocks con boton "Copy".

**Test scenarios:**
- Lista muestra todas las conversaciones del user, ordenadas por `lastMessageAt` desc
- Click en una conversacion carga sus mensajes
- Nueva conversacion crea doc en Firestore con titulo auto-generado
- Enviar mensaje → SSE connection se abre, tokens aparecen incremental, al final el mensaje se persiste
- Stop durante streaming → connection aborta, mensaje parcial se guarda con flag `truncated: true`
- Code block con syntax highlighting (test: pegar ```python def foo(): pass ``` → render con highlighting)
- Mobile viewport (375px) → lista colapsa a un hamburger menu, panel ocupa full width
- Refrescar el browser mid-conversacion → la conversacion se restaura desde Firestore

**Verification:** E2E: user abre la app, envia un mensaje largo, ve los tokens streameados, refresca, la conversacion esta ahi con todos los mensajes.

### U5. New conversation: profile read + prompt construction

**Goal:** Al crear una nueva conversacion, server lee el perfil del user de Track 1, construye el system prompt (base + profile + custom override), y lo pasa al LLM proxy.

**Requirements:** R10, R17, R18, R19, R20, R29.

**Dependencies:** U1, U4.

**Files:**
- `src/routes/chat.ts` (anadir la logica de prompt construction)
- `src/llm/context-window.ts`
- `src/me-profile.ts`

**Approach:** En `POST /api/v1/me/chat` con `conversationId: null` (nueva conversacion):
1. Verifica Firebase ID token, extrae `uid`.
2. Si `contextInjectionEnabled` (default true), lee `users/{uid}/profile/main`. Si no existe, loggea y continua sin perfil.
3. Construye el system prompt:
   ```
   [Base prompt — ContextLayer system identity, ~200 tokens]
   [User profile — JSON.stringify del profile, ~500-2000 tokens depending on size]
   [Custom override — user-defined system prompt, opcional]
   ```
4. Si `systemPromptOverride` no es null, append al final con un separador claro.
5. Si el total excede el context window del modelo (descontando el room para la conversacion), trunca el profile o aplica cascade summarization (ver U6).
6. Llama LLM proxy con `systemPrompt` y `messages: [{role: 'user', content: message}]`.
7. Stream al browser. Persiste la conversacion con el system prompt usado (para debugging, no se muestra al user).

**Test scenarios:**
- User con perfil completo (4 campos poblados) → system prompt incluye el JSON del perfil
- User sin perfil (no importo en Track 1) → system prompt solo tiene base + custom override
- User con custom override largo + profile largo → ambos se concatenan, total documentado en el log
- Context injection OFF → system prompt solo tiene base + custom override, sin perfil
- Profile leido en nueva conversacion, no en mensajes subsecuentes de la misma conversacion (eficiencia)
- User re-importa data en Track 1 → siguiente nueva conversacion incluye las senales nuevas
- Cascade summarization se activa cuando total > context window → loggea "cascade triggered, summarized N messages"

**Verification:** User con perfil + custom prompt + mensaje corto → el LLM responde con awareness del perfil (pregunta sobre una preferencia listada en el profile). User con context injection OFF → el LLM no tiene awareness del perfil.

### U6. Context window monitor + cascade summarization

**Goal:** Si el system prompt + perfil + historial excede el context window del provider, aplicar cascade summarization (resumir mensajes viejos via un LLM barato).

**Requirements:** R20.

**Dependencies:** U5.

**Files:**
- `src/llm/context-window.ts`
- `src/llm/context-window.test.ts`

**Approach:** Antes de cada llamada al provider, calcular `totalTokens = systemPromptTokens + profileTokens + historyTokens + currentMessageTokens`. Si `totalTokens > modelContextWindow * 0.85` (margen para la response), trigger cascade:
1. Identificar el rango de mensajes a resumir (los mas viejos, manteniendo los ultimos N intactos).
2. Llamar un LLM barato (`gpt-4o-mini` o `claude-3-haiku`) con system prompt "Summarize the following conversation in 200 words, preserving key facts and decisions".
3. Reemplazar el rango con un unico mensaje `{role: 'system', content: '[Summary of earlier conversation]\n' + summary}`.
4. Re-calcular tokens. Si sigue excediendo, repetir con ventana mas chica.

El cascade usa el mismo chain que el chat runtime: si hosted tier → MiniMax M3 → DeepSeek (cualquiera de los dos sirve para summarization, no necesitamos un "cheap" separado). Si BYOK tier → provider default del user. En ambos casos el costo es bajo (summarization de chat largo ≈ 1-3k tokens).

**Test scenarios:**
- Conversacion de 50 mensajes + profile grande → tokens exceden window → cascade se activa, summary reemplaza primeros 30 mensajes
- Conversacion de 10 mensajes + profile chico → tokens bajo window → cascade no se activa
- Cascade falla (provider cheap down) → fallback: truncar primeros N mensajes sin summary, loggear warning
- Summary preserva hechos clave (test: el LLM menciona "user is vegetarian" en su summary si el user lo dijo en mensaje 5)
- Total tokens post-cascade < 85% del context window

**Verification:** Conversacion sintética de 100 mensajes + profile grande → cascade corre, summary generado, siguiente llamada al provider pasa sin error de context window.

### U7. Chat history persistence + export + delete

**Goal:** CRUD de conversaciones: crear (automatico en U5), listar (U4), update titulo, delete individual, delete all, export.

**Requirements:** R22, R23.

**Dependencies:** U4.

**Files:**
- `src/firestore/chat-history.ts`
- `src/routes/chat-history.ts`
- `src/routes/me-export.ts`
- `src/firestore/chat-history.test.ts`

**Approach:** `chat-history.ts` en Firestore: `users/{uid}/chat/{conversationId}` con shape definido en HTD. CRUD operations:
- `createConversation(uid, {provider, model, title, systemPromptUsed, contextInjectionEnabled})` → returns conversationId
- `appendMessage(uid, conversationId, {role, content, timestamp})` → batch write
- `updateTitle(uid, conversationId, title)` → patch
- `deleteConversation(uid, conversationId)` → delete doc
- `deleteAllConversations(uid)` → batch delete
- `listConversations(uid, {limit, cursor})` → query ordered by lastMessageAt desc
- `exportAll(uid)` → query all + return JSON

`/api/v1/me/export` retorna un JSON con:
```json
{
  "exportedAt": "2026-06-16T...",
  "profile": { ... },
  "conversations": [
    { "id": "...", "title": "...", "messages": [...], "createdAt": "...", "provider": "..." }
  ]
}
```

**Test scenarios:**
- Crear conversacion → doc existe en Firestore con los campos correctos
- Append 5 mensajes → array de messages tiene 5 entries
- Update titulo → patch funciona, los demas campos intactos
- Delete individual → doc desaparece, list ya no lo incluye
- Delete all → batch delete completo, list retorna vacio
- Delete all no toca el perfil de Track 1
- Export retorna JSON valido con todas las conversaciones + el perfil
- User A no puede leer/escribir chat de User B (rules de Firestore)

**Verification:** E2E: user crea 3 conversaciones, las lista, edita un titulo, borra una, exporta. El JSON de export contiene 2 conversaciones + el perfil.

### U8. Chat writeback to profile (contamination del perfil)

**Goal:** Cuando una conversacion termina, el contenido se re-sintetiza via LLM y los signals extraidos se mergean con `users/{uid}/profile/main`. Esto permite que el perfil crezca con cada interaccion (no solo con cada import).

**Requirements:** R21 (writeback), R22 (independencia de delete), R24 (opt-in/opt-out).

**Dependencies:** U5 (creacion de conversacion), U1 (LLM proxy de Plan 003), Track 1 U5/U6 (extractor y dedup logic, reusados).

**Files:**
- `src/extraction/chat-writeback.ts` (nuevo, wrapper del extractor de Track 1 con config BYOK)
- `src/routes/chat-writeback.ts` (POST /api/v1/me/chat/{cid}/sync, POST /api/v1/me/chat/{cid}/opt-out)
- `src/firestore/chat-writeback.ts` (state machine: pending → synced/opted_out/failed)
- `src/extraction/chat-writeback.test.ts`

**Approach:** Trigger del writeback (cualquiera de los 3):
1. **User-initiated close:** el user click "End conversation" o un boton equivalente. El frontend dispara `POST /api/v1/me/chat/{cid}/sync`.
2. **Auto-detect:** el server detecta >30min de inactividad en una conversacion (no hay appendMessage en 30min) y dispara el sync automaticamente. Implementado via un cron que corre cada 5min y busca conversaciones con `lastMessageAt < now - 30min AND writebackStatus: 'pending'`.
3. **Manual sync:** el user click "Sync to profile now" desde el menu de la conversacion. `POST /api/v1/me/chat/{cid}/sync` con flag `force: true`.

Server flow en `POST /api/v1/me/chat/{cid}/sync`:
1. Verifica Firebase ID token, extrae uid.
2. Lee la conversacion. Si `writebackStatus` es `opted_out`, retorna 200 sin hacer nada.
3. Construye el texto linearizado: `messages.map(m => `${m.role}: ${m.content}`).join('\n')`. Truncar a 200KB si excede.
4. Llama al extractor LLM (mismo prompt que U5 de Track 1, con `source: "chat:{conversationId}"` en cada signal).
5. Mergea los signals extraidos con `users/{uid}/profile/main` usando el dedup por `(value, provider)` de U6 de Track 1. Los signals del chat tienen `provider: "chat"` (un pseudo-provider para distinguirlos de los importados).
6. Update `writebackStatus: 'synced'`, `lastSyncedAt: now()`.
7. Si el extractor falla (provider down, API key invalida), `writebackStatus: 'failed'`, `lastError: <message>`. Retry automatico: el cron reintenta hasta 3 veces antes de marcar como failed definitivamente.

LLM provider para writeback: si el user tiene BYOK configurado, usa su provider default. Si NO tiene BYOK (hosted tier), usa el chain MiniMax M3 → DeepSeek (mismo que el chat runtime, ContextLayer subsidia). Si ambos fallan, `writebackStatus: 'failed'`, reintentar en el proximo cron run (hasta 3 veces).

**Test scenarios:**
- Conversacion con 5 mensajes termina → writeback corre, signals extraidos aparecen en `users/{uid}/profile/main` con `provider: "chat"`
- Re-sync de la misma conversacion → no duplica signals (dedup por `(value, provider)`)
- Conversacion con opt-out (`writebackStatus: 'opted_out'`) → sync no corre aunque se llame el endpoint
- Provider invalido al momento del sync (BYOK key expirada o chain hosted fail) → `writebackStatus: 'failed'`, no se mergea nada
- Cron auto-detect: conversacion con `lastMessageAt < now - 30min` → trigger sync automatico
- Conversacion >200KB → se trunca a 200KB con `truncated: true` antes de enviar al LLM
- Delete de una conversacion ya sincronizada → signals mergeados permanecen en el perfil (no se borran)
- User con global opt-out (Settings toggle OFF) → todas las conversaciones nuevas se crean con `writebackStatus: 'opted_out'`
- User re-engancha el opt-out global → proximas conversaciones sync; las viejas opted_out quedan opted_out (no retroactive)
- **Costo:** 1 LLM call por conversacion al sync, con tokens acotados por la truncation; el user paga al provider via BYOK

**Verification:** E2E: user configura OpenAI BYOK, abre conversacion, manda 5 mensajes, cierra. Verificar `users/{uid}/profile/main` tiene nuevos signals con `provider: "chat"`, `source: "chat:{conversationId}"`. User abre nueva conversacion, el system prompt incluye los nuevos signals.

### U9. Rate limiter + Stripe top-up + paywall modal

**Goal:** Rate limit de 100 msgs/dia para hosted tier, contador en Firestore, modal de paywall al chocar el limite, Stripe Payment Intents one-shot (NO Subscriptions), webhook que marca `paidThrough` hasta fin de mes.

**Requirements:** R10, R11, R12, R25, R26, R27.

**Dependencies:** U1 (proxy), U4 (chat UI).

**Files:**
- `src/llm/rate-limiter.ts`
- `src/llm/rate-limiter.test.ts`
- `src/payments/stripe.ts`
- `src/payments/topup.ts`
- `src/payments/webhook.ts`
- `src/routes/payments.ts`
- `src/routes/paywall.ts`
- `src/routes/me-usage.ts`
- `src/firestore/usage.ts`
- `src/app/chat/PaywallModal.tsx`

**Approach:**

**Rate limiter (`rate-limiter.ts`):**
- Antes de cada `/api/v1/me/chat` request, check `users/{uid}/usage/{YYYY-MM-DD}.messagesCount` (Firestore counter).
- Si `tier === 'byok'`, skip check.
- Si `tier === 'hosted'`:
  - Lee `users/{uid}/usage/{YYYY-MM}.paidThrough`. Si `now < paidThrough`, skip check (user pago top-up este mes, ilimitado).
  - Si `messagesCount >= 100`, retorna 429 con `paywall-status` header.
  - Si OK, incrementa counter (Firestore increment con cache `node-lru-cache` TTL 10s).

**Paywall modal (`PaywallModal.tsx`):**
- Frontend llama `GET /api/v1/me/paywall-status` cuando recibe 429.
- Response: `{ hit: true, pricing: { amountUsd: 10, approxMessages: 2500, model: 'hosted chain' }, monthRemaining: '2026-06-30' }`.
- Modal muestra: "Te quedaste sin mensajes este mes. $10 te da ≈2500 mensajes hasta fin de mes (30 junio)." Boton "Pagar $10 con tarjeta" (Stripe Checkout).
- Si user ya tiene metodo de pago guardado (Stripe Customer): "Confirmar $10" (1 click).
- Si no: redirect a Stripe Checkout (collect card).

**Stripe top-up (`payments.ts` + `webhook.ts`):**
- `POST /api/v1/me/topup`: verifica Firebase ID token, busca o crea Stripe Customer (metadata.firebaseUid), crea PaymentIntent con `amount: 1000` (cents), `currency: 'usd'`, `customer: cus_xxx`, `metadata: { firebaseUid, type: 'topup' }`. Retorna `{ clientSecret, customerId }`.
- `POST /api/v1/stripe/webhook`: valida signature con `STRIPE_WEBHOOK_SECRET`. En `payment_intent.succeeded`, lee `metadata.firebaseUid`, marca `users/{uid}/usage/{YYYY-MM}.paidThrough = endOfMonthISO`. Idempotency: `PaymentIntent.id` unico, skip si ya procesado.
- NO usa Stripe Subscriptions API. NO crea productos recurrentes. NO plan de subscripcion en Stripe Dashboard.

**Pricing (R26):** Inicial: $10 USD ≈ 2500-3000 hosted messages. Calibrar con cost telemetry real despues del primer mes. El modal muestra el approx honesto basado en el telemetry del mes anterior.

**Test scenarios:**
- User hosted envia 100 mensajes → counter llega a 100 → 101° mensaje retorna 429 con `paywall-status: hit`
- User hosted con `paidThrough` futuro (pago top-up) → counter se ignora, no hay rate limit
- User BYOK → rate limiter no se ejecuta, no hay counter
- Day rollover: counter del 2026-06-19 no se cuenta el 2026-06-20 (nuevo doc, fresh counter)
- `POST /api/v1/me/topup` sin auth → 401
- `POST /api/v1/me/topup` con auth → crea PaymentIntent, retorna clientSecret
- Stripe webhook con signature invalida → 400
- Stripe webhook con `payment_intent.succeeded` → marca `paidThrough` en `users/{uid}/usage/{YYYY-MM}`
- Webhook idempotency: mismo PaymentIntent procesado 2 veces → solo marca 1 vez
- Webhook para user que no existe en Firestore → 404, no crash
- Paywall modal muestra pricing real del telemetry
- User sin Customer object en Stripe → Checkout crea Customer + SetupIntent para guardar metodo
- User con Customer + metodo guardado → modal "Confirmar $10" funciona en 1 click (PaymentIntent off-session)

**Verification:** E2E: hosted user envia 100 mensajes, 101° choca rate limit, ve paywall modal, paga $10 con Stripe test card, modal se cierra, puede seguir chateando. Al finalizar el mes, vuelve a rate limit 100/dia (paidThrough expiro). BYOK user nunca ve el modal.

---

## Scope Boundaries

**Deferred for later**

- Native apps (iOS / Android). V1 es PWA instalable + responsive.
- Voice / TTS / STT. Texto only.
- Imagen input (GPT-4V, Claude vision). Texto only en V1.
- Imagen output (DALL-E, Midjourney via API). Texto only.
- Function calling / tool use por el LLM. El chat es conversacional puro.
- Sharing de conversaciones (URL publica). Privado por default.
- Collaboration (multi-user en la misma conversacion).
- Subscription recurrente en Stripe. V1 es one-shot top-up only. Si despues conviene subscription, V2 introduce Stripe Subscriptions + planes mensuales.
- Per-provider chain configurability expuesta al user (V2: toggle "Advanced: pick your model chain"). V1 el chain es fijo MiniMax M3 → DeepSeek.

**Outside this product's identity**

- Este producto no es un agente autonomo. No ejecuta acciones, no navega la web, no llama APIs externas. Es chat.
- No es un marketplace de prompts ni un compartidor de system prompts. Los prompts del user son privados.
- No es un editor de documentos / notebooks (no hay "Projects" al estilo Claude Projects). Es chat.

**Deferred to Follow-Up Work**

- Track 4 (context injection) consume el LLM proxy de este plan via una variante "no streaming, no UI, solo API": la B2B API recibe un system prompt + el perfil y retorna la response completa.
- Track 2 (widget) consume el LLM proxy via la variante "streaming + widget UI".
- El sistema de "BYOK para B2B customers" (donde el B2B customer paga al provider, no el B2C user) es un track separado si el modelo de negocio lo requiere.

---

## Dependencies / Assumptions

- Track 1 cerrado. `users/{uid}/profile/main` existe y es leible.
- Track 2 produce el `LLM Proxy` consumible (o este plan lo define — coordinacion en la implementacion). Mi recomendacion: Plan 003 (este) define el proxy porque es el que arranca el shape. Plan 002 consume.
- Firebase project `context-layer-93a65`. Hosting + Auth + Firestore.
- Stripe account en produccion (test mode para dev), `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` configurados.
- Browsers target: ultimas 2 versiones de Chrome, Firefox, Safari, Edge. Web Crypto API + ReadableStream required.
- El hosted tier default significa que el chat funciona out-of-the-box sin configuracion. Si el user quiere BYOK, va a `/settings`, activa el toggle, y configura. Si no, hosted.
- Los providers (OpenAI, Anthropic, Google, OpenRouter, MiniMax, DeepSeek) mantienen su API estable. Cambios breaking requieren actualizar el adapter correspondiente.
- El "no loggeo contenido" es un compromiso de producto, no solo tecnico. Es testeable (ver U1) pero requiere disciplina del equipo para no agregar logging accidental. Code review checklist obligatorio: cualquier cambio al path del proxy verifica que no se agrego logging de contenido.
- PWA (installable, offline basico) en V1 (no V1.5). Native apps (iOS/Android) deferred.

---

## Open Questions

**OQ-C1.** ¿Standalone web app o tambien native? Resuelto 2026-06-16: **web app + PWA mobile first en V1**. Native (iOS/Android) deferred. Reflejado en R7 (rewrite) y en el KTD "PWA en V1 con mobile first".

**OQ-C2.** [RESUELTO 2026-06-20 → hosted-first con chain MiniMax M3 → DeepSeek, BYOK opt-in, top-up via Stripe al rate limit] ¿BYOK puro o tambien ContextLayer-subsidized plan con un provider default? El usuario rechazo BYOK puro por la friccion para usuarios no-tecnicos ("B2C BYOK es mucha resistencia"). Resolucion: hosted-first default (ContextLayer subsidia, 100 msgs/dia gratis), BYOK queda como opt-in en Settings, paywall transaparente al rate limit via Stripe top-up (no subscription). Chain MiniMax M3 → DeepSeek da cobertura price/quality sin requerir eleccion del user. Reflejado en R9-R16 (rewrite), R25-R27 (nuevo), KTDs "Hosted-first con chain MiniMax M3 → DeepSeek", "Rate limit hosted 100 msgs/dia con paywall de top-up, NO subscription", "BYOK opt-in para power users y privacy-conscious", y "Stripe one-shot (no subscription)".

**OQ-C3.** ¿El chat contamina el perfil de Track 1? Resuelto 2026-06-16: **si**. El chat del B2C user en su propia app SI alimenta el perfil de Track 1 via el writeback flow (U8). El usuario decidio que el chat contiene informacion util que debe persistir — "le permite continuar conversaciones y/o comenzar nuevas" con el contexto acumulado. Opt-out por conversacion (`writebackStatus: 'opted_out'`) o global (Settings toggle). Reflejado en R21 (rewrite), el KTD "Writeback del chat al perfil", y la nueva U8. (Nota: la contaminacion inversa — el chat del B2B customer en su widget — NO aplica. Ver Plan 002 OQ-W2 resuelto.)

**OQ-C4.** ¿Que providers se soportan V1? Mi default: hosted tier = MiniMax M3 + DeepSeek (chain automatico, user no elige). BYOK tier = OpenAI, Anthropic, Google, OpenRouter. Mistral, Cohere, etc. son V2. Resoluble en planning.

**OQ-C5.** ¿Como se maneja la cancelacion de un streaming request? Server-side: el SSE connection se cierra. Provider-side: el adapter intenta enviar un "abort" signal (no todos los providers lo soportan — OpenAI si, Anthropic si, Google parcial). Trade-off: si el provider no soporta abort, el request sigue corriendo en el provider y se cobra. Mitigacion: rate limit por usuario, no por request. Resoluble durante U1.

**OQ-C6.** [RESUELTO 2026-06-20 → si, chain MiniMax M3 → DeepSeek] ¿El LLM proxy deberia tener un fallback automatico entre providers? Si el provider configurado por el user falla, fallback a otro? El usuario decidio que si — el chain MiniMax M3 primary → DeepSeek fallback (timeout 10s, 5xx, rate limit) es exactamente eso. El user no ve el switch. Justificacion: hosted tier no puede mostrar errores al usuario, tiene que responder. Resoluble durante U1.

**OQ-C7.** ¿Donde se sirve la app? Firebase Hosting o Vercel? Mi default: Firebase Hosting (consolidacion con Track 1 y Track 2). Resoluble en planning.

**OQ-C8.** ¿El export de conversaciones incluye el system prompt usado? Mi default: si, es metadata util para que el user entienda por que el bot respondio lo que respondio. Es el "show your work" del chat.

**OQ-C9.** ¿Soporte para compartir conversaciones via URL? Mi default: no V1 (privado por default). Sharing es V2 con su propio producto (link publico + access controls).

---

## Sources & Research

- Track 1: `docs/plans/2026-06-13-001-feat-importacion-pipeline-plan.md`
- Track 2: `docs/plans/2026-06-16-002-feat-embeddable-widget-plan.md` (consume el LLM Proxy de este plan)
- STRATEGY.md: B2C user es gratis, contexto siempre fresco, multi-provider para portabilidad
- Web Crypto API: `crypto.subtle` con PBKDF2 + AES-GCM. Soporte universal en browsers modernos.
- BYOK pattern: Linear, Raycast, GitHub Copilot, otros. El patron estandar es encriptar client-side, server solo forwardea.
- OpenRouter: aggregator de OpenAI/Anthropic/Google/Meta/etc. con una sola API key. Documentacion: `https://openrouter.ai/docs`.
- Context window cascade summarization: patron establecido en agentes y chatbots largos (Claude Projects, ChatGPT con memory, etc.).
- No-log compliance: el proxy no loggea contenido. Testeable con strings unicos y grep. Compromiso de producto, no solo tecnico.
- Firebase Hosting: static + dynamic con Cloud Functions. Reusa el proyecto Firebase existente.

---

## Resolved Decisions

**2026-06-16 — OQ-C1 (web vs native).** V1 es PWA mobile-first. Native (iOS/Android) deferred. Reflejado en R7 (rewrite) y en el KTD "PWA en V1 con mobile first". Diseno parte del viewport 375px, PWA instalable desde V1, no V1.5.

**2026-06-16 — OQ-C3 (chat contamination del perfil).** El chat SI alimenta el perfil de Track 1 via writeback al cierre de la conversacion. Reflejado en R21 (rewrite), nuevo KTD "Writeback del chat al perfil", y nueva U8 "Chat writeback to profile". Opt-out por conversacion o global. El usuario valoro esto explicitamente: "le permite continuar conversaciones y/o comenzar nuevas" — el perfil crece con cada interaccion, no solo con cada import.

**Inversion explicita de default:** OQ-C3 estaba como "mi default: no". La resolucion del usuario lo flippea a "si". El cuerpo del plan (R21, KTDs) se reescribio para reflejar la nueva decision. No hay ambiguedad residual.

**2026-06-20 — OQ-C2 (BYOK puro vs ContextLayer-subsidized).** El plan original proponia BYOK puro (V1) con la opcion de V1.5 "ContextLayer credits". El usuario rechazo BYOK puro: "B2C BYOK es mucha resistencia". Resolucion: hosted-first default con chain MiniMax M3 → DeepSeek (price/quality optimized), 100 msgs/dia rate limit, paywall transaparente al limite via Stripe top-up one-shot (NO subscription). BYOK queda como opt-in en Settings para power users / privacy-conscious. Trade-off: ContextLayer subsidia el hosted tier (costo: Scenario 1-3 del U5 cost model ≈ $0.07-1.01 por import, pero el chat runtime es otro numero, depende de msgs/dia). Conversion en el momento exacto de dolor maximo. Reflejado en: R9-R16 (rewrite, hosted-first + BYOK opt-in), R25-R27 (nuevo, payments), KTDs "Hosted-first con chain MiniMax M3 → DeepSeek" + "Rate limit hosted 100 msgs/dia con paywall de top-up" + "BYOK opt-in para power users" + "Stripe one-shot (no subscription)", nueva U9 "Rate limiter + Stripe top-up + paywall modal", mermaid HTD actualizado, Output Structure actualizado con `payments/`, `usage.ts`, `PaywallModal.tsx`, `ByokKeys.tsx`, nuevos providers `minimax.ts` + `deepseek.ts`, `provider-chain.ts`, `rate-limiter.ts`.

**2026-06-20 — OQ-C6 (auto-fallback entre providers).** El plan original decia "no, devolver error al user". El usuario lo flippeo: "si, chain MiniMax M3 → DeepSeek". El hosted tier no puede mostrar errores al usuario (UX mala para no-tecnicos), tiene que responder. Chain automatico con timeout 10s, fallback transparente. Reflejado en R14 (chain explicito) y KTD "Hosted-first con chain MiniMax M3 → DeepSeek". `provider-chain.ts` es el modulo que V2 expone al user como "Advanced: pick your model chain".
