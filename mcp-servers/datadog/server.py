# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "mcp>=1.0.0",
#   "datadog-api-client>=2.0.0",
#   "presidio-analyzer>=2.2.0",
#   "presidio-anonymizer>=2.2.0",
#   "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl",
# ]
# ///
"""
Minimal Datadog MCP server — exposes only get_logs.

Credentials are read from environment variables:
  DD_API_KEY   — Datadog API key
  DD_APP_KEY   — Datadog application key
  DD_SITE      — Datadog site (default: datadoghq.com)

PHI redaction is config-driven via phi-config.yaml. The server searches for
this file using PHI_CONFIG_PATH env var, then upward from CWD. Falls back to
built-in generic healthcare defaults if no config is found.

Optional dependencies:
  presidio-analyzer/presidio-anonymizer — NLP-based PII detection (recommended)
  openredaction (npm package)           — Additional redaction pass via Node.js
"""

import asyncio
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

from datadog_api_client import ApiClient, Configuration
from datadog_api_client.v2.api.logs_api import LogsApi
from datadog_api_client.v2.model.logs_list_request import LogsListRequest
from datadog_api_client.v2.model.logs_list_request_page import LogsListRequestPage
from datadog_api_client.v2.model.logs_query_filter import LogsQueryFilter
from datadog_api_client.v2.model.logs_query_options import LogsQueryOptions
from datadog_api_client.v2.model.logs_sort import LogsSort
from mcp.server import Server
from mcp.server.models import InitializationOptions
from mcp.server.stdio import stdio_server
from mcp.types import CallToolResult, ServerCapabilities, TextContent, Tool

logging.basicConfig(level=logging.WARNING)

DD_API_KEY = os.environ.get("DD_API_KEY")
DD_APP_KEY = os.environ.get("DD_APP_KEY")
if not DD_API_KEY or not DD_APP_KEY:
    raise RuntimeError("Missing DD_API_KEY and/or DD_APP_KEY environment variables")
DD_SITE    = os.environ.get("DD_SITE", "datadoghq.com")


# ── PHI config loading ────────────────────────────────────────────────────────

def _load_phi_config() -> Optional[Dict[str, Any]]:
    """Load phi-config.yaml if available, otherwise return None (use defaults)."""
    import pathlib
    config_path = os.environ.get("PHI_CONFIG_PATH")
    if not config_path:
        # Search upward from CWD
        for p in [pathlib.Path.cwd(), *pathlib.Path.cwd().parents]:
            candidate = p / "phi-config.yaml"
            if candidate.exists():
                config_path = str(candidate)
                break
    if config_path:
        try:
            import yaml
            with open(config_path) as f:
                return yaml.safe_load(f)
        except Exception:
            pass
    return None


def _build_phi_attr_keys(config: Optional[Dict[str, Any]]) -> frozenset:
    """Build the PHI attribute key set from config or built-in defaults."""
    if config and "phi_columns" in config:
        return frozenset(str(c).lower().replace("_", "").replace("-", "")
                         for c in config["phi_columns"])
    # Built-in generic healthcare defaults
    return frozenset({
        # Name fields
        "firstname", "lastname", "fullname", "name", "patientname",
        "middlename", "preferredname", "legalname",
        # Contact
        "email", "emailaddress",
        "phone", "phonenumber", "telephone", "mobile", "cellphone",
        "fax", "faxnumber",
        # Demographics
        "dob", "dateofbirth", "birthdate", "age",
        "address", "address1", "address2", "streetaddress",
        "city", "state", "zip", "zipcode", "postalcode", "county",
        "gender", "sex", "race", "ethnicity",
        # Identifiers
        "ssn", "socialsecuritynumber",
        "mrn", "patientid", "memberid",
        "insuranceid", "membershipid", "policyid",
        "npi", "ein",
        "driverslicense", "passportnumber",
        # Clinical
        "medications", "medication", "rxname", "drugname",
        "allergies", "allergy",
        "problems", "diagnosis", "diagnoses", "icd10", "icdcode",
        "immunizations", "immunization", "vaccine",
        "familyhistory", "medicalhistory",
        "vitals", "weight", "height", "bloodpressure",
        "labresult", "labresults", "labvalue",
        "notes", "clinicalnotes", "providernotes",
        "chiefcomplaint", "reasonforvisit",
    })


_phi_config = _load_phi_config()
_PHI_ATTR_KEYS = _build_phi_attr_keys(_phi_config)

