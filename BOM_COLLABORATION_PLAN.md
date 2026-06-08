# BOM Collaboration Development Plan

## Goal

Build product BE + FE BOM workspace where multiple users edit same BOM concurrently.

Success:

- edits appear for collaborators in near real time
- no silent overwrite or lost work
- reconnect restores current state
- every change attributed + auditable
- keyboard-first BOM entry stays fast
- existing PMTV2 BOM capability preserved

## PMTV2 Reference Audit

Reference: `C:\Users\mayer\OneDrive\Desktop\PMTV2-Production-Docker`.

Read-only `devprod` baseline (2026-06-04): 7,684 BOMs; 9,419 items; 9,416 workstation rows; 26,858 routing steps; largest BOM = 212 items. Keep 500-row targets for growth/headroom.

### Preserve

- header: product name, BOM ident, revision label, prototype flag
- item fields: ident, sample ID, drawing number, supplier, warehouse position, external part number, material, polus, description, additional info, quantity
- per-item workstation assignment + duration
- checklist assignment per workstation
- production-line routing, workstation order, deadlines, dependencies, parallel/connected workstations
- readiness: info, data, checklist, deadline
- Excel import
- production-use lock

### Fix

- Current manual entry = large detached form above table; row edit scrolls user to top.
- Current row save = separate `bom_data` + `bom_workstation` requests; partial row possible.
- Current row edit = row update + workstation update + header revision update + refresh.
- Current Excel import = sequential loop; ~`1 + 2N` writes for `N` rows.
- Current workstation storage = wide table with repeated columns per workstation; hard to extend/query.
- Current user-visible revision string manually bumped; concurrency protection ⊥.
- Current BOM screens use local state + refresh; BOM realtime/conflict handling ⊥.
- Current header approval gate blocks all row work and header becomes locked.
- Current readiness/checklist/deadline updates can partially succeed across requests.
- Current creation/edit collaboration tests ⊥.

### Performance Targets

- 100-row paste/import → 1 API command; atomic; p95 ≤ 5 s in test environment.
- 500-row BOM snapshot → editor usable p95 ≤ 2 s in test environment.
- committed edit → collaborator visible p95 ≤ 500 ms.
- common row creation via keyboard ≤ 10 s.
- no full BOM reload after normal cell/row mutation.

## Assumptions

- MVP identity: dev-only generated user ID + display name.
- Production identity: trusted JWT from auth/gateway; anonymous production edits ⊥.
- User-visible revision label ≠ concurrency version.
- `draft` editable; `published` immutable; edits create new revision; `retired` unavailable for new orders.
- BOM retire > destructive BOM delete.
- Product service remains source of BOM API + realtime events.
- Production service owns workstation/production-line catalogs + order execution in `pmt_v3_production`.
- Product BOM operations/routing store production catalog external IDs + immutable snapshots.
- Inventory service owns component master + stock in PostgreSQL `pmt_v3_inventory`.
- BOM item may reference inventory component; BOM stores component snapshot for historical/read availability.
- Direct product-service query/FK to inventory database ⊥.
- PostgreSQL database: `pmt_v3_products`.
- Single product-service instance for MVP presence. Multi-instance presence → Redis later.

## Scope

### MVP

- BOM list, search, create, open, publish, retire
- BOM header edit
- item add, edit, remove, reorder
- per-item workstation assignment + duration
- checklist assignment
- routing/deadline editor
- readiness tracking
- Excel import + spreadsheet paste
- inventory component lookup/link + historical snapshot
- bulk/fill/duplicate row actions
- simultaneous users on same BOM
- live collaborator presence
- optimistic UI + save state
- conflict detection + recovery
- reconnect catch-up
- activity history
- responsive desktop-first UI

### Later

- comments, mentions, notifications
- granular roles per BOM
- formal approval/review workflow
- revision compare + branching
- export
- inventory reservations/consumption automation
- offline editing
- Redis-backed multi-instance presence

## Architecture

### Write + Sync Flow

