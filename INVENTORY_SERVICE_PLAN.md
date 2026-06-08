# Inventory Service Development Plan

## Decision

Create independent inventory bounded context.

| surface | choice |
| --- | --- |
| repo/folder | `pmt-v3-inventory-service` |
| service | `inventory-service` |
| stack | Node 20+, Express, TypeScript, DDD layers |
| database | PostgreSQL `pmt_v3_inventory` |
| internal port | `4001` |
| gateway prefix | `/api/inventory` |
| frontend routes | `/inventory/components`, `/inventory/stock`, `/inventory/stocktakes` |

Provisioning: `pmt_v3_inventory` created 2026-06-04; current owner `admin`; dedicated least-privilege service credentials pending.

Reasons:

- component master + physical stock lifecycle ≠ product/BOM lifecycle
- inventory writes require ledger, reservations, stocktake, strict transaction rules
- independent database limits blast radius + permits separate backup/scaling/access
- product service stays focused on products, BOMs, operations, routing, collaboration

Cost:

- cross-database FK/join ⊥
- service integration + eventual consistency required
- inventory outage must have defined BOM behavior

## Ownership

### Inventory Service Owns

- component master records
- stock locations
- immutable stock transaction ledger
- current stock balances
- reservations/releases/consumption
- stocktakes + adjustments
- inventory audit history
- inventory integration events

### Product Service Owns

- products
- BOMs + BOM item required quantity
- operations, checklist, routing, deadlines
- optional `inventory_component_id`
- immutable component snapshot on BOM line

### Boundary Rules

- services communicate through API/events only; direct cross-service DB query ⊥
- cross-service database FK ⊥
- BOM view works from snapshot when inventory unavailable
- component master edit never rewrites historical BOM snapshot
- deleting referenced component ⊥; deactivate/archive instead
- stock movement never created by editing component master or BOM line

## Scope

### MVP

- component list/search/create/edit/archive
- component fields: SKU/ident, name, description, drawing number, unit, category, manufacturer, supplier reference, minimum stock
- location list/create/edit/archive
- receive stock
- issue/consume stock
- transfer stock between locations
- manual adjustment with mandatory reason
- current on-hand/reserved/available stock
- reserve/release stock for external source
- immutable movement history
- stocktake + reconciliation
- CSV/Excel component import with validation preview + atomic commit
- actor attribution, optimistic locking, idempotent commands
- gateway authentication/authorization
- BOM component lookup + link + snapshot

### Later

- lots/batches, serial numbers, expiry dates
- purchase orders + receiving workflow
- supplier service/integration
- barcode/QR workflows
- costing/valuation
- automatic reorder suggestions
- event broker + async projections
- multi-warehouse permissions

## Core Model

### `components`

| column | shape |
| --- | --- |
| `id` | UUID PK |
| `sku` | normalized text unique |
| `name` / `description` | text |
| `drawing_number` | nullable text |
| `unit` | text; e.g. `pcs`, `m`, `kg` |
| `category` | nullable text |
| `manufacturer` | nullable text |
| `supplier_reference` | nullable text |
| `minimum_stock` | numeric `≥ 0` |
| `active` | boolean |
| `lock_version` | bigint |
| `created_by` / `updated_by` | external user ID |
| `created_at` / `updated_at` | timestamptz |

### `locations`

| column | shape |
| --- | --- |
| `id` | UUID PK |
| `code` | normalized text unique |
| `name` / `description` | text |
| `active` | boolean |
| `lock_version` | bigint |
| audit columns | actor + timestamps |

### `inventory_transactions`

Immutable command/audit header.

| column | shape |
| --- | --- |
| `id` | UUID PK |
| `command_id` | UUID unique |
| `type` | `receipt` \| `issue` \| `transfer` \| `adjustment` \| `stocktake` |
| `reference_type` / `reference_id` | nullable external source |
| `reason` | required for adjustment/stocktake |
| `actor_id` / `actor_name` | change author |
| `created_at` | timestamptz |

### `inventory_transaction_lines`

| column | shape |
| --- | --- |
| `id` | UUID PK |
| `transaction_id` | UUID FK |
| `component_id` | UUID FK |
| `location_id` | UUID FK |
| `quantity_delta` | numeric, non-zero |

Transfer = source negative line + destination positive line in one transaction.

### `stock_balances`

Transactional projection for fast reads.

| column | shape |
| --- | --- |
| `component_id` / `location_id` | composite PK |
| `on_hand` | numeric |
| `reserved` | numeric `≥ 0` |
| `lock_version` | bigint |
| `updated_at` | timestamptz |

