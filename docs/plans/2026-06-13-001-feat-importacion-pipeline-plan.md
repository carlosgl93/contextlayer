---
date: 2026-06-13
seq: "001"
type: feat
title: "feat: Importacion pipeline — ZIP upload, provider detection, LLM extraction, Firestore persistence"
origin: docs/brainstorms/2026-06-13-importacion-contexto-ia-requirements.md
---

# feat: Importacion pipeline

## Summary

API Fastify/TypeScript que acepta un ZIP de exportacion de Claude o ChatGPT, detecta el proveedor automaticamente, parsea las conversaciones, las envia en batches a MiniMax M3 para extraer senales de contexto estructuradas, y persiste historial crudo + perfil sintetizado en Firestore. Firebase Auth (email/password + Google) maneja la identidad del usuario. Incluye controles de privacidad (delete granular por proveedor, revocacion de acceso por sitio como stub).

**Business model:** B2C users importan gratis — su data es el producto (perfil de contexto agregado que alimenta la red). B2B customers son los que pagan (Track 3, deferred). El cost model del Appendix modela **cost-to-serve por import** (cuanto nos cuesta procesar la data de un usuario B2C), no pricing de B2C. El cost preview en U2 fase 1 es para que el usuario B2C vea cuanto cuesta su import antes de confirmar, sin que eso implique un cobro.

---

## Problem Frame

Track 1 es el punto de entrada de ContextLayer: sin datos del usuario no hay red de contexto para compartir. El milestone del PoC es que el fundador pueda importar sus propias conversaciones de Claude y leer un perfil estructurado via la API. Este plan construye ese pipeline completo.

---

## Requirements

Los requirements vienen del documento origen (`docs/brainstorms/2026-06-13-importacion-contexto-ia-requirements.md`). Los que este plan satisface:

- R1: Aceptar ZIP de Claude y parsearlo correctamente.
- R2: Aceptar `conversations.json` de ChatGPT.
- R3: Detectar el proveedor automaticamente desde la estructura del ZIP.
- R4: Notificar error claro en formato no reconocido o ZIP corrupto.
- R5: Extraer preferencias, hechos personales, intenciones activas y dominios de interes.
- R6: Perfil JSON con atribucion de proveedor en cada campo.
- R7: Informar al usuario que MiniMax M3 procesara sus datos antes de procesar; requiere confirmacion.
- R8: Persistir historial crudo organizado por usuario y proveedor.
- R9: Persistir perfil sintetizado como entidad separada.
- R10: Buscar y filtrar conversaciones por proveedor y fecha.
- R11-R13: Delete granular (todo, solo perfil, o por proveedor).
- R14-R15: Revocar y listar accesos de sitios integrados (stub).

Deferred (Track 3): R16-R17 (acceso B2B al perfil).

---

## Key Technical Decisions

**Firebase stack para el PoC.** Firebase Auth maneja email/password y Google Sign-In, eliminando infraestructura JWT propia. Firestore almacena conversaciones y perfil: schema-flexible, sin servidor que provisionar. Firebase Admin SDK corre en Fastify para verificar tokens y escribir datos. (see origin: docs/brainstorms/2026-06-13-importacion-contexto-ia-requirements.md)

**OpenAI SDK apuntado a MiniMax M3.** MiniMax M3 expone una API OpenAI-compatible en `https://api.minimax.io/v1`. Usar el package `openai` con `baseURL` personalizado evita un cliente HTTP propio y hace la capa LLM intercambiable. El `sk-cp-` del API key puede indicar un proxy; si `api.minimax.io` falla, probar `https://www.minimax-api.com/v1`.

**Batches de 20 conversaciones por call.** Con 1M tokens de contexto no hay limite tecnico, pero batching a 20 controla el costo por importacion. Parametro ajustable en U5.

**Deteccion de proveedor por estructura JSON.** Claude tiene `chat_messages[]`; ChatGPT tiene `mapping: {}`. Chequear la presencia de `mapping` en el primer objeto del array es suficiente — no se necesita analisis de nombre de archivo.

**Raw conversations como texto linearizado.** Mensajes guardados como `role: content\n` (una linea por mensaje) evita la complejidad de subcolecciones en Firestore para el PoC. Limite: truncar a 800KB con flag `truncated: true` para outliers extremos.

**Confirmacion de dos fases en el upload.** Primer request detecta el proveedor y retorna metadata. Segundo request con `confirmed: true` dispara el procesamiento. Satisface R7 sin un flujo de UI complejo.

---

## Output Structure