1. FE loads BOM snapshot via REST.
2. FE joins BOM WebSocket room.
3. User edit → optimistic local update.
4. FE sends REST command with:
   - `commandId`: retry/idempotency UUID
   - `expectedVersion`: edited entity version
   - mutation payload
5. BE validates identity, payload, state, version.
6. One DB transaction:
   - mutate source table
   - increment entity version
   - increment BOM event sequence
   - insert durable `bom_events` row
7. BE commits → broadcasts `bom:event`.
8. FE confirms pending edit + applies ordered event.
9. Sequence gap/reconnect → fetch events since last sequence; full snapshot fallback.

### Rules

- REST = only durable write path.
- WebSocket = events + presence, not direct DB writes.
- Current tables = source of truth; `bom_events` = sync/audit log, not full event sourcing.
- Same-row stale update → `409 CONFLICT`; never last-write-wins silently.
- Different-row concurrent edits proceed independently.
- Client applies events strictly by BOM sequence.
- Mutation + event ! same DB transaction.
- `commandId` unique → retries never duplicate mutation.

## Data Model

### `boms`

| column                      | shape                                               |
| --------------------------- | --------------------------------------------------- |
| `id`                        | UUID PK                                             |
| `ident`                     | text, normalized unique                             |
| `product_name`              | text                                                |
| `revision_label`            | text                                                |
| `is_prototype`              | boolean                                             |
| `lifecycle`                 | `draft` \| `published` \| `retired`                  |
| `revision_number`           | integer, `> 0`; unique with normalized ident         |
| `readiness`                 | JSONB `{info,data,checklist,deadline}`              |
| `lock_version`              | bigint, optimistic concurrency                      |
| `event_sequence`            | bigint, ordered sync cursor                         |
| `created_by` / `updated_by` | external user ID                                    |
| `created_at` / `updated_at` | timestamptz                                         |
| `published_at` / `retired_at` | nullable timestamptz                              |

### `bom_items`

| column                      | shape                 |
| --------------------------- | --------------------- |
| `id`                        | UUID PK               |
| `bom_id`                    | UUID FK → `boms`      |
| `inventory_component_id`    | nullable external UUID |
| `component_snapshot`        | nullable JSONB         |
| `ident`                     | text                  |
| `sample_id`                 | text                  |
| `drawing_number`            | text                  |
| `supplier`                  | text                  |
| `warehouse_position`        | text                  |
| `external_part_number`      | text                  |
| `material`                  | text                  |
| `polus`                     | text                  |
| `description`               | text                  |
| `additional_info`           | text                  |
| `quantity`                  | numeric, `> 0`        |
| `sort_key`                  | text, fractional rank |
| `lock_version`              | bigint                |
| `created_by` / `updated_by` | external user ID      |
| `created_at` / `updated_at` | timestamptz           |

### `bom_item_operations`

Normalized replacement for PMTV2 wide `bom_workstation` table.

| column                   | shape                        |
| ------------------------ | ---------------------------- |
| `id`                     | UUID PK                      |
| `bom_id` / `bom_item_id` | UUID FK                      |
| `workstation_id`         | external production UUID     |
| `workstation_snapshot`   | JSONB `{code,name}`           |
| `duration_seconds`       | numeric, `≥ 0`               |
| `checklist_id`           | nullable external/catalog ID |
| `lock_version`           | bigint                       |

Unique: `(bom_item_id, workstation_id)`.

### `bom_routing_steps`

| column                       | shape        |
| ---------------------------- | ------------ |
| `id`                         | UUID PK      |
| `bom_id`                     | UUID FK      |
| `workstation_id`             | external production UUID |
| `workstation_snapshot`       | JSONB `{code,name}` |
| `production_line_id`         | external production UUID |
| `production_line_snapshot`   | JSONB `{code,name}` |
| `order_in_line`              | integer      |
| `deadline`                   | numeric      |
| `start_offset` / `duration`  | numeric      |
| `connected_workstation_ids`  | JSONB UUID[] |
| `depends_on_workstation_ids` | JSONB UUID[] |
| `lock_version`               | bigint       |

### `bom_events`

