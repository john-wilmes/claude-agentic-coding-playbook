#!/usr/bin/env bash
set -euo pipefail

# PHI sanitization using Microsoft Presidio.
# Processes files in-place, replacing PII/PHI with typed placeholders.
#
# Usage: sanitize.sh <file> [file...]
# Called by pre-commit-sanitize hook on staged investigation files.
# Config: ~/.claude/templates/investigation/presidio.yaml

CONFIG="${HOME}/.claude/templates/investigation/presidio.yaml"

# Locate Python: project venv (Windows then Unix), then system python3
PYTHON=""
if [ -d ".venv" ]; then
    if [ -x ".venv/Scripts/python.exe" ]; then
        PYTHON=".venv/Scripts/python.exe"
    elif [ -x ".venv/bin/python" ]; then
        PYTHON=".venv/bin/python"
    fi
fi
if [ -z "$PYTHON" ]; then
    PYTHON="python3"
fi

if [ $# -eq 0 ]; then
    echo "Usage: $0 <file> [file...]" >&2
    exit 1
fi

if [ ! -f "$CONFIG" ]; then
    echo "Warning: No presidio.yaml found at $CONFIG. Skipping PHI sanitization." >&2
    exit 0
fi

# Check if Presidio is importable
if ! "$PYTHON" -c "import presidio_analyzer, presidio_anonymizer" 2>/dev/null; then
    echo "Warning: Presidio not installed. Skipping PHI sanitization." >&2
    echo "Install with: pip install presidio-analyzer presidio-anonymizer" >&2
    exit 0
fi

CHANGED=0

for FILE in "$@"; do
    if [ ! -f "$FILE" ]; then
        continue
    fi

    # Skip binary files. If 'file' command is not available, assume text.
    if command -v file >/dev/null 2>&1; then
        if file "$FILE" | grep -qv text; then
            continue
        fi
    fi

    ORIGINAL_HASH=$(sha256sum "$FILE" | cut -d' ' -f1)

    "$PYTHON" - "$CONFIG" "$FILE" <<'PYEOF' || { echo "Warning: Presidio failed on $FILE, skipping." >&2; continue; }
import sys
import yaml
from presidio_analyzer import AnalyzerEngine, PatternRecognizer, Pattern
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

config_path = sys.argv[1]
file_path = sys.argv[2]

# Load config
with open(config_path, 'r') as f:
    config = yaml.safe_load(f)

# Set up analyzer
analyzer = AnalyzerEngine()

# Add custom recognizers if configured
for custom in config.get('analyzer', {}).get('custom_recognizers', []):
    patterns = [Pattern(p['name'], p['regex'], p['score']) for p in custom.get('patterns', [])]
    recognizer = PatternRecognizer(
        supported_entity=custom['supported_entity'],
        patterns=patterns,
        context=custom.get('context', [])
    )
    analyzer.registry.add_recognizer(recognizer)

# Read file
with open(file_path, 'r', encoding='utf-8') as f:
    text = f.read()

# Analyze — use entities list from config, fall back to all detected
entities = config.get('analyzer', {}).get('entities', [])
results = analyzer.analyze(text=text, entities=entities, language='en')

if not results:
    sys.exit(0)

# Build operator config from yaml
operators = {}
for entity, op in config.get('anonymizer', {}).get('operators', {}).items():
    params = {k: v for k, v in op.items() if k != 'type'}
    operators[entity] = OperatorConfig(op['type'], params)

# Anonymize
anonymizer = AnonymizerEngine()
anonymized = anonymizer.anonymize(text=text, analyzer_results=results, operators=operators)

# Write back
with open(file_path, 'w', encoding='utf-8') as f:
    f.write(anonymized.text)
PYEOF

    NEW_HASH=$(sha256sum "$FILE" | cut -d' ' -f1)
    if [ "$ORIGINAL_HASH" != "$NEW_HASH" ]; then
        echo "Sanitized PHI in: $FILE"
        CHANGED=1
    fi
done

exit 0