```
contextlayer/
├── src/
│   ├── index.ts                     # Fastify server entry point
│   ├── plugins/
│   │   └── firebase.ts              # Firebase Admin SDK init
│   ├── middleware/
│   │   └── auth.ts                  # Firebase token verification hook
│   ├── routes/
│   │   ├── import.ts                # POST /api/v1/import/upload
│   │   ├── conversations.ts         # GET /api/v1/user/conversations
│   │   └── privacy.ts               # DELETE routes + site access
│   ├── parsers/
│   │   ├── detect.ts                # Provider detection
│   │   ├── claude.ts                # Claude ZIP parser
│   │   └── chatgpt.ts               # ChatGPT ZIP parser
│   ├── extraction/
│   │   └── minimax.ts               # MiniMax M3 extraction pipeline
│   ├── firestore/
│   │   ├── conversations.ts         # Conversation write/read
│   │   ├── profile.ts               # Profile write/read/merge
│   │   └── access.ts                # Site access records
│   └── types.ts                     # Shared TypeScript interfaces
├── .env
├── .env.example
├── .gitignore
├── package.json
└── tsconfig.json
```

---

## High-Level Technical Design

```mermaid
flowchart TB
  A["POST /api/v1/import/upload\n(multipart ZIP)"] --> B["Auth middleware\nverify Firebase token"]
  B --> C["Unzip in memory\n(max 50MB)"]
  C --> D{"Detect provider\nchat_messages vs mapping"}
  D -->|"confirmed: false"| E["Return provider + metadata\n202 — awaiting confirmation"]
  D -->|"confirmed: true + claude"| F["Claude parser\nconversations.json"]
  D -->|"confirmed: true + chatgpt"| G["ChatGPT parser\nlinearize tree"]
  F --> H["Batch conversations\n20 per batch"]
  G --> H
  H --> I["MiniMax M3\nextraction call per batch"]
  I --> J["Merge signals\nwith provider attribution"]
  J --> K["Firestore write\nconversations per provider"]
  J --> L["Firestore write\nprofile upsert merge"]
  K --> M["200 OK\nimport summary"]
  L --> M
```

**Firestore schema:**

```
users/{uid}
  conversations/{providerId_convId}
    provider: "claude" | "chatgpt"
    providerId: string
    title: string
    date: Timestamp
    messageCount: number
    rawText: string
    importedAt: Timestamp
    truncated: boolean

  profile/main
    preferences:       [{value, provider, source}]
    personalFacts:     [{value, provider, source}]
    activeIntentions:  [{value, provider, source}]
    domainsOfInterest: [{value, provider, source}]
    updatedAt: Timestamp

  siteAccess/{siteId}
    grantedAt: Timestamp
    active: boolean
```

---

## Implementation Units

### U1. Project scaffolding and Firebase init

**Goal:** Fastify server operativo con Firebase Admin SDK, middleware de auth, y configuracion de entorno.

**Requirements:** Prerequisito de todas las unidades.

**Dependencies:** None.

**Files:**
- `package.json`
- `tsconfig.json`
- `src/index.ts`
- `src/plugins/firebase.ts`
- `src/middleware/auth.ts`
- `src/types.ts`

**Approach:** Fastify con TypeScript y plugins: `@fastify/multipart` para uploads, `@fastify/cors` para desarrollo local. Firebase Admin SDK inicializado desde `FIREBASE_SERVICE_ACCOUNT` (JSON en base64 como env var) o desde archivo de credenciales en desarrollo. El hook `authenticate` extrae el Bearer token del header `Authorization`, llama a `admin.auth().verifyIdToken()`, y adjunta `{ uid, email }` al request. Fallos de verificacion retornan 401.

Tipos compartidos en `src/types.ts`:

```typescript
// directional — naming and shape only, not final implementation
interface ConversationRecord {
  provider: 'claude' | 'chatgpt'
  providerId: string
  title: string
  date: Date
  messageCount: number
  rawText: string
  truncated: boolean
}

interface ExtractionSignal {
  value: string
  provider: string
  source: string  // conversation title
}

interface ExtractionResult {
  preferences: ExtractionSignal[]
  personalFacts: ExtractionSignal[]
  activeIntentions: ExtractionSignal[]
  domainsOfInterest: ExtractionSignal[]
}
```

**Test scenarios:**
- Request sin header `Authorization` retorna 401
- Request con token Firebase expirado retorna 401
- Request con token valido adjunta `uid` y `email` al request y continua
- Servidor inicia sin errores con configuracion valida de Firebase
- Falta de `MINIMAX_API_KEY` en startup loggea error claro (validacion al inicio)
- Health check `GET /health` retorna 200 sin autenticacion

**Verification:** `pnpm dev` inicia sin errores; `curl /health` retorna 200; request sin token a ruta protegida retorna 401.

---

### U2. ZIP upload endpoint y deteccion de proveedor

**Goal:** Aceptar upload de ZIP, validarlo, detectar el proveedor, y orquestar el pipeline de dos fases.

**Requirements:** R3, R4, R7.

**Dependencies:** U1.

**Files:**
- `src/routes/import.ts`
- `src/parsers/detect.ts`

