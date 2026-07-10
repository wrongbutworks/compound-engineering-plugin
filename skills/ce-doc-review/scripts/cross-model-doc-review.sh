#!/usr/bin/env bash
# cross-model-doc-review.sh
#
# Runs ONE ce-doc-review judgment persona through a DIFFERENT model family (the
# "peer") in a separate, read-only process, and writes its findings as JSON into
# the run dir. The peer gets the same canonical persona brief the in-process
# reviewer uses (references/personas/<persona-file>.md) so it is genuinely "that
# persona, on a different model." One invocation per persona is required because
# the peer model is tiered PER LENS (security -> flagship, adversarial/product ->
# mid) and a single call carries only one model.
#
# Usage:
#   cross-model-doc-review.sh <peer> <reviewer-name> \
#                             <document-path> <document-type> <origin> <run-dir>
#
#   <peer>          codex  -> use Codex (when the host is Claude or Cursor)
#                   claude -> use Claude (when the host is Codex)
#   <reviewer-name> one of the three trio lenses: security-lens | adversarial |
#                   product-lens. This is the SHORT name the in-process persona
#                   emits; it forces the fold-in reviewer field to
#                   <reviewer-name>-<peer> so cross-persona agreement in synthesis
#                   matches the in-process twin. The persona-brief filename is
#                   DERIVED from it (not a caller argument) so a caller cannot
#                   point the brief read at an arbitrary path.
#   <document-path> the document under review (embedded into the peer prompt)
#   <document-type> requirements | plan | unified-requirements | unified-plan
#   <origin>        the Origin context slot (a path, product_contract_source:<v>,
#                   or the literal token none)
#   <run-dir>       an existing dir; output -> <run-dir>/<reviewer-name>-<peer>.json
#
# Self-locates its sibling reference files via BASH_SOURCE (NOT the CWD, which is
# the user's project on every host). The agent passes the values above.
#
# NON-BLOCKING BY DESIGN: every failure logs to stderr and exits 0 without an
# output file. The cross-model pass is additive and must never fail the review;
# the caller detects success purely by the presence of the output file.
#
# DATA-EGRESS NOTE: this embeds the full document content into an external model
# CLI prompt, so document content is transmitted to the peer provider. The log
# line below records that the send happened so the egress is auditable even in
# headless mode.

set -uo pipefail

PEER="${1:-}"
REVIEWER_NAME="${2:-}"
DOC_PATH="${3:-}"
DOC_TYPE="${4:-}"
ORIGIN="${5:-}"
RUN_DIR="${6:-}"

log()  { printf '[cross-model-doc] %s\n' "$*" >&2; }
skip() { log "$*"; exit 0; }   # non-blocking: announce reason, exit clean, no output

# --- validate inputs -------------------------------------------------------
case "$PEER" in codex|claude) ;; *) skip "invalid peer '${PEER:-<empty>}' (want codex|claude); skipping cross-model pass" ;; esac
[ -n "$REVIEWER_NAME" ] || skip "no reviewer-name given; skipping"
[ -n "$DOC_PATH" ] && [ -f "$DOC_PATH" ] || skip "document '${DOC_PATH:-<empty>}' not readable on disk; skipping"
: "${DOC_TYPE:=unified-plan}"
: "${ORIGIN:=none}"
[ -n "$RUN_DIR" ] && [ -d "$RUN_DIR" ] || skip "run-dir '${RUN_DIR:-<empty>}' is not a directory; skipping"
command -v "$PEER" >/dev/null 2>&1 || skip "$PEER CLI not installed; skipping"
command -v jq      >/dev/null 2>&1 || skip "jq not installed; skipping"

# --- per-lens brief + model tiering (single edit site; the maintenance point when model families change) ----
# The persona-brief filename is derived here from the allowlisted reviewer-name,
# never taken from a caller argument -- so no caller value reaches the brief path
# and there is no path-traversal / arbitrary-file-read surface.
# security-lens is knowledge-bound -> flagship model, medium reasoning.
# adversarial / product-lens are reasoning-bound -> mid model, high reasoning.
# Concrete IDs are the CURRENT instance of the tier principle; update here when
# model families change.
case "$REVIEWER_NAME" in
  security-lens) PERSONA_FILE="security-lens-reviewer";        CODEX_MODEL="gpt-5.6-sol";   CODEX_EFFORT="medium"; CLAUDE_MODEL="opus"   ;;
  adversarial)   PERSONA_FILE="adversarial-document-reviewer"; CODEX_MODEL="gpt-5.6-terra"; CODEX_EFFORT="high";   CLAUDE_MODEL="sonnet" ;;
  product-lens)  PERSONA_FILE="product-lens-reviewer";         CODEX_MODEL="gpt-5.6-terra"; CODEX_EFFORT="high";   CLAUDE_MODEL="sonnet" ;;
  *) skip "reviewer-name '$REVIEWER_NAME' is not a cross-model trio lens (want security-lens|adversarial|product-lens); skipping" ;;
