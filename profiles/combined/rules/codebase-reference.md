# Codebase Reference Template
# Copy this file to profiles/combined/rules/codebase-reference.md and fill in your own project's details.

Agent-facing reference for your project's codebase conventions. Read this before querying data or navigating repos.

## Repo Ownership

<!-- Replace with your actual repo names -->

| Repo | Role |
|------|------|
| `data-models` | Canonical source for ALL data models and database schemas. Check here first -- do not assume a schema. |
| `api-service` | REST API layer (external-facing endpoints) |
| `admin-service` | Admin/back-office application |
| `worker-service` | Background job / webhook processing pipeline |
| `worker-clients` | Adapter clients used by worker-service |
| `shared-utils` | Shared utilities used across all services |

## Collection Discriminators

Document any collections that use discriminators (e.g., `__t` in Mongoose, `type` field, single-table inheritance) and how to filter by them. This prevents the agent from querying non-existent collections.

<!-- Example: if your `users` collection stores multiple user types via a `type` field -->

```
Example:
- Admins: { type: "admin" }   (query `users`, NOT a separate `admins` collection)
- Members: { type: "member" } (query `users`, NOT a separate `members` collection)
```

Always query the base collection with the appropriate discriminator filter. Never assume a dedicated collection exists for a subtype.

## Data Access Layer Naming Pattern

Document the naming conventions for your ORM/data layer so the agent can predict file and key names.

<!-- Example for a typical ORM pattern: -->

```
- Model class: singular (e.g., Appointment, User)
- Controller file: plural (e.g., appointments.ts, users.ts)
- API file: plural (e.g., appointments.ts, users.ts)
- ORM registry key: plural camelCase (e.g., appointments, users)
```

```ts
// Example entry point:
import DataLayer from 'data-models';

DataLayer.appointments.find(...)
DataLayer.users.list(...)
```

## Known Naming Anomalies

Fill in any key/filename mismatches in your codebase here. These prevent the agent from guessing wrong names.

| Registry Key | File(s) | Deviation |
|--------------|---------|-----------|
| `example` | `examples.ts` | Plural filename, singular key |
| <!-- add your own --> | | |

**Rule**: The registry key in `index.ts` (or your equivalent) is authoritative. Never infer the key from a filename.

## Data Layer Entry Points

Document your ORM or data access entry points so the agent knows how to import and use them.

```ts
// Example:
import DataLayer from 'data-models';

DataLayer.<entityName>              // CRUD controller: .create, .update, .delete, .list, .get, .find
DataLayer.orm                       // Configured ORM instance (for transactions, direct queries)
DataLayer.transformers.query        // Query-to-database filter transformer
DataLayer.events                    // Event namespace strings
```