**Approach:** `POST /api/v1/import/upload` acepta `multipart/form-data` con campo `file` (ZIP) y campo opcional `confirmed` (boolean string). Limite de 50MB. Unzip en memoria con `unzipper`; buscar `conversations.json` dentro del ZIP. Parsear el JSON y leer el primer objeto: si tiene clave `mapping` → `chatgpt`; si tiene `chat_messages` → `claude`; sino → 400 `unknown_provider`.

**Fase 1** (`confirmed` ausente o `"false"`): retornar un objeto de pre-flight con costo estimado. La estructura es multi-provider-ready aunque hoy U2 acepte un solo archivo:

```json
{
  "providers": [
    { "provider": "claude", "conversationCount": 208, "estimatedTokens": 475000, "estimatedCostUsd": "0.17-0.36" }
  ],
  "total": {
    "providers": 1,
    "conversationCount": 208,
    "estimatedTokens": 475000,
    "estimatedCostUsd": "0.17-0.36"
  },
  "confirmed": false
}
```

Los `estimatedCostUsd` salen del modelo de costos del Appendix (4 chars/token, $0.30-0.70/M input). **Es cost-to-serve, no un cobro al usuario B2C** — el cliente muestra el disclaimer de MiniMax + el costo estimado como transparencia ("este import le costara a ContextLayer ~$0.50 procesar") y re-envia con `confirmed: "true"`. El label del campo en la respuesta debe dejar esto explicito en el cliente. **Multi-file upload (varios `files: [...]` en una sola request) se agrega en U2.1.**

**Fase 2** (`confirmed: "true"`): delegar a parser (U3 o U4), extraction (U5) y persistencia (U6). Retornar la misma forma multi-file que fase 1, con `confirmed: true` y `importId` + `extraction` por provider en `providers[]`:

```json
{
  "providers": [
    { "provider": "claude", "conversationCount": 208, "estimatedTokens": 475000, "estimatedCostUsd": "0.14-0.33", "importId": "imp_<ts>_<uid6>_claude", "extraction": { "preferences": [...], "personalFacts": [...], "activeIntentions": [...], "domainsOfInterest": [...] } }
  ],
  "total": { "providers": 1, "conversationCount": 208, "estimatedTokens": 475000, "estimatedCostUsd": "0.14-0.33" },
  "confirmed": true
}
```

**Test scenarios:**
- ZIP de Claude con `confirmed: false` retorna `providers: [{ provider: "claude", conversationCount, estimatedTokens, estimatedCostUsd }]`, `total.providers: 1`, `confirmed: false`
- ZIP de ChatGPT con `confirmed: false` retorna `providers: [{ provider: "chatgpt", ... }]`
- ZIP con estructura no reconocida retorna 400 con `error: "unknown_provider"`
- ZIP corrupto (no es ZIP valido) retorna 400 con mensaje claro
- Campo `file` no es un archivo ZIP (ej: texto plano) retorna 400
- Archivo mayor a 50MB retorna 413
- `confirmed: "true"` con proveedor no reconocido retorna 400 (no procesa)
- ZIP valido sin `conversations.json` dentro retorna 400 con `error: "missing_conversations_file"`
- Cost estimate en fase 1 esta dentro de ±20% del modelo del Appendix para una importacion conocida del fundador (208 convos Claude = 475K tokens)

**Verification:** Upload del ZIP de Claude del fundador en fase 1 retorna `provider: "claude"` con el conteo de conversaciones + un `estimatedCostUsd` dentro del rango esperado.

---

### U2.1. Multi-file upload + cost preview agregado

**Goal:** Permitir que el usuario suba uno o varios ZIPs (uno por proveedor) en una sola request, y retornar el costo estimado agregado para que vea el total antes de confirmar.

**Requirements:** R7 (transparencia de costo en el disclaimer), R3 (deteccion por ZIP), R4 (manejo de errores por archivo).

**Dependencies:** U2 (la fase 1 y 2 single-file ya funcionan).

**Files:**
- `src/routes/import.ts`
- `src/parsers/detect.ts` (sin cambios funcionales; cada ZIP se detecta independientemente)

**Approach:** extender el handler multipart para aceptar un campo `files` (array) ademas del `file` legacy. Cada archivo se procesa independientemente: unzip, detectar proveedor, parsear `conversations.json`, contar conversaciones. La respuesta de fase 1 agrega los resultados en un unico objeto `providers[]` con un `total` sumado. La fase 2 procesa cada archivo secuencialmente (un batch de LLM calls por archivo, todos en la misma request). Limite agregado: 50MB total entre todos los archivos.

Trade-off explicito: alternativa era single-file-only con cost preview parcial (cliente agrega los costos entre requests). Multi-file es la opcion correcta para el producto — el usuario que importa Claude + ChatGPT + Gemini no deberia tener que aceptar 3 disclaimers separados.

