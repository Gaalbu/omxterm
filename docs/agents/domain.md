# Domain references

OMXTerm uses three shared technical references to document product design and behavior:

- [`CONTEXT.md`](../../CONTEXT.md) — glossary of core domain terms used across code and docs.
- [`docs/spec.md`](../spec.md) — observable behavior, schemas, security boundaries, and known limitations.
- [`docs/adr/`](../adr/README.md) — Architecture Decision Records explaining key design tradeoffs.

When changing observable behavior, update the relevant sections of `docs/spec.md`, `CONTEXT.md`, ADRs, and user guides in the same commit. Keep documentation focused on current behavior rather than historical changelogs; Git history and pull requests preserve past context.
