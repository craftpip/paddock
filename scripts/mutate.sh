#!/bin/sh
# Mutation control: prove a test bites by breaking the code it guards.
#
#   scripts/mutate.sh <file under src/> '<sed expression>' <test file> [more test files]
#   scripts/mutate.sh services/runner-view.js 's/allowed: !!allowed/allowed: true/' runner-view
#
# The mutation is applied to a COPY of the app inside the paddock container,
# never to /app: src/ is bind-mounted, so editing /app edits your worktree.
# The script refuses to report anything unless it has checked that
#   - the mutation changed the copy,
#   - the mutated file still parses (a file that fails to load turns every
#     test red, which proves nothing about the guard),
#   - the original is byte-identical afterwards.
#
# Exit 0: at least one test went red (the guard bites).
# Exit 1: every test stayed green (the guard does not bite).
# Exit 2: the control itself was invalid; nothing was measured.
set -eu
[ $# -ge 3 ] || { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
FILE=$1; EXPR=$2; shift 2
CONTAINER=${PADDOCK_CONTAINER:-paddock}
TESTS=""
for t in "$@"; do t=${t#test/}; t=${t%.test.js}; TESTS="$TESTS test/$t.test.js"; done

docker exec -i -e FILE="$FILE" -e EXPR="$EXPR" -e TESTS="$TESTS" "$CONTAINER" sh -s <<'INNER'
set -eu
COPY=/tmp/mutate-$$
trap 'rm -rf "$COPY"' EXIT
[ -f "/app/$FILE" ] || { echo "mutate: /app/$FILE does not exist"; exit 2; }
before=$(sha256sum "/app/$FILE" | cut -d' ' -f1)
mkdir -p "$COPY"
cd /app
tar cf - --exclude=./node_modules --exclude=./client/node_modules --exclude=./public --exclude=./data . | tar xf - -C "$COPY"
ln -s /app/node_modules "$COPY/node_modules"
# The client SOURCE is copied for real. It used to be a symlink to /app/client,
# so mutating a client file edited the worktree through the link, and the
# "changed nothing" check below (which compared the file with itself) hid it.
[ ! -d /app/client/node_modules ] || ln -s /app/client/node_modules "$COPY/client/node_modules"
cd "$COPY"
case "$(realpath "$FILE")" in
  "$COPY"/*) ;;
  *) echo "mutate: $FILE does not resolve inside the copy; refusing to edit it"; exit 2 ;;
esac
sed -i "$EXPR" "$FILE"
if cmp -s "$FILE" "/app/$FILE"; then echo "mutate: the expression changed nothing in $FILE; nothing was measured"; exit 2; fi
case "$FILE" in
  *.js|*.cjs) node --check "$FILE" 2>/dev/null || { echo "mutate: the mutated $FILE does not parse; nothing was measured"; exit 2; } ;;
esac
echo "mutation applied to the copy:"
diff "/app/$FILE" "$FILE" | sed 's/^/  /' | head -20 || true
red=0
for t in $TESTS; do
  [ -f "$t" ] || { echo "mutate: $t does not exist"; exit 2; }
  out=$(node --test "$t" 2>&1 || true)
  pass=$(printf '%s\n' "$out" | sed -n 's/^# pass \([0-9]*\)/\1/p'); fail=$(printf '%s\n' "$out" | sed -n 's/^# fail \([0-9]*\)/\1/p')
  echo "$t: ${pass:-0} pass, ${fail:-?} fail"
  printf '%s\n' "$out" | sed -n 's/^not ok [0-9]* - /    red: /p'
  [ "${fail:-0}" = "0" ] || red=1
  [ "${pass:-0}" != "0" ] || echo "    (no test passed: check that the mutant still LOADS, or this is not evidence)"
done
after=$(sha256sum "/app/$FILE" | cut -d' ' -f1)
[ "$before" = "$after" ] || { echo "mutate: /app/$FILE CHANGED during the control. Restore it from git."; exit 2; }
echo "original /app/$FILE unchanged"
if [ "$red" = 1 ]; then echo "RESULT: the guard bites"; exit 0; fi
echo "RESULT: every test stayed green; the guard does NOT bite"; exit 1
INNER