**Test scenarios:**
- Request con `files: [claude.zip, chatgpt.zip]` en fase 1 retorna `providers: [{provider: "claude", ...}, {provider: "chatgpt", ...}]`, `total.providers: 2`, `total.estimatedCostUsd` = suma de los dos
- Request con un solo archivo usando el campo `files: [claude.zip]` retorna la misma forma que el `file` legacy (back-compat)
- Request con 3 archivos donde uno es corrupto retorna 400 con detalle de cual archivo fallo; los archivos validos se reportan en `providers[]` con sus conteos parciales
- Suma de tamaños de archivos > 50MB retorna 413 antes de parsear
- Fase 2 con 2 archivos ejecuta el LLM extraction por cada uno y persiste conversaciones de ambos bajo el mismo uid

**Verification:** Subir el ZIP del fundador (Claude) y un export sintetico de ChatGPT en una sola request retorna el `total.estimatedCostUsd` agregado y, tras `confirmed: true`, las conversaciones de ambos proveedores aparecen en `GET /conversations?provider=claude` y `?provider=chatgpt`.

---

### U3. Parser de Claude

**Goal:** Convertir `conversations.json` de Claude en un array de `ConversationRecord`.

**Requirements:** R1.

**Dependencies:** U2.

**Files:**
- `src/parsers/claude.ts`

**Approach:** Aceptar el array JSON parseado. Por cada conversacion: extraer `uuid`, `name` (titulo), `created_at` (ISO string → Date). Recorrer `chat_messages`: para cada mensaje, determinar `role` (`"human"` → `"user"`, `"assistant"` → `"assistant"`). Extraer texto: preferir el campo `text` del mensaje; si ausente, buscar el primer item en `content[]` con `type: "text"` y usar su `text`. Ignorar mensajes con `type: "tool_use"`, `type: "tool_result"`, `type: "thinking"`. Concatenar como `${role}: ${text}\n`. Si `rawText` supera 800KB, truncar y setear `truncated: true`.

**Test scenarios:**
- Conversacion con turns human/assistant produce rawText con lineas `user: ...` y `assistant: ...` en orden
- `sender: "human"` mapea a `role: "user"` en rawText
- Mensaje con solo `content[]` (sin `text` top-level) extrae texto del primer bloque `type: "text"`
- Mensajes con `type: "tool_use"` son omitidos del rawText
- `created_at` ISO-8601 con timezone parsea a Date correcta
- Conversacion con `chat_messages` vacio produce `messageCount: 0` y `rawText: ""`
- rawText de 900KB se trunca a 800KB con `truncated: true`
- Array de 0 conversaciones retorna array vacio sin error

**Verification:** Parser produce `ConversationRecord[]` correcto con el ZIP real del fundador; spot-check manual de `rawText` de una conversacion conocida.

---

### U4. Parser de ChatGPT

**Goal:** Convertir `conversations.json` de ChatGPT en un array de `ConversationRecord` mediante linearizacion del arbol.

**Requirements:** R2.

**Dependencies:** U2.

**Files:**
- `src/parsers/chatgpt.ts`

**Approach:** Por cada conversacion: extraer `id` (o `conversation_id`), `title`, `create_time` (Unix float × 1000 → Date). Linearizar el arbol: caminar desde `current_node` hacia atras por `parent` links, acumular mensajes en orden inverso. Incluir solo nodos cuyo `message` no es null, `author.role` es `"user"` o `"assistant"`, y `weight >= 1`. Extraer texto de `content.parts` donde los items son strings (ignorar image pointers con `asset_pointer`). Concatenar como `${role}: ${text}\n`. Regla de truncacion identica a U3.

**Technical design (directional):**
```
function linearize(conv):
  msgs = []
  nodeId = conv.current_node
  while nodeId exists in mapping:
    node = conv.mapping[nodeId]
    if node.message and role in ["user","assistant"] and weight >= 1:
      msgs.unshift(extractText(node.message))
    nodeId = node.parent ?? null
  return msgs
```

**Test scenarios:**
- Conversacion lineal (sin branches) produce mensajes en orden cronologico correcto
- Nodo con `weight: 0` (branch inactivo) es excluido del rawText
- `create_time` como Unix float se convierte a Date correcta
- `content.parts` con image pointer es ignorado; texto adyacente en parts se incluye
- `author.role: "system"` es excluido del rawText
- `author.role: "tool"` es excluido del rawText
- Nodo raiz con `message: null` se salta sin error
- `current_node` apunta a un nodo inexistente en `mapping` — retorna rawText vacio con `truncated: false`

**Verification:** Una vez recibido el ZIP de ChatGPT, parseo manual de una conversacion conocida produce el rawText esperado.

---

### U5. Pipeline de extraccion MiniMax M3

