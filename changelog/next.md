This release points the in-app updater at the current release location.

### Fixed
- The updater now checks for new versions in the right place, so update checks and downloads work correctly.

### Internal
- Publish releases from the app repo instead of a separate releases repo; the stable and beta update feeds and the download links now target the app repo.
- Convert the ASCII architecture diagrams in the READMEs and docs to themed Mermaid.
- Add a generated CHANGELOG.md index and keep every release instead of pruning old ones.
