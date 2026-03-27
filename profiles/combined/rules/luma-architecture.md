# Luma Architecture Reference

Agent-facing reference for Luma Health codebase conventions. Read this before querying data or navigating repos.

## Repo Ownership

| Repo | Role |
|------|------|
| `model-repository` | Canonical source for ALL data models and MongoDB schemas. Check here first — do not assume a schema. |
| `rest-service` | REST API layer (external-facing endpoints) |
| `classic-service` | Admin application |
| `integrator-service` | Integrator/webhook processing pipeline |
| `integrator-service-clients` | Adapter clients used by integrator-service |
| `integrator-api-client` | Exposes client DB functions for use by followup service |
| `luma-utils` | Shared utilities used across all services |

## User Type Discriminators (CRITICAL)

There is **no separate `providers` collection** and **no separate `patients` collection**. All user types live in the `users` collection, filtered by `type`:

- Providers: `{ type: "doctor" }`
- Patients: `{ type: "patient" }`
- Staff: `{ type: "staff" }`

Always query `users` with the appropriate `type` filter. Never assume a dedicated collection exists for a user type.

## model-repository Layer Naming Pattern

The package exports a single `ModelRepository` object. Each entity follows this pattern:

- Model class: **singular** (`Appointment`, `Provider`)
- Controller file: **plural** (`appointments.ts`, `providers.ts`)
- API file: **plural** (`appointments.ts`, `providers.ts`)
- `ModelRepository` key: **plural camelCase** (`appointments`, `providers`)

```ts
ModelRepository.appointments.find(...)
ModelRepository.providers.list(...)
```

## Known Naming Anomalies

Do not guess — use the `ModelRepository` key from `index.ts` as the authoritative name, not the filename:

| ModelRepository key | File(s) | Deviation |
|---------------------|---------|-----------|
| `insuranceVerifications` | `insurances-verifications.ts` (API) | Double-plural in filename only |
| `session` | `session.ts` (API, singular), `sessions.ts` (controller, plural) | Key is singular |
| `fileMapping` | `file-mappings.ts` | Custom singular export name |
| `hl7messages` | — | All lowercase, no camelCase (not `hl7Messages`) |
| `quickstartLibraries` | `quickstart-library.ts` (singular) | Plural key, singular filename |
| `verifiedCallerIds` | `verified-callerid.ts` | Plural key, singular filename |
| `assistant-transfer-rules.ts` | — | Only model file with a plural filename |

**Rule**: The `ModelRepository` key in `index.ts` is authoritative. Never infer the key from a filename.

## ModelRepository Entry Points

```ts
import ModelRepository from 'model-repository';

ModelRepository.<entityName>              // CRUD controller: .create, .update, .delete, .list, .get, .find
ModelRepository.mongoose                  // Configured mongoose instance (for transactions, direct queries)
ModelRepository.storageTransformers.mongo // Query-to-MongoDB filter transformer
ModelRepository.namespaces                // Event namespace strings (e.g. namespaces.appointment = "api:appointments")
```