| column                    | shape                      |
| ------------------------- | -------------------------- |
| `id`                      | bigserial PK               |
| `bom_id`                  | UUID FK                    |
| `sequence`                | bigint; unique per BOM     |
| `command_id`              | UUID unique                |
| `actor_id` / `actor_name` | change author              |
| `type`                    | stable event name          |
| `entity_id`               | BOM/item ID                |
| `payload`                 | JSONB client event payload |
| `created_at`              | timestamptz                |

Indexes:

- `boms(normalized ident, revision_number)`, `boms(updated_at)`, `boms(retired_at)`
- `bom_items(bom_id, sort_key)`
- `bom_items(inventory_component_id)`
- `bom_item_operations(bom_item_id, workstation_id)`
- `bom_routing_steps(bom_id, production_line, order_in_line)`
- `bom_events(bom_id, sequence)`

## Interfaces

### REST

```text
GET    /api/boms?query=&cursor=                 → BOM summaries
POST   /api/boms                                → create BOM
GET    /api/boms/:bomId                         → snapshot + eventSequence
PATCH  /api/boms/:bomId                         → edit header/status
DELETE /api/boms/:bomId                         → retire BOM

POST   /api/boms/:bomId/items                   → add item
POST   /api/boms/:bomId/items/bulk              → atomic paste/import/upsert
PATCH  /api/boms/:bomId/items/:itemId           → edit item
DELETE /api/boms/:bomId/items/:itemId           → remove item
POST   /api/boms/:bomId/items/:itemId/reorder   → move item

PUT    /api/boms/:bomId/items/:itemId/operations → replace item workstation operations
PUT    /api/boms/:bomId/checklists/bulk          → bulk checklist assignment
PUT    /api/boms/:bomId/routing                   → atomic routing/deadline replace

GET    /api/boms/:bomId/events?after=<sequence> → reconnect catch-up
```

Mutation body common fields:

```json
{
  "commandId": "uuid",
  "expectedVersion": 4,
  "data": {}
}
```

Errors:

```text
400 VALIDATION_ERROR
401 UNAUTHENTICATED
403 FORBIDDEN
404 NOT_FOUND
409 VERSION_CONFLICT
409 COMMAND_CONFLICT
500 INTERNAL_ERROR
```

### WebSocket

Client:

```text
bom:join     { bomId, lastSequence }
bom:leave    { bomId }
presence:set { bomId, focus? }
```

Server:

```text
bom:event       { bomId, sequence, type, entityId, payload, actor, occurredAt }
presence:list   { bomId, users[] }
presence:joined { bomId, user }
presence:left   { bomId, userId }
sync:required   { bomId, expectedSequence }
```

## Frontend UX

Routes:

```text
/boms          → list/search/create
/boms/[bomId]  → collaborative editor
```

Editor layout:

- top bar: BOM identity, status, connection state, collaborator avatars
- editable header: product name, ident, revision label, prototype, readiness
- spreadsheet grid: direct cell editing + frozen columns + virtual rows
- operation drawer/grid: workstation assignment + durations
- checklist bulk panel
- routing/deadline board + Gantt preview
- side panel: activity history
- conflict banner/dialog: server value vs local value, retry/discard

Edit states:

```text
clean → pending → saved
                 → conflict
                → failed/retry
```

UX rules:

- optimistic edit immediate
- debounce text saves; blur/Enter flushes
- quantity validated before send
- Enter adds row; Tab/arrow keys navigate cells
- multi-cell clipboard paste + validation preview
- import validates first; commit = one atomic command
- duplicate row, fill down, apply workstation/checklist to selected rows
- optional columns hidden without losing data
- draft created immediately; header remains editable
- collaborator edits highlighted briefly
- collaborator presence shows focused cell/panel
- offline/disconnected state visible
- destructive actions require confirmation
- focus preserved after remote updates
- full keyboard add/edit/navigation supported

## Backend Modules

```text
domain/bom/
application/bom/
infrastructure/persistence/sequelize/bom/
interfaces/http/bom/
interfaces/realtime/bom/
```

Required services:

- `BomRepository`
- `BomEventRepository`
- `BomCommandService`
- `BomRealtimePublisher`
- `IdentityProvider`
- `BomImportService`
- `InventoryComponentClient`

Keep domain/framework boundary: domain imports ⊥ Express, Sequelize, Socket.IO.

## Invariants

- V1: ∀ durable mutation → actor identity + `commandId`.
- V2: ∀ durable mutation → source change + event row in one transaction.
- V3: stale `expectedVersion` → `409 VERSION_CONFLICT`; persisted state unchanged.
- V4: duplicate `commandId` → original result/event; duplicate mutation ⊥.
- V5: ∀ BOM event sequence strictly increasing + unique.
- V6: client sequence gap → catch-up/full resync before later event apply.
- V7: invalid lifecycle transition → `409 LIFECYCLE_CONFLICT`.
- V8: published/retired BOM mutation ⊥; edit → new draft revision.
- V9: item quantity finite + `> 0`.
- V10: malformed/invalid request → 4xx; never 500.
- V11: disconnect/reconnect → no accepted edit lost.
- V12: remote event never steals active input focus.
- V13: item + operations create/update → one transaction; partial row ⊥.
- V14: bulk import invalid row → no rows committed.
- V15: user revision label change independent from `lock_version`.
- V16: production order references immutable published BOM snapshot; live BOM mutation cannot affect order.
- V17: readiness derived/updated from committed BOM state; false-ready ⊥.
- V18: workstation catalog extension → schema migration ⊥.
- V19: inventory component edit/archive → existing BOM snapshot unchanged.
- V20: inventory service unavailable → existing BOM snapshot read succeeds.
- V21: production catalog edit/archive → existing BOM operation/routing snapshots unchanged.
- V22: direct product-service query/FK to production database ⊥.

## Delivery Plan

Status: `[ ]` todo, `[~]` active, `[x]` done.

### Phase 0: Decisions + Foundation

- [ ] P0.1 Confirm PMTV2 compatibility matrix + intentional behavior changes.
- [x] P0.2 Confirm lifecycle/readiness/publish-retire + actor identity contract.
- [ ] P0.3 Add local product-service `.env` using `pmt_v3_products`; secrets untracked.
- [x] P0.4 Replace `DB_SYNC` production path with repeatable migrations.
- [ ] P0.5 Add test DB/schema isolation; tests never mutate shared `pmt_v3_products`.
- [ ] P0.6 Add test runner, formatting, lint, CI.
- [ ] P0.7 Confirm inventory component contract + timeout/outage behavior.

Gate: migration/test commands documented + repeatable.

### Phase 1: BOM Persistence + Domain

- [x] P1.1 Create BOM, item/component-reference, external production snapshots, operation, routing, event migrations + indexes.
- [ ] P1.2 Implement BOM/item entities + validation.
- [ ] P1.3 Implement operation/routing entities + validation.
- [ ] P1.4 Implement repositories + transactional command service.
- [ ] P1.5 Implement idempotency + optimistic version checks.
- [ ] P1.6 Unit/integration tests for V1-V5, V7-V10, V13-V20.

Gate: concurrent repository tests prove no silent overwrite/duplicate commands.

### Phase 2: REST API

- [ ] P2.1 Add identity middleware; dev identity adapter + production JWT contract.
- [ ] P2.2 Add BOM list/create/get/update/publish/retire endpoints.
- [ ] P2.3 Add item create/update/remove/reorder endpoints.
- [ ] P2.4 Add atomic item+operations + bulk import endpoints.
- [ ] P2.5 Add checklist + routing/deadline endpoints.
- [ ] P2.6 Add event catch-up endpoint.
- [ ] P2.7 Add request schema validation + consistent 4xx errors.
- [ ] P2.8 Add inventory component client adapter + snapshot validation.
- [ ] P2.9 API contract/integration + performance tests.

Gate: complete BOM editable via API; malformed/stale commands safely rejected.

### Phase 3: Realtime Collaboration

- [ ] P3.1 Add Socket.IO server + authenticated BOM rooms.
- [ ] P3.2 Broadcast committed durable events.
- [ ] P3.3 Add ephemeral presence/focus tracking.
- [ ] P3.4 Add join/reconnect sequence reconciliation.
- [ ] P3.5 Add two-client concurrency/reconnect tests.

