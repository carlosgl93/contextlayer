---
date: 2026-06-13
topic: importacion-contexto-ia
---

# Importacion de contexto desde IAs externas

## Summary

Un pipeline de importacion one-time donde el usuario sube un ZIP de exportacion de Claude (V1) o ChatGPT (V2 inmediata), un LLM extrae senales de contexto estructuradas, y se persiste tanto el historial crudo como el perfil sintetizado. El perfil queda accesible via API con control granular por sitio; el usuario puede borrar toda su data en cualquier momento.

---

## Key Decisions

**Empezar con Claude en el PoC.** Claude tiene exportacion inmediata (ZIP ~2.3MB). ChatGPT tarda dias en generar el link de descarga. Gemini exporta toda la cuenta Google en un ZIP masivo. Reducir el scope del PoC a Claude valida el pipeline completo sin multiplicar parsers ni fricciones de onboarding.

**Guardar crudo + perfil sintetizado.** El historial crudo es la fuente de verdad y permite re-sintesis futura. El perfil sintetizado (JSON estructurado) permite acceso rapido para los sitios B2B sin parsear conversaciones enteras. El B2B nunca accede al crudo directamente.

**MiniMax M3 es el LLM de extraccion.** Se usara via API key propia (suscripcion del operador de ContextLayer). Los datos del usuario salen del sistema unicamente hacia MiniMax durante la extraccion; esto se le comunica explicitamente a A1 antes de procesar (R6).

**Un LLM extrae las senales de contexto del crudo.** Las conversaciones brutas son ruidosas. MiniMax M3 extrae preferencias declaradas, hechos personales, intenciones activas, y dominios de interes, produciendo un perfil JSON consistente independientemente de la plataforma de origen.

**El modelo de persistencia se organiza por proveedor.** El sistema detecta automaticamente el proveedor a partir de la estructura del ZIP (Claude vs ChatGPT tienen formatos distintos). El crudo y el perfil sintetizado se almacenan bajo una clave de proveedor, permitiendo que A1 busque y filtre su historial por origen ("mis conversaciones de Claude", "lo que hable con Gemini hace 2 semanas"). El perfil unificado agrega senales de todos los proveedores pero mantiene la atribucion de origen en cada campo.

**Importacion one-time en V1.** Sin API publica de las plataformas, la actualizacion automatica requeriria un browser extension — descartado por riesgo de ToS con OpenAI/Google y por su mantenimiento reactivo a cambios de plataforma. El usuario re-importa voluntariamente cuando su contexto cambia de forma significativa.

---

## Actors

A1. **Usuario final (B2C)** — sube el ZIP de exportacion, controla que sitios acceden a su perfil, puede borrar su data.

A2. **Sistema ContextLayer** — parsea el ZIP, extrae contexto via LLM, persiste crudo y perfil, expone API de acceso.

A3. **Sitio integrado (B2B)** — consulta el perfil de un usuario autenticado via API, dentro de los permisos que el usuario otorgo.

---

## Requirements

**Ingesta y deteccion de proveedor**

R1. El sistema acepta un ZIP de exportacion de Claude subido por A1 y lo parsea correctamente.

R2. El sistema acepta el archivo `conversations.json` de ChatGPT (como archivo suelto o dentro del ZIP de exportacion de OpenAI).

R3. El sistema detecta automaticamente el proveedor de origen a partir de la estructura interna del ZIP, sin requerir que A1 lo declare manualmente.

R4. Si el ZIP contiene un formato no reconocido o esta corrupto, el sistema notifica a A1 con un mensaje claro y no procesa parcialmente.

**Extraccion de contexto**

R5. El sistema extrae del historial: preferencias declaradas, hechos personales, intenciones activas, y dominios de interes, usando MiniMax M3 via API.

R6. El resultado de la extraccion es un perfil JSON con campos definidos y consistentes entre plataformas de origen; cada campo del perfil lleva atribucion del proveedor de origen.

R7. El sistema informa a A1 que MiniMax M3 procesara sus datos antes de que el procesamiento ocurra, y requiere confirmacion explicita.

**Persistencia**

R8. El sistema persiste el historial en crudo organizado por usuario (email) y proveedor; cada conversacion lleva metadatos de proveedor, fecha, y titulo.

R9. El sistema persiste el perfil sintetizado como entidad separada, actualizable independientemente del crudo, con atribucion de proveedor por campo.

R10. A1 puede buscar y filtrar su historial de conversaciones por proveedor y por rango de fecha.

