# PHI-Sanitizing MCP Servers

Three MCP servers that proxy queries against healthcare data stores and strip PHI
from results before the output reaches the AI model. Each server enforces read-only
access and applies a shared PHI blocklist to column names and string values.

## Servers

| Directory | Data store | Key feature |
|-----------|-----------|-------------|
| `mongodb-sanitizer/` | MongoDB | Document-level PHI field removal + string redaction |
| `snowflake-sanitizer/` | Snowflake | Column-level PHI removal from SELECT results |
| [`datadog-sanitizer/`](datadog/README.md) | Datadog Logs | PHI stripping from unstructured log text |

## Shared Utilities (`shared/`)

All three servers import from `shared/` for consistent PHI handling:

| File | Purpose |
|------|---------|
| [`shared/phi-config-loader.js`](shared/phi-config-loader.js) | Loads `phi-config.yaml` and exports the PHI blocklist interface (`isPHI`, `isPHIInContext`, `isEntityTable`, `PHI_COLUMNS`, `PERSON_TABLES`, `ENTITY_TABLES`, `CONTEXTUAL_PHI`, `normalizeCol`) |
| [`shared/sanitizer-core.js`](shared/sanitizer-core.js) | Shared string redaction engine: Presidio NLP pass, legacy regex fallback, `collectStrings`, `applyRedacted` tree walkers |
| [`shared/phi-config.example.yaml`](shared/phi-config.example.yaml) | Documented example configuration with generic healthcare defaults |

## Configuration

PHI rules are driven by `phi-config.yaml`. The servers look for this file in order:

1. Path from `PHI_CONFIG_PATH` environment variable
2. `phi-config.yaml` in the current working directory (searched upward)
3. Built-in generic healthcare defaults (no site-specific table names)

To customize:

```bash
cp mcp-servers/shared/phi-config.example.yaml phi-config.yaml
# Edit phi-config.yaml for your schema
export PHI_CONFIG_PATH=/path/to/phi-config.yaml
```

### Config structure

```yaml
person_tables:        # Tables where 'name' column is a person's full name
  - users
  - patients

entity_tables:        # Tables with entity labels — string redaction is skipped
  - facilities
  - appointmenttypes

phi_columns:          # Column names that are always PHI (case/underscore insensitive)
  - firstname
  - lastname
  - dob
  # ...

contextual_phi:       # Columns that are PHI only when a person_table is queried
  - name
```

See [`shared/phi-config.example.yaml`](shared/phi-config.example.yaml) for the full list of fields with documentation.

## PHI Detection Layers

Each server applies up to three redaction layers in sequence:

1. **Column/field blocklist** — `phi-config.yaml` drives field-name matching
   (`normalizeCol` strips case and underscores, so `FIRST_NAME`, `firstName`,
   and `firstname` all match `firstname`)
2. **String redaction** — regex patterns for emails, phones, SSNs, JWTs, bearer
   tokens, and database URIs (always available, zero dependencies)
3. **Presidio NLP pass** — Python subprocess using
   [presidio-analyzer](https://github.com/microsoft/presidio) for name and
   address detection that regex misses (optional; gracefully skipped if not installed)

## Dependencies

`shared/sanitizer-core.js` uses `child_process` (Node stdlib) to invoke Presidio
as a subprocess. Presidio itself is optional:

```bash
pip install presidio-analyzer presidio-anonymizer
python -m spacy download en_core_web_lg
```

`shared/phi-config-loader.js` uses `js-yaml` (npm) if available, falls back to
JSON config format if not:

```bash
npm install js-yaml   # optional — enables YAML config files
```

Without `js-yaml`, name your config file `phi-config.json` instead of
`phi-config.yaml`.
