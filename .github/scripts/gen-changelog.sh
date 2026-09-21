#!/usr/bin/env bash
# Stitch the per-release notes in changelog/ into a single, browsable CHANGELOG.md,
# newest first. The per-release files stay the one home you edit; this index is a
# generated artifact, rebuilt on every release by release.yml. Do not hand-edit the
# output.
#
# Usage: gen-changelog.sh [changelog-dir]   # prints CHANGELOG.md to stdout
set -euo pipefail

dir="${1:-changelog}"

# Shipped-release files start with a version digit; README.md / TEMPLATE.md / next.md
# start with a letter and are staging or convention docs, not releases.
mapfile -t files < <(
  for f in "$dir"/[0-9]*.md; do
    [ -e "$f" ] || continue
    v=$(basename "$f" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+' || true)
    [ -n "$v" ] || continue
    printf '%s\t%s\n' "$v" "$f"
  done | sort -V -r | cut -f2-
)

echo "# Changelog"
echo
echo "Every shipped release of Orange Copy Paste, newest first. Generated from the"
echo "per-release files in [\`changelog/\`](changelog/) by"
echo "\`.github/scripts/gen-changelog.sh\` on each release. Do not edit by hand; edit the"
echo "source file in \`changelog/\` instead."

first=1
for f in "${files[@]}"; do
  if [ "$first" -eq 0 ]; then
    echo
    echo "---"
  fi
  first=0
  echo
  # Demote the file's single top-level "# " title to "## " so CHANGELOG.md keeps one
  # "# " heading. "### New/Improved/Fixed" lines are untouched (they are not "# ").
  sed -e '0,/^# /s/^# /## /' "$f"
done