**Goal:** Enviar batches de conversaciones a MiniMax M3 y retornar senales de contexto estructuradas con atribucion de proveedor. Multi-provider por default: la primera importacion realista de un usuario (2-3 proveedores) corre aqui y cuesta ~$0.20-1.00 (ver Appendix: U5 cost model).

**Requirements:** R5, R6.

**Dependencies:** U3 o U4 (dado un array de `ConversationRecord` ya parseado). U6 provee el cliente de Firestore para el dedup pre-LLM.

**Files:**
- `src/extraction/minimax.ts`
- `src/extraction/cost-telemetry.ts` (logging estructurado de tokens por call)

**Approach:** Inicializar `OpenAI` con `baseURL: process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1"` y `apiKey: process.env.MINIMAX_API_KEY`. Aceptar array de `ConversationRecord` y el string `provider`. **Antes del LLM call**: hacer un dedup query a `users/{uid}/conversations` para obtener los `providerId` ya importados bajo este `provider`; filtrar el array de entrada a solo conversaciones nuevas. Esto evita pagar el LLM call dos veces si el usuario re-importa el mismo dataset (escenario comun al re-ejecutar el pipeline). Dividir el array resultante en batches de `MINIMAX_BATCH_SIZE` (default 20, configurable via env; override per-provider via `MINIMAX_BATCH_SIZE_CLAUDE` / `MINIMAX_BATCH_SIZE_CHATGPT` para usuarios con sizes desiguales entre proveedores). Por cada batch, construir un user prompt con el texto de todas las conversaciones separadas por `---` y pedir JSON con el schema de `ExtractionResult`. Parsear la respuesta; si el JSON es invalido, loggear y continuar con arrays vacios para ese batch. Mergear todos los resultados. Setear `provider` y `source` (titulo de la conversacion) en cada signal.

**Cost telemetry:** por cada call a MiniMax, loggear `provider`, `batchSize`, `inputTokens`, `outputTokens`, `latencyMs` con un logger estructurado (JSON a stdout en dev, `firebase-admin` log sink en prod). El primer checkpoint de calibracion es re-correr los Scenarios 1-3 del Appendix con los numeros reales despues de la primera importacion del fundador.

**Modelo de costo (referencia rapida):** 4 chars/token, $0.30-0.70/M input, output ~3-5x input. Ver Appendix para los 5 escenarios. La optimizacion por escenario (dedup, batch size, cascade summarization para outliers 4-5) se hace en iteraciones post-launch gated on telemetry real.

**Technical design — prompt (directional):**
```
System:
  "You are a context extraction engine. Read the following AI conversations 
   and extract structured user context signals. Return ONLY valid JSON 
   matching the schema below. No explanations."

User:
  "Provider: {provider}
   
   {rawText of each conversation separated by ---}
   
   Schema:
   {
     preferences: [{value: string, source: string}],
     personalFacts: [{value: string, source: string}],
     activeIntentions: [{value: string, source: string}],
     domainsOfInterest: [{value: string, source: string}]
   }
   source = title of the conversation where the signal appears."
```

**Test scenarios:**
- Conversacion con preferencia declarada ("quiero un auto electrico") retorna ese valor en `preferences[]`
- Batch de 20 conversaciones retorna signals de multiples conversaciones mezclados correctamente
- MiniMax retornando JSON invalido → batch retorna arrays vacios, no lanza error
- Input de 0 conversaciones retorna `ExtractionResult` vacio sin hacer llamada a la API
- Cada signal en el resultado tiene `provider` igual al proveedor de entrada
- Cada signal tiene `source` que coincide con el `title` de alguna conversacion del batch
- Fallo de red a MiniMax lanza error que se propaga al endpoint (no se silencia)
- **Dedup pre-LLM:** re-importar el mismo dataset (mismo `(provider, providerId)`) no dispara nuevas llamadas a MiniMax — el log muestra 0 batches enviados
- **Dedup parcial:** re-importar 50 conversaciones de un dataset de 100 donde 50 ya estaban importadas dispara LLM calls solo para las 50 nuevas
- **Cost telemetry:** cada call exitoso a MiniMax emite un log estructurado con `provider`, `batchSize`, `inputTokens`, `outputTokens` (verificable con un test que captura stdout / spy sobre el logger)
- **Per-provider batch size:** si `MINIMAX_BATCH_SIZE_CHATGPT=10` esta seteado y el input tiene 25 conversaciones de chatgpt, se generan 3 batches (10+10+5), no 2
- **Multi-provider run:** una invocacion secuencial sobre 3 arrays (uno por provider) emite logs separados por provider, no se mezclan signals entre providers

**Verification:** Import de las conversaciones del fundador produce `ExtractionResult` con al menos 3 signals en algun campo; loggear tokens usados por call para calibrar costo. Comparar el `inputTokens` real contra el `estimatedTokens` de U2 (fase 1) — desviaciones >30% senalan que la heuristica 4 chars/token necesita recalibracion.

---

### U6. Persistencia en Firestore