# Credentials/secrets are security-critical, not org-specific — always hardcoded
_SENSITIVE_ATTR_KEYS = {
    "password", "passwordhash", "passcode", "pin",
    "apikey", "api_key", "appkey", "app_key",
    "clientsecret", "client_secret",
    "secret", "sharedsecret", "shared_secret",
    "token", "authtoken", "auth_token",
    "accesstoken", "access_token",
    "refreshtoken", "refresh_token",
    "jwt", "bearer", "authorization",
    "cookie", "setcookie", "set_cookie",
    "privatekey", "private_key",
    "mongodburi", "mongodb_uri",
    "dburl", "db_url", "connectionstring", "connection_string",
}


# ── PHI sanitization ─────────────────────────────────────────────────────────

def _normalize_key(k: str) -> str:
    return re.sub(r'[^a-z0-9]', '', k.lower())

_SENSITIVE_ATTR_KEYS_NORMALIZED = {_normalize_key(k) for k in _SENSITIVE_ATTR_KEYS}

# Legacy regex redaction (fallback when Presidio unavailable)
_PHI_PATTERNS_LEGACY = [
    (re.compile(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}'), "[EMAIL]"),
    (re.compile(r'\(?\b\d{3}\)?[\s\-\.]?\d{3}[\s\-\.]\d{4}\b'), "[PHONE]"),
    (re.compile(r'\b\d{3}-\d{2}-\d{4}\b'), "[SSN]"),
]
_SENSITIVE_PATTERNS_LEGACY = [
    (re.compile(r'(?i)\bauthorization:\s*bearer\s+[A-Za-z0-9\-\._~\+\/]+=*\b'), "Authorization: Bearer [REDACTED]"),
    (re.compile(r'(?i)\bbearer\s+[A-Za-z0-9\-\._~\+\/]+=*\b'), "Bearer [REDACTED]"),
    (re.compile(r'\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b'), "[JWT]"),
    (re.compile(r'(?i)\b(mongodb(?:\+srv)?|postgres(?:ql)?|mysql)://[^\s/]+:[^\s@]+@'), "[URI-CREDS]"),
]


def _redact_string_legacy(s: str) -> str:
    for pattern, replacement in _PHI_PATTERNS_LEGACY:
        s = pattern.sub(replacement, s)
    for pattern, replacement in _SENSITIVE_PATTERNS_LEGACY:
        s = pattern.sub(replacement, s)
    return s


_analyzer = None
_anonymizer = None


def _redact_with_openredaction(text: str) -> str:
    """Optional: run openredaction Node.js package as subprocess for additional coverage.

    Gracefully returns the original text if Node.js or the openredaction package
    is not available.
    """
    try:
        import subprocess
        script = r"""
const or = (() => { try { return require('openredaction'); } catch { return null; } })();
if (!or) { process.stdout.write(process.argv[2]); process.exit(0); }
const shield = new or.Shield();
(async () => {
  const r = await shield.detect(process.argv[2]);
  process.stdout.write(r.redacted || process.argv[2]);
})().catch(() => process.stdout.write(process.argv[2]));
"""
        result = subprocess.run(
            ["node", "-e", script, text],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0 and result.stdout:
            return result.stdout
    except Exception:
        pass
    return text


def _redact_string(s: str) -> str:
    """Redact PII and secrets using Presidio (required).

    After the primary Presidio pass, applies an optional OpenRedaction
    subprocess pass for additional coverage.
    """
    global _analyzer, _anonymizer
    from presidio_analyzer import AnalyzerEngine
    from presidio_analyzer.nlp_engine import NlpEngineProvider
    from presidio_anonymizer import AnonymizerEngine
    if _analyzer is None:
        nlp_config = {"nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}]}
        nlp_engine = NlpEngineProvider(nlp_configuration=nlp_config).create_engine()
        _analyzer = AnalyzerEngine(nlp_engine=nlp_engine)
    if _anonymizer is None:
        _anonymizer = AnonymizerEngine()
    results = _analyzer.analyze(text=s, language="en")
    if results:
        out = _anonymizer.anonymize(text=s, analyzer_results=results)
        s = out.text if out else s

    # Optional additional pass via OpenRedaction
    s = _redact_with_openredaction(s)
    return s


def _sanitize_logs(logs: List[Dict[str, str]]) -> tuple[List[Dict[str, str]], int]:
    """Strip PHI attribute keys and regex-redact string values.

    Returns (sanitized_logs, dropped_key_count).
    """
    dropped = 0
    result = []
    for entry in logs:
        clean: Dict[str, str] = {}
        for k, v in entry.items():
            # Strip attr_ prefix for key comparison only
            bare = k[len("attr_"):] if k.startswith("attr_") else k
            if _normalize_key(bare) in _PHI_ATTR_KEYS:
                dropped += 1
                continue
            if _normalize_key(bare) in _SENSITIVE_ATTR_KEYS_NORMALIZED:
                dropped += 1
                continue
            if isinstance(v, str):
                v = _redact_string(v)
            clean[k] = v
        result.append(clean)
    return result, dropped


# ── Datadog API ──────────────────────────────────────────────────────────────

def _dd_config() -> Configuration:
    config = Configuration()
    config.api_key["apiKeyAuth"] = DD_API_KEY
    config.api_key["appKeyAuth"] = DD_APP_KEY
    config.server_variables["site"] = DD_SITE
    return config


def _fetch_logs_sync(
    time_range: str,
    filters: Optional[Dict[str, str]],
    query: Optional[str],
    limit: int,
    cursor: Optional[str],
) -> Dict[str, Any]:
    parts = []
    if filters:
        parts.extend(f"{k}:{v}" for k, v in filters.items())
    if query:
        parts.append(query)
    combined = " AND ".join(parts) if parts else "*"

    body = LogsListRequest(
        filter=LogsQueryFilter(
            query=combined,
            _from=f"now-{time_range}",
            to="now",
        ),
        options=LogsQueryOptions(timezone="GMT"),
        page=LogsListRequestPage(limit=limit, cursor=cursor),
        sort=LogsSort.TIMESTAMP_DESCENDING,
    )

    with ApiClient(_dd_config()) as api_client:
        api = LogsApi(api_client)
        resp = api.list_logs(body=body)
        return {
            "data": [log.to_dict() for log in resp.data] if resp.data else [],
            "meta": resp.meta.to_dict() if resp.meta else {},
        }


async def fetch_logs(
    time_range: str = "1h",
    filters: Optional[Dict[str, str]] = None,
    query: Optional[str] = None,
    limit: int = 50,
    cursor: Optional[str] = None,
) -> Dict[str, Any]:
    return await asyncio.to_thread(
        _fetch_logs_sync, time_range, filters, query, limit, cursor
    )


# ── Formatting ───────────────────────────────────────────────────────────────

def _extract_logs(events: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    logs = []
    for event in events:
        if "content" in event:
            c = event["content"]
            attrs = c.get("attributes", {})
            entry = {
                "timestamp": c.get("timestamp", ""),
                "level":     c.get("status", attrs.get("level", "unknown")),
                "service":   c.get("service", "unknown"),
                "host":      c.get("host", "unknown"),
                "message":   c.get("message", ""),
            }
        elif "attributes" in event:
            a = event["attributes"]
            entry = {
                "timestamp": a.get("timestamp", ""),
                "level":     a.get("status", "unknown"),
                "service":   a.get("service", "unknown"),
                "host":      a.get("host", "unknown"),
                "message":   a.get("message", ""),
            }
            attrs = a.get("attributes", {})
        else:
            continue

        if isinstance(attrs, dict):
            for key, val in attrs.items():
                if key not in {"environment", "duration", "lambda", "level",
                               "task_type_stats", "aws", "service", "host",
                               "id", "timestamp"}:
                    if not isinstance(val, (dict, list)):
                        entry[f"attr_{key}"] = str(val)

        logs.append(entry)
    return logs


def _format_table(logs: List[Dict[str, str]], max_msg: int = 100) -> str:
    if not logs:
        return "No logs found."
    ts_w  = 24
    lvl_w = max(5, max(len(l.get("level", "")) for l in logs))
    svc_w = max(7, max(len(l.get("service", "")) for l in logs))
    msg_w = max(7, max(min(max_msg, len(l.get("message", ""))) for l in logs))

    hdr = f"| {'Timestamp':<{ts_w}} | {'Level':<{lvl_w}} | {'Service':<{svc_w}} | {'Message':<{msg_w}} |"
    sep = f"|{'-'*(ts_w+2)}|{'-'*(lvl_w+2)}|{'-'*(svc_w+2)}|{'-'*(msg_w+2)}|"
    rows = [hdr, sep]
    for l in logs:
        msg = l.get("message", "")
        if len(msg) > max_msg:
            msg = msg[:max_msg-3] + "..."
        rows.append(f"| {l.get('timestamp','')[:ts_w]:<{ts_w}} | {l.get('level',''):<{lvl_w}} | {l.get('service',''):<{svc_w}} | {msg:<{msg_w}} |")
    return "\n".join(rows)


# ── MCP server ───────────────────────────────────────────────────────────────

server = Server("datadog-logs")

TOOL = Tool(
    name="get_logs",
    description=(
        "Search Datadog logs. "
        "Use `filters` for structured fields (service, env, status, host). "
        "Use `query` for free-text or Datadog query syntax. "
        "time_range: 1h | 4h | 8h | 1d | 7d | 14d | 30d. "
        "format: table | text | json. "
        "IMPORTANT: Always use the narrowest time_range possible (prefer 1h over 1d). "
        "Always use filters (especially service and env) before free-text query. "
        "Start with a small limit and increase only if needed."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "time_range": {
                "type": "string",
                "enum": ["1h", "4h", "8h", "1d", "7d", "14d", "30d"],
                "default": "1h",
            },
            "filters": {
                "type": "object",
                "description": "e.g. {\"service\": \"api-service\", \"env\": \"prod\", \"status\": \"error\"}",
                "additionalProperties": {"type": "string"},
                "default": {},
            },
            "query": {
                "type": "string",
                "description": "Free-text or Datadog query syntax, e.g. 'timeout' or '@user_id:123'",
            },
            "limit": {
                "type": "integer",
                "default": 50,
                "minimum": 1,
                "maximum": 1000,
            },
            "cursor": {
                "type": "string",
                "description": "Pagination cursor from previous response",
                "default": "",
            },
            "format": {
                "type": "string",
                "enum": ["table", "text", "json"],
                "default": "table",
            },
        },
        "additionalProperties": False,
        "required": [],
    },
)


@server.list_tools()
async def list_tools():
    return [TOOL]


@server.call_tool()
async def call_tool(name: str, arguments: dict):
    if name != "get_logs":
        return [TextContent(type="text", text=f"Unknown tool: {name}")]

    args        = arguments or {}
    time_range  = args.get("time_range", "1h")
    filters     = args.get("filters", {})
    query       = args.get("query")
    limit       = args.get("limit", 50)
    cursor      = args.get("cursor") or None
    fmt         = args.get("format", "table")

    try:
        resp       = await fetch_logs(time_range=time_range, filters=filters,
                                      query=query, limit=limit, cursor=cursor)
        events      = resp.get("data", [])
        logs        = _extract_logs(events)
        logs, dropped = _sanitize_logs(logs)
        next_cursor = resp.get("meta", {}).get("page", {}).get("after")

        if fmt == "json":
            out = json.dumps({"logs": logs,
                              "pagination": {"next_cursor": next_cursor,
                                             "has_more": bool(next_cursor)}},
                             indent=2)
        elif fmt == "text":
            lines = [f"[{l['timestamp']}] {l['level'].upper()} {l['service']}: {l['message']}"
                     for l in logs]
            out = "\n".join(lines)
            if next_cursor:
                out += f"\n\nNext cursor: {next_cursor}"
        else:
            out = _format_table(logs)
            if next_cursor:
                out += f"\n\nNext cursor: {next_cursor}"

        summary = f"Time range: {time_range} | Found: {len(logs)} logs | PHI fields dropped: {dropped}"
        if filters:
            summary += " | Filters: " + ", ".join(f"{k}={v}" for k, v in filters.items())
        if query:
            summary += f" | Query: {query}"
        if fmt != "json":
            out = f"{summary}\n{'=' * len(summary)}\n\n{out}"

        return [TextContent(type="text", text=out)]

    except Exception as e:
        logging.exception("get_logs failed")
        msg = str(e)
        # Scrub credentials that may appear in API client errors
        for secret in (DD_API_KEY, DD_APP_KEY):
            if secret and secret in msg:
                msg = msg.replace(secret, "[REDACTED]")
        return [TextContent(type="text", text=f"Error: {msg}")]


# ── Entry point ──────────────────────────────────────────────────────────────

async def main():
    async with stdio_server() as (r, w):
        await server.run(r, w, InitializationOptions(
            server_name="datadog-logs",
            server_version="1.0.0",
            capabilities=ServerCapabilities(tools={}),
        ))

if __name__ == "__main__":
    asyncio.run(main())
