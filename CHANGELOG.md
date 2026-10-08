# Changelog

## 0.7.0 — 2026-10-08

### Added

- Resource identity records with purpose, brand, tags, canonical keys and reuse rules. Studio, AI context, Node and `aru resources` expose the same document inventory.
- Editable resource reuse with independent gradients and source lineage. Copies preserve the registered identity without replacing the original.
- Shared production briefs, subject reference discovery and icon exploration. UI controls and indicators have a distinct purpose from app icons.
- Rounded outline MusicArt profile; the catalog now contains 23 style profiles and five material finishes.
- Provider model selectors, custom model IDs, collapsible panels and active project/document context.

### Changed

- Separate Create, Refine and Consult assistant flows with captured edit scope and operation validation. Small packs use the same batch production flow as large packs.
- Batch inventory survives appearance changes and unrelated edits. Geometry changes require explicit revalidation, and incomplete jobs retain checkpoints and reasons for pausing.
- Refinement protects resource identity and semantic structure; rejected redraws can receive one bounded repair attempt.
- Layer virtualization, parent indexing and render/context caching reduce overhead in large workspaces. Pan avoids redundant layout writes.
- Material rendering uses output resolution instead of enlarging low-resolution intermediates; ZIP export supports individual PNG, SVG and ARU assets.
- Desktop and npm version metadata are aligned at 0.7.0.

### Validation and scope

See [production QA](docs/qa-produccion-0.7.md) for checks and limits. Resource catalogs are local to a document and copies are independent. Style profiles are visual directions, not platform certifications. Material effects are 2D. Large-document edits can still incur SVG reconstruction costs.