Gate: two simulated clients converge after concurrent edits + reconnect.

### Phase 4: Frontend BOM Workspace

- [ ] P4.1 Add typed API client + runtime response validation.
- [ ] P4.2 Build `/boms` list/search/create page.
- [ ] P4.3 Build `/boms/[bomId]` editor shell + snapshot load.
- [ ] P4.4 Build editable header + virtual spreadsheet item grid.
- [ ] P4.5 Add keyboard navigation, row duplicate, fill-down, bulk selection.
- [ ] P4.6 Add clipboard paste + Excel validation/commit flow.
- [ ] P4.7 Add component lookup/link, operations, checklist, routing/deadline panels.
- [ ] P4.8 Add optimistic mutation state + retries.
- [ ] P4.9 Add lifecycle/readiness/publish/retire actions.

Gate: one user completes full PMTV2-equivalent BOM workflow; 100-row import target met.

### Phase 5: Collaboration UX

- [ ] P5.1 Add socket client + ordered event reducer.
- [ ] P5.2 Add presence avatars + focus indicators.
- [ ] P5.3 Add connection/reconnect state.
- [ ] P5.4 Add conflict resolution UI.
- [ ] P5.5 Add activity history panel.
- [ ] P5.6 Preserve focus/unsaved input across remote events.
- [ ] P5.7 Add collaborative bulk-operation progress/results.

Gate: two browser sessions edit same BOM without silent lost work.

### Phase 6: Hardening

- [ ] P6.1 Authorization + lifecycle/publish/retire enforcement.
- [ ] P6.2 Rate/body limits, CORS, safe logging.
- [ ] P6.3 Accessibility + responsive checks.
- [ ] P6.4 Browser E2E: create, concurrent edit, conflict, disconnect/reconnect.
- [ ] P6.5 Load test: target concurrent collaborators/BOM + active BOMs.
- [ ] P6.6 Metrics: command latency, conflicts, socket count, reconnects, errors.

Gate: CI green; defined load target met; no critical/high security finding.

### Phase 7: Release

- [ ] P7.1 Backup + migration rollback procedure.
- [ ] P7.2 Staging migration + multi-user acceptance test.
- [ ] P7.3 Production config: JWT, DB, CORS, socket proxy/timeouts.
- [ ] P7.4 Deploy BE then FE.
- [ ] P7.5 Monitor errors/conflicts/latency; rollback criteria ready.

Gate: production smoke test + multi-user edit verified.

## Required Test Scenarios

1. Users A/B add different items simultaneously → both persist.
2. Users A/B edit different items simultaneously → both persist.
3. Users A/B edit same item from same version → first persists; second gets conflict.
4. Same command retried after timeout → one mutation/event only.
5. Client misses events then reconnects → catches up + converges.
6. Client sequence gap → resync before later event apply.
7. User edits published/retired BOM → rejected; new revision required.
8. Invalid/malformed payload → 4xx.
9. Remote edit arrives while local cell focused → focus/input preserved.
10. Product service restarts after committed edit → snapshot/event history intact.
11. Item+operations command fails midway → neither persists.
12. 100-row import contains invalid row → zero rows persist; errors identify cells.
13. Two users paste different row blocks simultaneously → both blocks persist.
14. Workstation added to catalog → usable without schema migration.
15. Published BOM edit → rejected; released production snapshot unchanged.
16. Checklist/routing save → atomic + realtime.
17. Linked inventory component renamed/archived → existing BOM snapshot unchanged.
18. Inventory service unavailable → existing BOM opens from snapshot.
19. Production catalog renamed/archived → existing BOM operation/routing snapshots unchanged.

## Definition Of Done

- all V1-V22 enforced + tested
- two-user E2E passes reliably
- no silent overwrite
- no accepted edit lost on reconnect
- database migrations repeatable + rollback documented
- API/socket contracts documented
- CI runs unit, integration, E2E, build, lint
- staging acceptance signed off before production
