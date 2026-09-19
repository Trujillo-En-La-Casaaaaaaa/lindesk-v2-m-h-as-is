# ShopFlow AS-IS — migración · complejidad alta (M-H)

Este repositorio es el **sistema de partida** (fixture congelado `F2-medium`) que se le entregó a LinDesk en el escenario **M-H**. **No es un resultado de LinDesk.**

Compare con el resultado: https://github.com/Trujillo-En-La-Casaaaaaaa/lindesk-v2-m-h

Identificador de la corrida del resultado: `20260917-104756` (solo trazabilidad).

## Qué es ShopFlow

ShopFlow es una aplicación pequeña de **comercio electrónico / gestión de pedidos**. Es el dominio compartido de los nueve escenarios (no es LinDesk). El comportamiento de negocio previsto es:

1. Catálogo de productos.
2. Inventario (stock).
3. Creación de pedidos.
4. Validar inventario **antes** de aceptar un pedido.
5. Decrementar inventario **después** de un pedido exitoso.
6. Consulta de detalle / estado del pedido.
7. Acción administrativa para marcar un pedido como `SHIPPED`.
8. Notificación de confirmación del pedido.

Según el escenario, se pide además **cancelación de pedido por el cliente** (creación y evolución) o se prohíbe expresamente (migración).

Reglas de cancelación cuando sí aplica:

- el pedido no debe estar `SHIPPED`;
- motivo no vacío y de como máximo 200 caracteres;
- pasar a `CANCELLED`;
- guardar `cancelledAt` y `cancellationReason`;
- restaurar inventario **exactamente una vez**;
- enviar o registrar una notificación de cancelación;
- rechazar cancelar un pedido ya enviado;
- reintentos repetidos no deben restaurar stock dos veces.


## Arquitectura de este baseline

Tres repositorios ya separados (`shopflow-web`, `shopflow-api` hexagonal, `shopflow-infra`). Es el origen que debía migrarse a seis microservicios.

En este AS-IS el comportamiento ya cubre catálogo, inventario, pedidos, envío y notificación de confirmación. **No incluye cancelación de pedido por el cliente.**

### Encargo que se aplicó **sobre** este baseline

Migrar a seis repositorios de microservicios **sin** añadir cancelación y preservando el comportamiento observable.

El texto **exacto** está en [`TASK.md`](./TASK.md) (inglés, congelado). Léalo aquí y luego abra el repositorio de resultado.

### Carpetas de este árbol

- `shopflow-web/`
- `shopflow-api/`
- `shopflow-infra/`

## Cómo usarlo en la entrevista

1. Inspeccione este baseline primero (cómo está hecho ShopFlow hoy).
2. Lea `TASK.md`.
3. Pase al repositorio de resultado y compare. En evolución debe preservarse la arquitectura; en migración debe cambiar de forma controlada y **sin** añadir cancelación.
4. Este paquete es **solo código fuente**. Etapa B no está incluida.
