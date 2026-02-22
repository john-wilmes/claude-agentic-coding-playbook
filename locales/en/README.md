# locales/en — English Source Content

This directory contains the English (source) version of all translatable content
in the Agentic Coding Playbook.

## Structure

The primary translatable document is `docs/best-practices.md`, located at the
repository root. A copy (or symlink) of that file belongs here as the canonical
source for translation work.

## Adding a Translation

Create a parallel directory for the target language using its
[BCP 47 language tag](https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry)
as the directory name:

```
locales/
  en/          # English source (this directory)
  es/          # Spanish
  ja/          # Japanese
  zh-Hans/     # Simplified Chinese
```

Each locale directory should mirror the structure of `locales/en/`. For example,
if this directory contains `best-practices.md`, a Spanish translation would live
at `locales/es/best-practices.md`.

## Translation Guidelines

See [`docs/TRANSLATING.md`](../../docs/TRANSLATING.md) for full guidelines,
including citation handling, section structure requirements, and how to submit
a translation PR.
