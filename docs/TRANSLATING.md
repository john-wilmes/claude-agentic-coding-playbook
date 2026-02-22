# Translation Guidelines

## Overview

The Agentic Coding Playbook welcomes translations to make its content accessible
to developers who prefer to read in their native language. Translations are
community contributions and are maintained in the `locales/` directory.

## Getting Started

1. Fork the repository.
2. Create a new directory under `locales/` named with the appropriate
   [BCP 47 language tag](https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry)
   (e.g., `locales/es/` for Spanish, `locales/ja/` for Japanese).
3. Copy `docs/best-practices.md` into your new directory and translate the prose.
4. Follow the guidelines below before opening a pull request.

## Guidelines

### What to Translate

- All prose, headings, and explanatory text.
- Section titles (maintain the same numbering and order as the English source).

### What to Leave Unchanged

- Code blocks and inline code.
- CLI commands and flags.
- Citation numbers (e.g., `[1]`, `[14]`). Do not renumber them.
- URLs. Keep all links pointing to the original English sources. If an equivalent
  source exists in the target language, you may add it in parentheses immediately
  after the English URL, but the English URL must remain present.

### Section Structure

Maintain the same section structure and numbering as the English source. Do not
merge, split, or reorder sections. This makes it easier to diff translations
against future English updates.

## Citation Handling

Do not renumber citations under any circumstances. The citation numbers in the
English source (`[1]` through `[N]`) must appear identically in every translation.
If a cited source has no equivalent in the target language, retain the English
citation as-is. You may add a translated-language source in parentheses alongside
the English one, but the English reference must remain the primary entry.

## Submitting a Translation

1. Open a pull request with the title format:

   ```
   i18n: Add {Language} translation
   ```

   Example: `i18n: Add Spanish translation`

2. Apply the `i18n` label to the pull request.
3. In the PR description, note the commit SHA of the English source file
   (`docs/best-practices.md`) that the translation is based on. This makes it
   easier to identify drift when the English version is updated.

## Keeping Translations Current

Translations should track the English source. When `docs/best-practices.md` is
updated, maintainers will open issues or tag existing translation PRs to flag
which sections changed. Translation PRs that update an existing locale should
note in the description which sections were modified and reference the diff in
the English source.

Translations that fall significantly out of date may be moved to an `archived/`
subdirectory within their locale folder until a maintainer can update them.