`available = on_hand - reserved`; API-derived, not independently stored.

### `reservations`

| column | shape |
| --- | --- |
| `id` | UUID PK |
| `component_id` / `location_id` | UUID FK |
| `quantity` | numeric `> 0` |
| `source_type` / `source_id` | external owner; e.g. order |
| `status` | `active` \| `released` \| `consumed` |
| `command_id` | UUID unique |
| audit columns | actor + timestamps |

### `stocktakes`

Header + counted component/location lines. Finalization creates one immutable `stocktake` transaction.

### `inventory_outbox`

Durable integration events, written in same transaction as source change.

Events:

```text
inventory.component.created
inventory.component.updated
inventory.component.archived
inventory.balance.changed
inventory.reservation.changed
```

## Interfaces

### REST

```text
GET    /api/inventory/components
POST   /api/inventory/components
GET    /api/inventory/components/:componentId
PATCH  /api/inventory/components/:componentId
DELETE /api/inventory/components/:componentId              → archive
POST   /api/inventory/components/import                     → atomic import

GET    /api/inventory/locations
POST   /api/inventory/locations
PATCH  /api/inventory/locations/:locationId
DELETE /api/inventory/locations/:locationId                 → archive

GET    /api/inventory/stock?componentId=&locationId=&query=
GET    /api/inventory/transactions?componentId=&locationId=
POST   /api/inventory/transactions/receipt
POST   /api/inventory/transactions/issue
POST   /api/inventory/transactions/transfer
POST   /api/inventory/transactions/adjustment

POST   /api/inventory/reservations
POST   /api/inventory/reservations/:reservationId/release
POST   /api/inventory/reservations/:reservationId/consume

POST   /api/inventory/stocktakes
PUT    /api/inventory/stocktakes/:stocktakeId/lines
POST   /api/inventory/stocktakes/:stocktakeId/finalize
```

Mutation common fields:

```json
{
  "commandId": "uuid",
  "expectedVersion": 4,
  "data": {}
}
```

### BOM Integration

Inventory API:

```text
GET /api/inventory/components?query=<text> → component lookup
GET /api/inventory/components/:id         → current component master
GET /api/inventory/stock?componentId=:id  → availability by location
```

Product-service BOM item stores:

```text
inventory_component_id: UUID?
component_snapshot: {
  sku,
  name,
  description,
  drawingNumber,
  unit
}?
quantity: numeric > 0
```

Link flow:

1. FE searches inventory through gateway.
2. User selects component.
3. Product-service receives component ID + snapshot.
4. Product-service validates component through inventory API.
5. BOM transaction stores reference + snapshot.
6. Existing BOM read never requires live inventory call.

## Transaction Rules

- stock change = ledger lines + balance projection + outbox event in one DB transaction
- lock affected balance rows in stable `(component_id, location_id)` order
- duplicate `commandId` → original result; duplicate stock movement ⊥
- transaction/ledger row update/delete ⊥
- quantity precision follows component unit policy
- default negative `available` stock ⊥
- transfer line deltas sum to zero per component
- reservation quantity ≤ available
- consume reservation atomically reduces `reserved` + `on_hand`
- archived component/location rejects new movements
- manual adjustment requires reason + privileged actor

## Architecture

Reuse product-service layering:

```text
src/domain/
  component/
  inventory/
  reservation/
  stocktake/
src/application/
src/infrastructure/
  config/
  persistence/postgres/
  integrations/
src/interfaces/http/
src/shared/
```

Required ports/services:

- `ComponentRepository`
- `InventoryLedgerRepository`
- `StockBalanceRepository`
- `ReservationRepository`
- `StocktakeRepository`
- `InventoryCommandService`
- `OutboxRepository`
- `IdentityProvider`

Use repeatable migrations from first commit. `DB_SYNC` production path ⊥.

## Invariants

- V1: ∀ stock change → immutable transaction + lines.
- V2: ledger + balances + outbox event → one DB transaction.
- V3: duplicate `commandId` → one durable effect.
- V4: transaction/line update or delete ⊥.
- V5: `available = on_hand - reserved`.
- V6: default `available < 0` ⊥.
- V7: transfer ∀ component → sum(`quantity_delta`) = 0.
- V8: reservation quantity `> 0` + `≤ available`.
- V9: reservation consume → `reserved` + `on_hand` decrease atomically.
- V10: archived component/location → new stock command rejected.
- V11: component SKU unique after normalization.
- V12: stale `expectedVersion` → `409 VERSION_CONFLICT`.
- V13: adjustment/stocktake reconciliation → actor + reason required.
- V14: component master edit → stock quantity unchanged.
- V15: BOM line snapshot immutable except explicit BOM edit.
- V16: inventory outage → existing BOM read remains available.
- V17: direct cross-service DB query/FK ⊥.
- V18: malformed/invalid request → 4xx; never 500.

