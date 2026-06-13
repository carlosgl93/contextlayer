---
name: ContextLayer
last_updated: 2026-06-13
---

# ContextLayer Strategy

## Target problem

Cuando un usuario visita una web con un feature de IA, tiene que re-explicar su contexto desde cero porque cada IA opera en silo. La fricción es tan alta que la mayoría ignora el feature, dejando la inversión en IA del negocio inutilizada.

## Our approach

Ofrecemos inyección de contexto para negocios que ya tienen IA implementada. El usuario importa su historial desde sus IAs (ChatGPT, Gemini, Claude) de forma gratuita; nosotros lo persistimos y se lo vendemos a las empresas que se integran vía API — cuyo ROI sube porque reciben recomendaciones, filtros y journeys ya alineados con el contexto real del visitante. Cuantos más sitios adoptan, más valioso se vuelve el contexto acumulado.

## Who it's for

**B2C — usuario final:** Persona que usa múltiples IAs regularmente — usa ContextLayer (gratis) para que cualquier web que visite ya lo conozca desde el primer mensaje, sin re-explicar su contexto.

**B2B — empresa / producto digital:** Negocio con un feature de IA ya implementado — paga por la API de ContextLayer para inyectar contexto real del visitante y acortar el customer journey desde la primera interacción.

## Key metrics

- **Mensajes hasta primera respuesta útil** - turnos promedio antes de que la IA del sitio entregue valor; comparado entre sesiones con contexto activo vs sin contexto
- **Riqueza del contexto por usuario** - número de atributos/entidades promedio en el perfil; medido en la base de datos de perfiles
- **Conversion lift en sitios integrados** - delta en tasa de conversión entre sesiones con contexto vs sin contexto; reportado por el sitio integrado

## Tracks

### Importación de datos

Conectores con las principales IAs para que el usuario exporte y normalice su historial una sola vez.

_Why it serves the approach:_ Sin datos importados no hay red — es la puerta de entrada al ciclo de valor.

### Capa de persistencia y perfil

Base de datos de contexto por usuario (email como ID único), con privacidad, TTL y borrado garantizados.

_Why it serves the approach:_ El contexto tiene que existir y estar limpio antes de poder circular hacia los sitios integrados.

### API de integración

SDK y API para que developers de webs consulten el contexto del visitante autenticado en tiempo real.

_Why it serves the approach:_ Sin integración del lado del sitio, el usuario nunca recibe el beneficio que motivó la importación — y el B2B no tiene producto que comprar.

### Red y adopción

Go-to-market hacia verticales (automotriz, real estate, e-commerce), onboarding B2B, y DX para reducir fricción de adopción.

_Why it serves the approach:_ El efecto de red solo existe con masa crítica de sitios — sin adopción, el contexto no tiene a dónde fluir y el modelo freemium no se sostiene.

## Milestones

- **TBD** - MVP PoC: importar contexto propio desde al menos dos IAs y accederlo vía la API propia.