**Goal:** Escribir `ConversationRecord[]` y `ExtractionResult` en Firestore bajo el UID del usuario autenticado.

**Requirements:** R8, R9.

**Dependencies:** U1, U5.

**Files:**
- `src/firestore/conversations.ts`
- `src/firestore/profile.ts`

**Approach:**

**Conversaciones:** Batch-write a `users/{uid}/conversations/{provider}_{providerId}`. Usar `WriteBatch` de Firestore Admin (limite 500 docs/batch — paginear si la importacion supera 500 conversaciones). Cada documento incluye todos los campos de `ConversationRecord` mas `importedAt: FieldValue.serverTimestamp()`.

**Perfil:** Leer `users/{uid}/profile/main` existente. Mergear los signals nuevos: para cada campo del `ExtractionResult`, agregar solo los signals cuyo `value + provider` no existan ya en el array. Escribir de vuelta con `updatedAt: FieldValue.serverTimestamp()`. Si el documento no existe, crearlo.

**Test scenarios:**
- Escribir 5 conversaciones de Claude crea 5 documentos bajo `users/{uid}/conversations/` con `provider: "claude"`
- `importedAt` se setea en cada documento (no viene del cliente)
- Upsert de perfil con signals nuevos los agrega al array existente
- Upsert con signal duplicado (`value` + `provider` identicos) no crea duplicado
- Importacion de 600 conversaciones completa sin error (maneja el limite de 500 por WriteBatch)
- Error de escritura en Firestore se propaga al endpoint como 500

**Verification:** Tras import, Firestore console muestra conversaciones y perfil bajo el UID correcto; perfil contiene `provider: "claude"` en todos sus signals.

---

### U7. Endpoint de listado y filtro de conversaciones

**Goal:** Permitir al usuario autenticado listar y filtrar sus conversaciones por proveedor y/o rango de fecha.

**Requirements:** R10.

**Dependencies:** U6.

**Files:**
- `src/routes/conversations.ts`

**Approach:** `GET /api/v1/user/conversations` con query params opcionales: `provider` (`"claude" | "chatgpt"`), `from` (ISO date), `to` (ISO date), `cursor` (para paginacion). Query a `users/{uid}/conversations` con los `where` correspondientes; ordenar por `date` descendente; paginar a 50 por request. La respuesta incluye `provider`, `title`, `date`, `messageCount` por conversacion — sin `rawText` (solo metadata).

**Test scenarios:**
- `GET /conversations` retorna todas las conversaciones del usuario autenticado
- `?provider=claude` retorna solo conversaciones con `provider: "claude"`
- `?provider=chatgpt` retorna solo ChatGPT; no mezcla proveedores
- `?from=2026-01-01&to=2026-03-31` retorna solo conversaciones en ese rango
- Combinacion `?provider=claude&from=2026-04-01` filtra por ambos criterios
- Usuario sin conversaciones retorna `{ conversations: [], cursor: null }` — no 404
- Usuario A no puede ver conversaciones de Usuario B (query scoped por uid)
- `rawText` no aparece en la respuesta (solo metadata)

**Verification:** Tras import de Claude, `?provider=claude` retorna todas las conversaciones; `?provider=chatgpt` retorna array vacio.

---

### U8. Controles de privacidad y stub de acceso de sitios

**Goal:** Delete granular de data del usuario y gestion de accesos de sitios integrados.

**Requirements:** R11-R15.

**Dependencies:** U6.

**Files:**
- `src/routes/privacy.ts`
- `src/firestore/access.ts`

**Approach:**

**Delete endpoints:**
- `DELETE /api/v1/user/data` — borrar todas las conversaciones + perfil + siteAccess del uid (batch delete paginado)
- `DELETE /api/v1/user/data/provider/:provider` — borrar conversaciones con `provider == :provider`; luego re-calcular el perfil filtrando los signals del proveedor eliminado del documento `profile/main`
- `DELETE /api/v1/user/profile` — borrar `profile/main` solamente; las conversaciones permanecen

**Site access (stub):**
- `GET /api/v1/user/access` — listar documentos `users/{uid}/siteAccess` con `active: true`
- `DELETE /api/v1/user/access/:siteId` — setear `active: false` en `siteAccess/{siteId}` (no hard-delete — conserva audit trail)

Todos los deletes responden `{ deleted: true }`. Operaciones sobre datos inexistentes son idempotentes (200, no 404).

**Test scenarios:**
- `DELETE /user/data` elimina todas las conversaciones y el perfil del usuario
- Tras `DELETE /user/data/provider/claude`, conversaciones de ChatGPT permanecen
- Tras delete por proveedor, perfil no contiene signals con `provider: "claude"`
- `DELETE /user/profile` elimina `profile/main`; conversaciones intactas
- `DELETE /user/access/:siteId` setea `active: false`; el documento sigue existiendo
- Request no autenticado a cualquier delete retorna 401
- Delete de proveedor inexistente retorna `{ deleted: true }` (idempotente)
- Delete de 700 conversaciones completa sin timeout (batch paginado)