esac

# --- self-locate skill root + canonical sibling files ----------------------
SKILL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || skip "cannot resolve skill root; skipping"
PERSONA="$SKILL_ROOT/references/personas/$PERSONA_FILE.md"
SCHEMA="$SKILL_ROOT/references/findings-schema.json"
[ -f "$PERSONA" ] || skip "persona brief not found at $PERSONA; skipping"
[ -f "$SCHEMA" ]  || skip "findings schema not found at $SCHEMA; skipping"
SCHEMA_CONTENT="$(cat "$SCHEMA")" || skip "cannot read findings schema; skipping"

OUT="$RUN_DIR/$REVIEWER_NAME-$PEER.json"
PROMPT_FILE="$(mktemp "${TMPDIR:-/tmp}/xmodel-doc-prompt-XXXXXX")"
PEERLOG="$(mktemp "${TMPDIR:-/tmp}/xmodel-doc-log-XXXXXX")"
trap 'rm -f "$PROMPT_FILE" "$PEERLOG"' EXIT

# --- compose the peer prompt from the canonical persona (single source) ----
# The full findings schema is embedded so the peer knows every required field.
# The document content is embedded directly for BOTH peers inside the
# <review-context> block, with the same context slots the in-process persona
# adapts on (Document type / Origin). codex's read-only sandbox is a safety
# property, not the delivery path.
{
  cat "$PERSONA"
  printf '\n\n---\n\n'
  printf 'This is an authorized document review of the maintainer\047s own repository.\n'
  printf 'Return ONE JSON object and nothing else (no prose, no code fence) matching this schema:\n\n'
  printf '%s' "$SCHEMA_CONTENT"
  printf '\n\nSet the top-level "reviewer" field to "%s-%s".\n' "$REVIEWER_NAME" "$PEER"
  printf '\n<review-context>\n'
  printf 'Document type: %s\n' "$DOC_TYPE"
  printf 'Document path: %s\n' "$DOC_PATH"
  printf 'Origin: %s\n\n' "$ORIGIN"
  printf '<prior-decisions>\nRound 1 — no prior decisions.\n</prior-decisions>\n\n'
  printf 'Document content:\n'
  cat "$DOC_PATH"
  printf '\n</review-context>\n'
} > "$PROMPT_FILE"

# --- run the peer: idle-timeout for streaming codex, hard cap for claude ----
IDLE_SECS="${CROSS_MODEL_IDLE_SECS:-180}"
HARD_SECS="${CROSS_MODEL_HARD_SECS:-600}"
TO_BIN="$(command -v gtimeout || command -v timeout || true)"

# Reap a backgrounded job's whole process group: TERM, then KILL after a grace.
reap() {
  local pid="$1" grp
  if kill -TERM -- -"$pid" 2>/dev/null; then grp=1; else kill -TERM "$pid" 2>/dev/null; grp=0; fi
  for _ in 1 2 3 4 5; do
    if [ "$grp" = 1 ]; then kill -0 -- -"$pid" 2>/dev/null || return 0
    else kill -0 "$pid" 2>/dev/null || return 0; fi
    sleep 1
  done
  if [ "$grp" = 1 ]; then kill -KILL -- -"$pid" 2>/dev/null; else kill -KILL "$pid" 2>/dev/null; fi
}

run_codex() {
  local prev; case "$-" in *m*) prev=1;; *) prev=0;; esac
  set -m
  command codex exec - -C "$RUN_DIR" -s read-only -o "$OUT" -m "$CODEX_MODEL" \
    -c "model_reasoning_effort=\"$CODEX_EFFORT\"" -c 'hide_agent_reasoning=false' \
    < "$PROMPT_FILE" > "$PEERLOG" 2>&1 &
  local pid=$!
  [ "$prev" = 0 ] && set +m
  local start last=-1 lastchg now size
  start="$(date +%s)"; lastchg="$start"
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5; now="$(date +%s)"; size="$(wc -c <"$PEERLOG" 2>/dev/null || echo 0)"
    [ "$size" != "$last" ] && { last="$size"; lastchg="$now"; }
    if [ $(( now - lastchg )) -ge "$IDLE_SECS" ]; then
      log "codex output idle ${IDLE_SECS}s; reaping peer process group"; reap "$pid"; break
    fi
    if [ $(( now - start )) -ge "$HARD_SECS" ]; then
      log "codex exceeded hard cap ${HARD_SECS}s; reaping peer process group"; reap "$pid"; break
    fi
  done
  wait "$pid" 2>/dev/null || true
}

