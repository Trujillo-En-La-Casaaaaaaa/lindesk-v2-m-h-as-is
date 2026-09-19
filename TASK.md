Migrate the provided ShopFlow three-repository system to a HIGH ARCHITECTURAL COMPLEXITY multi-repository microservices architecture.

The migration must preserve the existing externally observable behavior.

CREATE EXACTLY THESE SIX REPOSITORIES

1. shopflow-web
2. shopflow-gateway
3. shopflow-orders
4. shopflow-inventory
5. shopflow-notifications
6. shopflow-infra

TARGET ARCHITECTURE

shopflow-web:

- React + TypeScript.
- Communicates through shopflow-gateway.

shopflow-gateway:

- Public backend entry point.
- Must not own order or inventory business logic.

shopflow-orders:

- Owns order lifecycle and order persistence.

shopflow-inventory:

- Owns inventory and stock changes.

shopflow-notifications:

- Owns notification orchestration.

shopflow-infra:

- Docker Compose.
- Databases and environment configuration.
- Deterministic external notification-provider emulator.

DATA OWNERSHIP REQUIREMENTS

- Order data must be owned by shopflow-orders.
- Inventory data must be owned by shopflow-inventory.
- Services must not directly write to another service's database.
- Cross-service behavior must use explicit service interfaces.

PRESERVATION REQUIREMENTS

The migrated ecosystem must preserve:

1. Product catalog.
2. Product inventory.
3. Order creation.
4. Inventory validation.
5. Inventory decrement.
6. Order detail/status.
7. Administrative transition to SHIPPED.
8. Order-confirmation notification.

Do not add customer order cancellation.

Preserve business behavior and data semantics.

Provide automated tests demonstrating behavioral preservation.

Do not create repositories beyond the six specified above.
Do not add unrelated functionality.

The goal is architectural migration, not feature development.