**Verification:** Importar Claude, luego `DELETE /user/data/provider/claude`, luego `GET /conversations` retorna array vacio; perfil no tiene signals de Claude.

---

## Scope Boundaries

**Deferred for later**

- Gemini import — Google Takeout incluye toda la cuenta; complejidad de filtrado inviable para V1.
- Re-sintesis del perfil on demand desde el historial crudo existente.
- Migracion Firestore → PostgreSQL cuando el PoC escale a produccion.
- Actualizacion automatica del perfil (sin API publica de las plataformas).

**Outside this product's identity**

- Browser extension para captura continua (riesgo de ToS, mantenimiento reactivo).
- Onboarding guiado con preguntas para reconstruir el perfil desde cero.

**Deferred to Follow-Up Work (Track 3)**

- Endpoints B2B para acceso al perfil de un usuario visitante (R16, R17).
- Mecanismo de autenticacion de sitios integrados.
- Flujo de grant de permisos: el usuario autoriza explicitamente a un sitio a ver su perfil. `siteAccess` esta stubbeado como coleccion pero sin endpoint de grant.

---

## Dependencies / Assumptions

- Firebase project: **\`sg-cloud-cefee\`** — ya existente con Cloud Functions y colecciones Firestore propias. ContextLayer escribe solo bajo el namespace \`users/{uid}/\`; no tocar ni eliminar colecciones ni funciones existentes.
- Credenciales del Admin SDK: \`FIREBASE_SERVICE_ACCOUNT\` env var (JSON de service account en base64). Descargar desde Firebase Console > Project Settings > Service Accounts > Generate new private key.
- API key MiniMax (`sk-cp-...`) puede ser proxy — probar `https://api.minimax.io/v1` primero; fallback a `https://www.minimax-api.com/v1` si la auth falla (U5).
- Formato del ZIP de Claude estable a junio 2026; `conversations.json` es el archivo raiz.
- ZIP de ChatGPT usara estructura `mapping` (basado en documentacion vigente; validar en U4 una vez disponible el export).
- Limite de documento Firestore 1MB: conversaciones individuales tipicas no lo alcanzan; truncacion a 800KB en rawText es medida de seguridad.

---

## Open Questions

**Deferred to implementation**

- Si el `sk-cp-` key funciona contra `api.minimax.io` directamente o requiere el base URL del proxy — testear en U5 antes de hardcodear.
- Batch size optimo para MiniMax: 20 conversaciones es el punto de partida; ajustar segun uso de tokens observado en las primeras llamadas. Override per-provider (`MINIMAX_BATCH_SIZE_CLAUDE`, `MINIMAX_BATCH_SIZE_CHATGPT`) ya planeado en U5 para usuarios con sizes desiguales.
- Indices compuestos de Firestore para queries `provider + date` — Firestore los solicita al primer query miss; crear en consola Firebase.
- **Output token pricing con MiniMax** — el modelo del Appendix asume ~3-5x input; confirmar con MiniMax antes de shippear el cost preview al usuario. Si output es 5x input (no 3x), los Scenarios 3-5 se desplazan visiblemente.
- **U2.1 secuencia** — multi-file upload debe estar listo antes de que U5 entre en produccion (U5 corre por archivo dentro de la misma request). Si U5 sale primero, el primer import multi-provider del fundador requiere sequential POSTs.

---

## Appendix: U5 cost model

Modelo de costo para U5 (extraccion MiniMax M3) en 5 arquetipos de usuario. Baseline multi-provider (2-3 proveedores como caso tipico, no 1). Numeros son rangos, no promesas — recalibrar con la primera importacion real del fundador antes de cerrar el modelo. Doc de research: `docs/plans/2026-06-13-002-feat-u5-cost-model-plan.md`.

### Pricing assumptions

- **Input:** $0.30-0.70 por 1M tokens (rango del plan, calibrar tras la primera llamada real)
- **Output:** ~$1.50 por 1M tokens (3-5x input; **necesita verificacion con MiniMax**, ver Open Question)
- **Modelo:** `MiniMax-M3`, 1M token context window, baseURL `https://api.minimax.io/v1`

### Token estimation

- **Char-to-token ratio:** ~4 chars/token (heuristica para English text; vale para Claude export style)
- **System prompt + schema per batch:** ~800 tokens de overhead fijo
- **Output per batch:** ~500-2000 tokens dependiendo de la densidad de senales
- **Batch size:** 20 conversaciones default (`MINIMAX_BATCH_SIZE`)
- **Avg conversation size:** 9KB rawText (calibrado del export del fundador: 208 conversaciones → 1.9MB / 208 = 9KB)

### Sanity check (founder's data, Claude only)

