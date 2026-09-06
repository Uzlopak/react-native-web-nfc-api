#!/usr/bin/env bash
set -euo pipefail

# Builds examples/nfc-rewriter for web and publishes it to the `ghpages` branch.
# Must be run from a clean master (or at least with no uncommitted changes),
# since it builds from a separate git worktree checked out at HEAD.

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
EXAMPLE_DIR="$REPO_ROOT/examples/nfc-rewriter"
WORKTREE_DIR="$(mktemp -d)"

cleanup() {
  git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || true
  rm -rf "$WORKTREE_DIR"
}
trap cleanup EXIT

echo "==> Building examples/nfc-rewriter from a clean worktree at HEAD"
git worktree add --detach "$WORKTREE_DIR" HEAD
(
  cd "$WORKTREE_DIR/examples/nfc-rewriter"
  npm install
  npm run web:build
)

DIST_DIR="$WORKTREE_DIR/examples/nfc-rewriter/dist"
if [ ! -d "$DIST_DIR" ]; then
  echo "Build failed: $DIST_DIR not found" >&2
  exit 1
fi

DIST_TMP="$(mktemp -d)"
cp -r "$DIST_DIR"/. "$DIST_TMP"/
cleanup
trap - EXIT

echo "==> Deleting existing ghpages branch (if any)"
if git show-ref --verify --quiet refs/heads/ghpages; then
  git branch -D ghpages
fi

echo "==> Creating fresh orphan ghpages branch"
GHPAGES_WORKTREE="$(mktemp -d)"
git worktree add --detach "$GHPAGES_WORKTREE" HEAD
(
  cd "$GHPAGES_WORKTREE"
  git checkout --orphan ghpages
  git rm -rf . >/dev/null
  cp -r "$DIST_TMP"/. .
  git add -A
  git commit -m "Deploy nfc-rewriter web build to ghpages"
)
git worktree remove --force "$GHPAGES_WORKTREE"
rm -rf "$GHPAGES_WORKTREE" "$DIST_TMP"

echo "==> Done. 'ghpages' branch created locally."
echo "    Push it with: git push -f origin ghpages"