**Control del usuario sobre sus datos**

R11. A1 puede borrar toda su data (crudo + perfil) en cualquier momento, con efecto inmediato.

R12. A1 puede borrar solo el perfil sintetizado sin eliminar el crudo, o viceversa.

R13. A1 puede borrar el crudo de un proveedor especifico sin afectar los datos de otros proveedores.

R14. A1 puede revocar el acceso de un sitio integrado especifico a su perfil en cualquier momento.

R15. A1 ve que sitios tienen acceso activo a su perfil y desde cuando.

**Acceso B2B**

R16. A3 puede consultar el perfil sintetizado de un usuario autenticado dentro de los permisos que A1 otorgo explicitamente.

R17. A3 nunca recibe el historial crudo — solo el perfil sintetizado o subconjuntos de el.

---

## Key Flows

- F1. Importacion de contexto (happy path)
  - **Trigger:** A1 autenticado accede al onboarding de importacion.
  - **Actors:** A1, A2
  - **Steps:** A1 sube el ZIP → A2 detecta el proveedor automaticamente (R3) → A2 valida formato → A2 informa que MiniMax M3 procesara los datos y solicita confirmacion (R7) → A2 extrae senales con atribucion de proveedor y genera perfil JSON (R5, R6) → A2 persiste crudo organizado por proveedor y perfil (R8, R9) → notifica a A1.
  - **Covers:** R1, R2, R3, R5, R6, R7, R8, R9

- F2. Busqueda de historial por proveedor
  - **Trigger:** A1 quiere encontrar una conversacion especifica ("lo que hable con Claude hace 2 semanas").
  - **Actors:** A1, A2
  - **Steps:** A1 filtra por proveedor y/o rango de fecha → A2 devuelve las conversaciones que coinciden con metadatos (titulo, fecha, proveedor).
  - **Covers:** R8, R10

- F3. Borrado de data
  - **Trigger:** A1 solicita borrar su data desde configuracion de cuenta.
  - **Actors:** A1, A2
  - **Steps:** A1 selecciona que borrar (crudo de un proveedor, todo el crudo, perfil, o todo) → A2 confirma que la accion es irreversible → A2 elimina con efecto inmediato → si se elimino el perfil, A2 revoca todos los accesos B2B activos.
  - **Covers:** R11, R12, R13, R14

- F4. Acceso B2B al perfil
  - **Trigger:** A1 autenticado visita un sitio integrado con feature de IA.
  - **Actors:** A1, A2, A3
  - **Steps:** A3 solicita el perfil de A1 via API de ContextLayer → A2 verifica que A1 otorgo acceso a ese sitio → A2 devuelve el perfil sintetizado (o subconjunto autorizado) → la IA del sitio incorpora el perfil como contexto inicial.
  - **Covers:** R15, R16, R17

---

## Scope Boundaries

**Deferred for later**

- Importacion desde Gemini — Google Takeout incluye toda la cuenta (YouTube, Calendar, Drive) en un solo ZIP; el filtrado y volumen lo hacen inviable para V1.
- ChatGPT en V2 — viable tecnicamen te, pero el delay de dias en la exportacion lo pospone hasta despues de validar el pipeline con Claude.
- Actualizacion automatica del perfil — sin API publica de las plataformas requiere browser extension.
- Re-sintesis del perfil sobre el crudo existente al agregar conversaciones nuevas.

**Outside this product's identity**

- Browser extension para captura continua — riesgo de ToS con OpenAI y Google; mantenimiento reactivo a cambios de UI de plataformas.
- Onboarding guiado con preguntas para construir el perfil desde cero — no cumple la promesa de portabilidad del contexto existente.

---

## Dependencies / Assumptions

- El formato de exportacion de Claude se mantiene estable durante el desarrollo del PoC. Cambios de formato rompen el parser sin aviso.
- MiniMax M3 soporta un contexto suficiente para procesar conversaciones individuales del ZIP; el context window exacto debe verificarse antes de definir la estrategia de chunking.
- El email es el identificador unico del usuario en el sistema (per STRATEGY.md).
- El sitio integrado implementa autenticacion propia que permite a ContextLayer verificar la identidad del visitante.

---

## Outstanding Questions

**Deferred to planning**

- Estructura interna exacta del ZIP de Claude (directorios, nombres de archivo, encoding).
- Estrategia de chunking para conversaciones que excedan el context window del LLM de extraccion.
- Mecanismo de autenticacion entre A3 y la API de ContextLayer (scope de Track 3, fuera de este doc).