log "sending document '$DOC_PATH' cross-model to $PEER (model $([ "$PEER" = codex ] && echo "$CODEX_MODEL" || echo "$CLAUDE_MODEL"); reviewer $REVIEWER_NAME; read-only; idle ${IDLE_SECS}s / hard ${HARD_SECS}s)"
case "$PEER" in
  codex)
    run_codex
    if { [ ! -s "$OUT" ] || ! jq -e . "$OUT" >/dev/null 2>&1; } && [ -s "$PEERLOG" ] && command -v python3 >/dev/null 2>&1; then
      python3 - "$PEERLOG" "$OUT" <<'PY' 2>/dev/null && [ -s "$OUT" ] && log "recovered codex JSON from stdout (-o file unavailable)"
import sys, json
txt = open(sys.argv[1], encoding="utf-8", errors="replace").read()
best, depth, start = None, 0, None
for i, ch in enumerate(txt):
    if ch == '{':
        if depth == 0: start = i
        depth += 1
    elif ch == '}' and depth > 0:
        depth -= 1
        if depth == 0 and start is not None:
            try:
                obj = json.loads(txt[start:i+1])
                if isinstance(obj, dict) and "findings" in obj: best = obj
            except Exception: pass
if best is not None: open(sys.argv[2], "w").write(json.dumps(best))
PY
    fi
    ;;
  claude)
    if [ -n "$TO_BIN" ]; then
      "$TO_BIN" -k 10 "$HARD_SECS" claude -p --model "$CLAUDE_MODEL" --permission-mode dontAsk \
        --disallowedTools Edit Write NotebookEdit Bash Task 'mcp__*' --max-turns 15 --no-session-persistence \
        --json-schema "$SCHEMA_CONTENT" --output-format json \
        < "$PROMPT_FILE" > "$PEERLOG" 2>/dev/null \
        || log "claude exited non-zero or timed out"
    else
      perl -e 'alarm shift; exec @ARGV' "$HARD_SECS" claude -p --model "$CLAUDE_MODEL" --permission-mode dontAsk \
        --disallowedTools Edit Write NotebookEdit Bash Task 'mcp__*' --max-turns 15 --no-session-persistence \
        --json-schema "$SCHEMA_CONTENT" --output-format json \
        < "$PROMPT_FILE" > "$PEERLOG" 2>/dev/null \
        || log "claude exited non-zero or timed out"
    fi
    jq -e '.structured_output' "$PEERLOG" > "$OUT" 2>/dev/null \
      || jq -r '.result // empty' "$PEERLOG" | jq -e '.' > "$OUT" 2>/dev/null \
      || { log "could not parse Claude output"; rm -f "$OUT"; }
    ;;
esac

# --- normalize the reviewer name + satisfy the top-level contract ----------
# Force reviewer = <reviewer-name>-<peer> (the persona brief's example uses the
# short in-process name, which would collide with the in-process reviewer and
# erase the cross-model agreement signal). Backfill the two soft arrays if the
# peer omitted them; drop the return entirely if findings is not an array.
if [ -s "$OUT" ]; then
  _norm="$(mktemp "${TMPDIR:-/tmp}/xmodel-doc-norm-XXXXXX")"
  if jq --arg r "$REVIEWER_NAME-$PEER" \
       'if (.findings|type)=="array" then {reviewer:$r, findings, residual_risks:(.residual_risks // []), deferred_questions:(.deferred_questions // [])} else empty end' \
       "$OUT" > "$_norm" 2>/dev/null; then mv "$_norm" "$OUT"; else rm -f "$_norm"; fi
fi

# --- validate the output against the synthesis reviewer-return contract -----
if [ -s "$OUT" ] && jq -e '(.reviewer|type=="string") and (.findings|type=="array") and (.residual_risks|type=="array") and (.deferred_questions|type=="array")' "$OUT" >/dev/null 2>&1; then
  n="$(jq '.findings | length' "$OUT" 2>/dev/null || echo '?')"
  log "wrote $n finding(s) to $OUT (reviewer $REVIEWER_NAME-$PEER)"
else
  log "$PEER produced no usable schema-shaped output; skipping fold-in"
  rm -f "$OUT"
fi
exit 0
