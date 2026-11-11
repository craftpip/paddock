#!/bin/sh
# Run tests against what is STAGED, not against the worktree.
#
#   scripts/test-staged.sh                 every suite (npm test)
#   scripts/test-staged.sh mission queue   only files whose name contains a word
#
# The worktree can carry unstaged or untracked work that makes a suite pass on
# code you are not committing. This materialises the git index into a throwaway
# directory inside the paddock container and runs the suites there.
set -eu
CONTAINER=${PADDOCK_CONTAINER:-paddock}
ROOT=$(git rev-parse --show-toplevel)
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"; docker exec "$CONTAINER" rm -rf /tmp/staged 2>/dev/null || true' EXIT
git -C "$ROOT" checkout-index -a --prefix="$STAGE/"
[ -f "$STAGE/src/app.js" ] || { echo "test-staged: the index has no src/app.js"; exit 2; }
docker exec "$CONTAINER" rm -rf /tmp/staged
docker cp "$STAGE/src" "$CONTAINER:/tmp/staged" >/dev/null
# The client bundle is build output and is not tracked, so the staged tree has
# none. Give it the worktree's: the freshness test then answers the question
# that matters before a commit, "was this bundle built from the STAGED source?".
if docker exec "$CONTAINER" test -d /app/public; then
  docker exec "$CONTAINER" sh -c 'cp -r /app/public /tmp/staged/public'
fi
# The staged tree has no node_modules; a missing module reads as a test
# failure, not a setup failure, so link the container's.
docker exec "$CONTAINER" sh -c 'rm -rf /tmp/staged/node_modules /tmp/staged/client/node_modules; ln -s /app/node_modules /tmp/staged/node_modules; ln -s /app/client/node_modules /tmp/staged/client/node_modules'
echo "testing the staged tree ($(git -C "$ROOT" diff --cached --stat | tail -1 | sed 's/^ *//'))"
docker exec -w /tmp/staged "$CONTAINER" node test/run-all.mjs "$@"