208 conversaciones × 9KB ≈ 1.9MB rawText ≈ 475K tokens. Cabe en una sola llamada de 1M contexto. El default de 20/batch da 11 llamadas; el contexto de 1M hace que 1 llamada sea tecnicamente posible. El batch default es una perilla de control de costo, no un limite duro.

**Nota:** la primera importacion real del fundador sera 3 proveedores (Claude + ChatGPT + Gemini), no 1. Costo aproximadamente 3x de este baseline. Scenario 3 abajo refleja el end state real.

### Scenarios (per single import session, todos los providers que el usuario quiere importar en una sola vez)

| # | Archetype | Convos (per provider → total) | Providers | RawText | Tokens (in) | Batches | Input cost | Output cost | **Total** |
|---|-----------|-------------------------------|-----------|---------|-------------|---------|------------|-------------|-----------|
| 1 | Light (empezo con un AI, agrego un segundo recientemente) | 30+50 = 80 | 2 | 0.7 MB | ~180K | 4 | $0.05-0.13 | ~$0.01 | **$0.07-0.14** |
| 2 | Typical (2 providers, uso casual-a-moderate durante 1-2 anos) | 100+150 = 250 | 2 | 2.3 MB | ~570K | 13 | $0.17-0.40 | ~$0.03 | **$0.20-0.43** |
| 3 | Founder baseline (3 providers, multi-year — Claude + ChatGPT + Gemini) | 200+200+200 = 600 | 3 | 5.4 MB | ~1.35M | 30 | $0.41-0.95 | ~$0.07 | **$0.47-1.01** |
| 4 | Power user (3 providers, heavy multi-year use) | 500+800+300 = 1,600 | 3 | 14.4 MB | ~3.6M | 80 | $1.08-2.52 | ~$0.18 | **$1.26-2.70** |
| 5 | Hoarder (3+ providers, decade+ of usage) | 2K+3K+1K = 6,000 | 3+ | 54 MB | ~13.5M | 300 | $4.05-9.45 | ~$0.68 | **$4.73-10.13** |

### Key observations

- **Sub-dollar para 60% de los usuarios (Scenarios 1-2).** El founder baseline (Scenario 3) cubre $0.47-1.01 — cruza el umbral de $1, con el upper bound driven por el peor caso de input pricing ($0.70/M).
- **Multi-provider baseline shifts the curve.** Primera version del modelo asumia single-provider; eso ponia 90% de los usuarios bajo $2. El baseline realista 2-3-provider pone ~40% sobre $1.
- **Provider adds son lineales, no sinergicos.** Cada provider es su propio U5 pass; no hay trabajo compartido, no hay costo amortizado entre providers. Un intake de 3 providers ≈ 3x el costo per-provider.
- **Scenarios 4-5 cruzan umbrales significativos.** Power users ($1.27-2.70) y hoarders ($4.73-10.13) son eventos de costo real. Decidir antes de launch si los absorbemos, medimos o capeamos.

### Optimization levers (priority order; 1 y 5 aterrizan con U5, 2-4 son post-launch)

1. **Dedup on `(provider, providerId)` pre-LLM call** — U5 ya lo implementa. Re-import no es un cost event.
2. **Aumentar batch size para power users** — 1M context significa 50-100 convos/batch es tecnicamente viable. Mitad del overhead-driven cost para Scenario 3+. Post-launch gated on telemetry.
3. **Cascade para outliers** — Scenario 4-5 users (1.5K+ convos) reciben two-pass run: first pass resume a 10% size, second pass extrae de summaries. Costo ~30-50% de single-pass. Trades signal precision for cost. Post-launch.
4. **Pre-filter a "interesting" conversations** — heuristica: skip convos <500 chars, skip all-tool-use assistant responses. Quita ~20-30% del volumen de tokens a zero quality cost. Post-launch.
5. **Per-provider batch sizing** — U5 ya lo soporta (`MINIMAX_BATCH_SIZE_CLAUDE`, `MINIMAX_BATCH_SIZE_CHATGPT`). Small providers get smaller batches (less overhead); big providers get bigger batches (more amortization).

---

## Sources & Research

- MiniMax M3: OpenAI-compatible, `https://api.minimax.io/v1`, model `MiniMax-M3`, 1M token context window, Bearer auth. Pricing ~$0.30-0.70/M input tokens.
- Claude export schema: `osteele/claude-chat-viewer` (src/schemas/chat.ts); campo clave `sender: "human" | "assistant"`, contenido en `content[]` de bloques tipados.
- ChatGPT export schema: `queelius/ctk` (importers/openai.py), OpenAI Community thread; estructura de arbol `mapping`, linearizacion desde `current_node` via `parent` links, filtro `weight >= 1`.
- Firebase Admin SDK: verificacion de token via `admin.auth().verifyIdToken()`, Firestore batch write (limite 500 docs).