## Delivery Plan

Status: `[ ]` todo, `[~]` active, `[x]` done.

### Phase 0: Decisions + Foundation

- [ ] I0.1 Confirm component fields, unit precision, negative-stock policy, roles.
- [x] I0.2 Create `pmt-v3-inventory-service` repo/submodule.
- [~] I0.3 PostgreSQL database `pmt_v3_inventory` created; separate credentials pending.
- [x] I0.4 Add project-local read-only inventory MCP.
- [ ] I0.5 Scaffold Express/TypeScript DDD service; port `4001`.
- [ ] I0.6 Add migrations, test DB isolation, lint/build/test/CI.

Gate: clean service boots; migrations apply/rollback; test DB isolated.

### Phase 1: Component Catalog

- [ ] I1.1 Add component + location migrations/indexes.
- [ ] I1.2 Add domain entities/repositories/use cases.
- [ ] I1.3 Add component/location REST APIs + auth.
- [ ] I1.4 Add atomic component import + validation report.
- [ ] I1.5 Add unit/integration tests.

Gate: catalog + locations manageable through API.

### Phase 2: Ledger + Stock

- [ ] I2.1 Add transaction, line, balance, outbox migrations.
- [ ] I2.2 Add transactional receipt/issue/transfer/adjustment commands.
- [ ] I2.3 Add stock + movement history queries.
- [ ] I2.4 Add idempotency, row locking, conflict handling.
- [ ] I2.5 Add concurrency + rollback + invariant tests.

Gate: concurrent stock commands preserve V1-V7.

### Phase 3: Reservations + Stocktakes

- [ ] I3.1 Add reservation model + reserve/release/consume commands.
- [ ] I3.2 Add stocktake model + count/finalize flow.
- [ ] I3.3 Add privileged adjustment rules.
- [ ] I3.4 Add tests for V8-V13.

Gate: reservation + stocktake workflows auditable + atomic.

### Phase 4: Gateway + Frontend

- [ ] I4.1 Add authenticated gateway inventory proxy.
- [ ] I4.2 Build component catalog page.
- [ ] I4.3 Build stock overview + movement history.
- [ ] I4.4 Build receipt/issue/transfer/adjustment flows.
- [ ] I4.5 Build reservation + stocktake flows.
- [ ] I4.6 Add frontend E2E + accessibility checks.

Gate: warehouse user completes core inventory workflows through gateway.

### Phase 5: BOM Integration

- [ ] I5.1 Add inventory client port/adapter to product-service.
- [ ] I5.2 Add component reference + snapshot to BOM item.
- [ ] I5.3 Add component lookup/link/availability UI in BOM workspace.
- [ ] I5.4 Define inventory-unavailable behavior + timeouts.
- [ ] I5.5 Add contract + integration + outage tests.

Gate: BOM component links remain historically stable + readable during inventory outage.

### Phase 6: Release

- [ ] I6.1 Add backup/restore + rollback runbook.
- [ ] I6.2 Add metrics/logging/security/load tests.
- [ ] I6.3 Stage migration + user acceptance.
- [ ] I6.4 Deploy inventory BE, gateway route, FE, then BOM integration.

Gate: production smoke test + ledger reconciliation pass.

## Required Test Scenarios

1. Duplicate receipt command retried → one ledger transaction.
2. Two users issue same stock concurrently → negative available stock ⊥.
3. Transfer fails after source line attempt → no source/destination/balance change.
4. Reservation + issue race → invariants preserved.
5. Reservation consume → reserved/on-hand decrease atomically.
6. Archived component/location receives movement → rejected.
7. Adjustment without reason/privilege → rejected.
8. Stocktake finalize retried → one reconciliation transaction.
9. Component edit → balance unchanged.
10. BOM linked component later renamed → old BOM snapshot unchanged.
11. Inventory unavailable → existing BOM opens from snapshot.
12. Invalid import row → zero component rows committed.

## Definition Of Done

- all V1-V18 enforced + tested
- separate DB credentials + least privilege
- migrations repeatable + rollback documented
- no mutable stock quantity endpoint
- ledger reconciles with balances
- gateway/auth/role enforcement active
- component/BOM contract documented + tested
- CI runs build, lint, unit, integration, E2E
