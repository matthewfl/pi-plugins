# Plan: pi-gitlab extension

A pi extension for working with GitLab merge requests **and issues** mentioned
in conversation. The core idea: **one file format is the entire interface**.
`gitlab_fetch` downloads an MR/issue into a local file; the agent (or the
user) edits that same file — staged replies live inside their threads,
marked `visible="unpublished"`; `gitlab_put` diffs file against server and performs
exactly the pending mutations, with dry-run and a review gate; `gitlab_watch`
is just *fetch-on-a-timer plus a notification*. No separate mutation grammar,
no per-action tools, no registration state.

Tool surface: **three tools total**, one always on:

| tool | staged? | purpose |
|---|---|---|
| `gitlab_fetch(url)` | always-on umbrella | fetch MR/issue → write/update the file; write `.diff` of what changed since last fetch; unlocks the other two tools on first use |
| `gitlab_put(path, mode)` | gated | dry-run / submit / submit_bypass_user_review the file's unpublished changes |
| `gitlab_watch(url?, action, intervalSeconds?)` | gated | start / stop / list background watches (MR or issue); notifies via session message on change (url optional, required for start/stop only) |

The only command is `/gitlab-auth` (paste-a-PAT; SSH-friendly). The only
skill teaches the file format and the workflows. Tools-only otherwise: no
registration, every tool takes a URL or file path, nothing to lose on
reload/fork/compaction.

---

## 1. Shape of the extension

```
~/.pi/agent/extensions/gitlab/
├── index.ts     # factory: 3 tools + /gitlab-auth + resources_discover;
│                # staged activation on session start
├── client.ts    # zero-dep GitLab REST v4 client (global fetch)
├── auth.ts      # auth.json: per-host tokens + cached token-user identity
├── url.ts       # MR and issue URL parsing
├── format.ts    # file grammar: serializer + parser (shared by fetch/put/watch)
├── fetch.ts     # server → file (git merge §5), .diff, .store/ sidecars
├── put.ts       # file + server → action list → validate → execute
├── watch.ts     # pollers, appendEntry persistence, session_start re-arm
├── test/        # node:test suites + grammar fixtures (§13)
└── skills/
    └── gitlab-mr-review/
        └── SKILL.md
```

Zero npm dependencies by construction: file deltas and the three-way
merge (§5) shell out to system `git` (`git diff --no-index`, `git
merge-file`) — guaranteed present, since the agent's workflow already
assumes git. (An npm diff lib is an acceptable fallback if git is ever
absent.) For both commands, exit code 1 means "differences found", not
failure — the wrappers must not treat it as an error.

**Data layout** — separate from the extension code dir:

```
~/.pi/agent/gitlab/
├── config/
│   ├── auth.json        # per-host tokens + token-user usernames (0600)
│   └── config.json      # confirmBeforePost, signatureHeader, …
├── mr/                  # item files the agent edits
│   └── <host>__<project>__mr-<iid>.gitlab.md      (+ .diff beside it)
├── issue/
│   └── <host>__<project>__issue-<iid>.gitlab.md   (+ .diff beside it)
└── .store/              # internal tracking — the agent never needs these
    └── <host>__<project>__(mr|issue)-<iid>/
        ├── base         # pristine server render (merge base)
        ├── prev         # file content before last write (drives .diff)
        └── state.json   # fetched_at, server updated_at, diff_refs, url
```

---

## 2. Staged activation

**Always-on:** `gitlab_fetch`. Short description: "Fetch content from a
GitLab URL (merge request or issue) into a local editable file; unlocks the
GitLab put/watch tools."

First successful fetch → `pi.setActiveTools([...base, gitlab_put, gitlab_watch])`
and the tool result announces them. Activation on genuine intent, not on URL
mentions in passing. On `session_start`: restrict to base + `gitlab_fetch`;
if open watch entries exist (§9), re-activate and re-arm immediately.

The always-present tool is the guaranteed discovery path; the skill
description enriches; `/skill:gitlab-mr-review` is the manual fallback.

---

## 3. Auth

Tokens are stored **file-only** — no `{"env": …}` entries, no env-var
fallbacks — in `~/.pi/agent/gitlab/config/auth.json` (`0600`), a per-host
map:

```json
{
  "https://gitlab.com": {
    "token": "glpat-…",
    "username": "matthew"
  }
}
```

`username` (recorded by `/gitlab-auth` from the verifying `GET /user`)
drives `from_operator` attribution in the file (§4) and own-note detection.
A tool called for a host with no entry fails with an actionable error
naming `/gitlab-auth <base-url>`; nothing else is consulted.

**`/gitlab-auth [base-url]`** (the extension's only command): default
`https://gitlab.com`; `http://` rejected unless loopback. It prints where
to mint a Personal Access Token
(`https://<host>/-/user_settings/personal_access_tokens`, `api` scope) and
reads it back via a secret `ctx.ui.input` prompt — paste-a-token works over
SSH, with no browser callback to break on headless machines. The token is
verified with `GET /user` (showing the username it will post as); 401/403
refuses to store, unreachable-instance warns but stores (the off-VPN case).

`config.json` (same dir): `confirmBeforePost` (true), `identity` /
`signatureHeader`, `botUsernames`, `watchIntervalSeconds` (120).

---

## 4. The file format

### 4.1 Example (an MR file, as fetch writes it)

````markdown
<!-- gitlab file — edit draft blocks (visible="unpublished"), flip resolved
     attributes, or edit the <description> body, then run gitlab_put.
     Comments like this one are ignored by the parser. -->

<gitlab-mr source="https://gitlab.com/my-group/my-project/-/merge_requests/42"
  iid="42" title="Fix empty-array handling" state="opened" draft="false"
  author="@alice" operator_author="true" head_sha="9b31f2e" pipeline="success"
  fetched_at="2024-05-02T14:20:05Z">

<description>
Fixes the crash on empty arrays and adds regression tests.
</description>

<discussion_thread id="a3f1c2d455ab9e10" file="src/api/client.ts" line="42" side="new" resolved="false">
<code_context>
```ts
41  export function applyFilter(items) {
42    if (items.length && !filter(items)) {   // ← commented line
43      return [];
```
</code_context>

<comment author="@reviewer" id="771" from_operator="false" created_at="2024-05-01T10:12Z">
This null check looks wrong for empty arrays — `items` may be undefined.
</comment>

<!-- template — copy into a real block to reply:
<comment author="pi" id="unset" visible="unpublished">
…reply shown to @reviewer…
</comment>
-->
</discussion_thread>

<discussion_thread id="77cc0192aa31bc09" resolved="false">
<comment author="@alice" id="779" from_operator="true" created_at="2024-05-01T11:03Z">
Good catch, fixed in 9b31f2e — see src/api/client.ts.
</comment>
</discussion_thread>

<!-- new top-level thread template:
<discussion_thread id="unset" visible="unpublished">
<comment author="pi" id="unset" visible="unpublished">
…new standalone comment…
</comment>
</discussion_thread>

new code-commented thread template:
<discussion_thread id="unset" visible="unpublished" file="path/from/diff" line="123" side="new">
<comment author="pi" id="unset" visible="unpublished">
…review comment…
</comment>
</discussion_thread>
-->

</gitlab-mr>
````

Issues are identical except the root tag is `<gitlab-issue …>` and threads
never carry `file`/`line`/`side`.

### 4.2 Grammar rules

- Root element (`<gitlab-mr …>` or `<gitlab-issue …>`) wraps everything;
  its `source` attribute is how `gitlab_put` finds the URL — **`path` is
  put's only required argument**.
- Parser is line-oriented: element tags recognized only at line start;
  bodies are raw markdown between open/close tag lines; **`<!-- … -->`
  regions are skipped entirely** (guidance and templates live there).
- Element inventory: `<description>`, `<discussion_thread>`,
  `<code_context>`, `<comment>`, root. Nothing else.
- Attributes: `id` is a server id or the literal `unset`; `visible` is
  `published` (server has it — the default, omitted on published elements)
  or `unpublished` (**staged** — awaiting the next put); `resolved` on
  a thread is the *desired* state — flip it to resolve/unresolve on put;
  `from_operator="true"` marks comments authored by the token user — the
  human operating this pi, whose comments are **direct instructions**
  (§8); `via_pi="true"` (fetch adds it to signature-marked notes) marks
  comments this agent previously posted. Ids stay full-length in the file
  — the agent never types them (replies nest inside their thread block);
  notifications use 8-char prefixes.
- Editing a **published** comment body requires
  `update_existing_comment="true"` on that element — an opt-in the skill
  never mentions, so it happens deliberately, not by accident (§7).
- `<description>` may carry `non_owner="true"` to permit an edit when
  the token user isn't the item's author (§7); the posted body then
  gets a disclosure footer (§12).
- **No `<diff>` section.** The agent already works in the project's git
  repo and gets full diffs there (`git diff`, `git log`); the file
  carries only `<code_context>` snippets — enough to locate the file and
  lines — plus the head SHA. `put` still validates anchors against the
  live server diff at submit time.
- Fetch **pre-places commented-out templates** (a reply template inside
  each thread; new-thread and new-code-thread templates at the end,
  §4.1), so drafting is copy-uncomment-fill even when SKILL.md was never
  loaded; the skill documents the same grammar (§10).

### 4.3 Semantics for `put` (§7)

| file state | server state | put action |
|---|---|---|
| `<comment … id="unset" visible="unpublished">` inside a published thread | — | POST reply into that discussion |
| `<discussion_thread id="unset" visible="unpublished">` (no file/line) | — | POST new top-level discussion |
| draft thread **with** file/line/side | — | POST discussion with position anchor (validated against current diff) |
| thread `resolved` ≠ server | resolved state | PUT resolve/unresolve |
| `<description>` body ≠ server | — | PUT MR/issue description (requires author or `non_owner="true"` attr) |
| root tag `title="…"` ≠ server | — | PUT MR/issue title (requires author or `non_owner="true"` on the root tag; no footer — GitLab's own system note records the rename) |
| published `<comment>` body edited + `update_existing_comment="true"` | unchanged | PUT note body (signature ensured-present, not duplicated) |
| published `<comment>` body edited, flag absent | unchanged | **error** — dry-run names the required flag |

**Staging semantics.** `unpublished` marks content *staged in the file* —
known nowhere on the server. A successful submit flips each staged element
to published: put **rewrites the file**, giving posted drafts their new
server `id`, `visible="published"`, and author;
outcomes are also annotated inline as HTML comments
(`<!-- put ✓ note_781 -->` / `<!-- put ✗ 400: line no longer in diff -->`).
Failed drafts stay `unpublished` with their ✗ marker and are naturally
retried by the next `put`. Idempotency is by construction — a posted draft
can never double-post because it is no longer a draft — so no separate
results file or resubmit guard is needed.

---

## 5. Three-way merge & concurrent writes

Fetch and watch **rewrite the file from server state** while the agent's
staged edits live inside it — so every update is a proper **three-way text
merge** via `git merge-file`: guaranteed present (the agent's workflow
already assumes git), and its conflict-marker syntax is one every coding
agent already speaks. Text merge, not element-level — simpler and robust
enough as long as the grammar tolerates pure line insertion (it does:
threads are ordered lists of self-contained blocks, §4).

**Sidecars** live in `~/.pi/agent/gitlab/.store/<slug>/` (slug = the file's
`<host>__<project>__(mr|issue)-<iid>`, §1): `base` (the pure server render
— no staged edits, no annotations — at the file's `fetched_at`), `prev`
(the file content before the last extension write; drives `.diff`),
`state.json` (`fetched_at`, server `updated_at`, `diff_refs`, source url).

**Invariant: every extension write updates the file and `base` from the
same server snapshot.** Fetch and watch render both. **`put` re-renders
both from the post-submit snapshot too** — a comment put just published
enters `base` immediately, so the next tick's merge sees it as unchanged
context, never as a phantom "agent-added" block that could be duplicated
or flagged as a conflict.

**Root-tag exception.** The root tag packs every item attribute onto ONE
line, so a line-based merge would flag a conflict whenever the agent stages
a `title` rename and the server churns the same line (`fetched_at` changes
on every fetch; `state`/`head_sha`/`pipeline` move too) — incompatible
changes that are really independent attributes. The root line is therefore
excluded from the text merge: all three inputs carry an identical sentinel
in its place, and the resolved line is spliced back afterwards from an
attribute-level policy — server-owned attributes always come from the
server, the staged `title`/`non_owner` is re-applied when the server left it
unchanged, and **if both sides changed the same attribute to different
values** (someone renamed in the web UI while a rename was staged) the
splice is a synthesized `<<<<<<< staged / ======= / >>>>>>> server` block:
surfaced, never silently resolved — the stale-baseline guard cannot see it
because `fetched_at` is server-owned. Equal values (the normal post-submit
state: pi just posted the staged title) merge clean.

### 5.1 Merge procedure (fetch and every watch tick)

1. Render `serverRender` from the fresh snapshot (same renderer as `base`).
2. `git merge-file --stdout -L staged -L base -L server file base
   serverRender` → merged text; exit 0 means clean.
3. Exit > 0 means conflicts: **write the merged text with its
   `<<<<<<< staged ||||||| base ======= >>>>>>> server` markers in place**
   (the agent's staged edits survive inside the conflict hunks — nothing
   is dropped) and notify the agent that its edits need conflict repair.
4. Apply via §5.2 (idle gate, temp + rename): copy `serverRender` → `base`,
   file-before-write → `prev`, refresh `state.json`, and regen `.diff` as
   `git diff --no-index prev file` beside the file ("No changes" → a
   one-line diff).
5. Honest limitation: text merge doesn't know the grammar — a staged edit
   whose context lines moved under it may conflict (loud, agent-fixable)
   rather than silently misplace. That is the whole mechanism — no
   grammar-aware merge exists to maintain.

### 5.2 Concurrent-write protocol

The file has three writers: fetch (explicit), watch ticks (implicit), and
the agent/user (edits). Because this is a plugin, the extension observes
pi's tool lifecycle (`tool_call` / `tool_result` events) and makes writes
effectively atomic from the agent's perspective — the file never changes
while the agent has a tool running:

1. **Idle-gated writes.** Pending fetch/watch file mutations queue until no
   tool is in flight, then apply — from the agent's seat, the file swaps
   atomically between its actions, never mid-edit. (An agent-initiated
   `gitlab_fetch` writes immediately: it *is* the running tool.)
2. **Atomic applies**: temp file + rename.
3. **Merge on every update.** A tick (or fetch) with server changes runs
   the §5.1 merge against the real file whether or not staged edits exist
   — clean merges keep staged work verbatim, conflicts land as git-style
   markers plus a notification — so there is no separate "dirty file"
   path and no `.incoming` snapshot. Sidecars live in `.store/<slug>/` (§1).
4. **Explicit fetch = the same merge, on demand**: also how the agent
   forces a refresh when the user mentions new activity or before a `put`.
5. **Residual interleaves fail loudly, not silently**: an agent edit
   composed against pre-swap content either misses its `oldText` match
   (pi's edit tool reports it → re-read, retry) or lands in a staged region
   the rewrite preserved verbatim. And `put` never trusts the file for
   published state (§7) — a stale view can confuse the agent, not produce
   a wrong API call.

**What the merge can't fix — and doesn't need to.** The one window no merge
can close is *between* the agent's read and edit calls — the model is
composing, zero tools are in flight, so a merge landing there is legal
under rule 1 and can ambush the edit it was about to make. That degrades
to rule 5: loud `oldText` mismatch, re-read, retry — and the watch
notification itself tells the agent the file moved. The net: staged work
is never lost, the file never freezes, and `put`'s baseline check (§7)
still forces a final freshness sync before anything publishes.

---

## 6. `gitlab_fetch(url)`

1. Parse URL (MR or issue; anything else → polite unsupported-type error).
2. Snapshot the server: item overview + all discussions (position data
   included — it drives `<code_context>`). **No full diff is rendered**
   (§4.2). MR `diff_refs` are stored in `.store` `state.json` for `put`'s
   anchor validation.
3. Write/refresh
   `~/.pi/agent/gitlab/(mr|issue)/<host>__<project>__<iid>.gitlab.md`
   via the §5.1 merge (first fetch: plain write), refreshing `.store`
   `base` / `prev` / `state.json` (§5).
4. Write `<file>.diff` beside it: `git diff --no-index` of `prev` → new
   file — so the agent can read *just the delta* after refreshes and
   watch ticks. First fetch or "No changes" → a one-line diff.
5. Return `{ path, diffPath, kind, summary }` — summary is a few lines
   (title, state, N threads / N unresolved, head SHA, whether the token
   user is the author) plus the unlock notice on first call.

Large items: discussions text honors the 50 KB / 2000-line truncation,
with a clipped-count HTML comment in the file.

---

## 7. `gitlab_put(path, mode)`

`mode`: `"dry_run" | "submit" | "submit_bypass_user_review"`. The file's
root `source` attribute provides the URL.

Pipeline: parse file (line-numbered errors) → fetch server state → compute
the action list (§4.3) → validate:

- draft anchors (`file`/`line`/`side`) must be commentable lines in the
  *current* MR diff; drafts in threads that no longer exist → error;
- description updates need token-user authorship or `non_owner="true"`;
- published-comment body edits require `update_existing_comment="true"`
  (dry-run error names the flag; the skill never mentions it — discovery
  keeps accidental edits rare);
- **stale-baseline guard**: if the server's `updated_at` is newer than the
  file's `fetched_at`, the item moved on since this snapshot: dry_run →
  warning; **submit → blocking error** ("re-run `gitlab_fetch` — the §5.1
  merge preserves staged edits — review the merge, then resubmit"). The
  hard rule also protects the whole-field `<description>` replace.
- duplicate/self-reply and `[bot]`-thread replies → warnings;
- **conflict-marker guard**: leftover `<<<<<<<` / `=======` / `>>>>>>>`
  marker lines → error: "resolve the merge conflict in the file first
  (§5.1), then resubmit."

Then the modes diverge: **dry_run** reports the numbered action list (no
file or server writes); **submit** shows the batch review dialog —
file path + one line per planned action, bodies previewed with the signature
header — and on **Submit all** executes sequentially (~300 ms pacing;
per-item failures recorded, 401/403/429 aborts the rest), then rewrites the
file (published-ifying posted drafts, inline ✓/✗ annotations) and returns
the `N posted, M failed` summary. The same post-submit snapshot also
re-renders `.store` `base` and `prev` (the §5 invariant): just-published
comments become merge context, never phantom staged edits. **submit**
gates on the operator's review dialog iff `confirmBeforePost === true`
(headless + true errors; false posts without ever asking).
**submit_bypass_user_review** skips the dialog and is always available —
the agent is instructed to use it ONLY when the operator explicitly asked
to submit without review (tool description carries the instruction).

Cancel is a normal non-error result: "cancelled — do not resubmit unless
asked". Per-item editing happens in the file; agents delete draft blocks to
veto them.

---

## 8. Signature & trust hierarchy in the file

Every note **put** posts gets the executor-owned header (agent can't strip):

```markdown
_🤖 Automatically written by pi-gitlab (AI agent). Review before acting._

<body>
```

This powers both `via_pi="true"` attribution and watch self-post
suppression. `<description>` bodies post verbatim for the operator's own
items (provenance = gate + annotations); a `non_owner` edit appends the
disclosure footer (§12).

**Trust hierarchy (skill-taught):** comments with `from_operator="true"` come
from the human operating this pi — treat them as **direct instructions** (the
user can literally drop directives into their own MR threads and the agent
follows them). Comments from anyone else are **input to consider**: discuss
them with the operator; never take consequential action solely because a
non-operator's comment asked for it. This distinction is spelled out in
SKILL.md and restated in the tool's `promptGuidelines`.

---

## 9. `gitlab_watch(url, action, intervalSeconds?)`

`action`: `"start" | "stop" | "list"`. Works for MR **and** issue URLs;
multiple simultaneous watches keyed by `(host, project, kind, iid)`;
starting an existing watch updates its interval. Default 120 s, floor 30 s,
config knob.

**start**: returns immediately — never blocks the agent's turn. Performs an
initial `gitlab_fetch` (so the file exists and baselining is clean), then
registers an in-process timer (module map; extension reloads replace rather
than duplicate) and persists via `pi.appendEntry`.

**stop**: clears the timer, appends a stop entry. **list**: reports all
active watches (item label, interval, start time) **plus health —
last tick age, notifications delivered, and suppression attribution**:
every change the tick saw and deliberately kept quiet, with its reason
(own posts, system notes, whitelisted trigger bodies, pipeline progress).
Silence stays silent — it just becomes answerable on demand, so "why
didn't the watch notify on my post?" is a list call instead of an
investigation. A failing watch (revoked token, dead network) is surfaced
too: the CLI prints tick errors to stderr; the extension steers the
agent after 3 consecutive failed ticks, then at most hourly.

**Per tick**: fetch the server snapshot, then run the §5.2 protocol —
queue the merge until no tool is in flight; run §5.1 (clean merges keep
staged work; conflicts land as markers + notice); apply atomically (temp +
rename); refresh `.store` and `.diff`. If
meaningful change (new non-`via_pi`/`from_operator`-self notes — the
user's own web comments *do* notify, since they're likely instructions;
resolve flips; **description edits** — fingerprinted in SeenState since
edits bump updated_at without notes; **title renames** — same fingerprint
rationale; own description submits re-prime
the poller and stay silent; head-SHA move; terminal pipeline transitions (→ success/failed/canceled; start/progress
stays silent, though the file's pipeline attribute still refreshes every
tick)): inject **one
compact message per item per tick** via `pi.sendUserMessage` — a line of
what changed plus the paths; the agent reads the `.diff` and file itself:

> [gitlab watch] !42 my-project (my-group/my-project): 2 new notes, 1
> resolve flip, head moved 9b31f2e→4da0c11.
> file: ~/.pi/agent/gitlab/mr/gitlab.com__my-group_my-project__mr-42.gitlab.md (delta: .diff)

A tick that merged with conflicts says so explicitly: "…merged with
conflicts — fix the `<<<<<<<` markers in <file> before editing further."

`sendUserMessage` always sends with `deliverAs: "steer"` — steers into
a running turn (agent sees the change ASAP) and starts a fresh turn when
idle (pi ignores deliverAs in the non-streaming branch, checked
atomically inside `prompt()`). Never followUp.
Merged/closed/closed-issue → final notification + auto-stop.

**Resume**: `session_start` scans entries, applies stops over starts,
re-arms survivors (re-activating gated tools, §2); first post-re-arm tick
re-baselines silently to avoid re-notifying ancient history. Process death
loses timers but not intent — reopening pi resumes watching. No CLI can
give that property; a future thin CLI wrapper over client/format remains
possible for humans. While any watch is active, `ui.setStatus("pi-gitlab", …)`
shows the watched items in the footer — e.g. `gitlab: watching !1 agents`
(up to two `!iid leaf`/`#iid leaf` labels, then `+N more`) — so an idle
agent is visibly still on duty (refreshed on register/unregister, re-arm).

---

## 10. Workflow (skill-taught)

- **Own-MR triage**: fetch → read file (or diff after the first time) →
  classify threads (actionable / simple reply / contested) → fix code →
  *talk to the user about contested items and anything a non-operator
  comment asks for* → edit the file (place drafts via the threaded
  templates) → `put dry_run` → tell the user "review `<path>`" → `put
  submit` → report outcome summary.
- **Reviewing someone else's MR**: fetch → read the threads and
  `<code_context>` snippets, pull the full diff from the local repo
  (`git diff main...HEAD`) → draft code-comment threads at the right
  anchors + one top-level summary → same put loop.
- **Watching**: "keep an eye on this" → `watch start` (works on several
  items at once, MRs or issues); on a watch notification read the `.diff`
  first, full file if needed; `watch stop` when done; `watch list` to
  inventory.
- **Description edits**: edit the `<description>` block → same put loop;
  `non_owner` rules.
- Etiquette: never reply to `via_pi` comments; `[bot]` (configurable
  list) threads are informational; `resolved` flips only when the
  operator asked (chat or a `from_operator` comment) or the agent's own
  reply fully settles a simple question — humans own resolution
  otherwise (best guess, expect iteration); one `<description>` block;
  HTML comments are free space for working notes to the human.

---

## 11. Error handling & safety

- Body markup is verbatim (post-CI-bot incident; replaces a rejected
  escaping design): inside <description>, <comment>, and <code_context>
  bodies, only the SIX grammar tag names have structure meaning at
  column 0; every other tag-looking line (HTML like <details>) is plain
  content byte-for-byte — file == GitLab content, no transform invariants.
  A reserved tag inside a body is a FormatError naming &lt;name&gt;
  (GitLab markdown renders entities) as the workaround. Why ignore beats
  escape: zero transformation state for render/merge/reconcile paths to
  get out of sync (the escaping attempt self-conflicted in a live merge).
- CLI companion (added post-implementation): `bin/pi-gitlab.ts` exposes
  login/fetch/put [--dry-run|--submit]/watch for NON-pi agents over the
  same pure modules and the same ~/.pi/agent/gitlab tree (no re-auth);
  submit posts with no review dialog (no operator in that process);
  watch refreshes the file and exits 0 on first meaningful change; short
  agent-reminders go to stderr (--quiet to silence); `pi-gitlab skill`
  prints the bundled SKILL.md — the ONLY behavior guide, shared by the
  pi skill and the CLI (no second guide to drift); mechanics that
  genuinely differ (no review dialog; blocking one-shot watch; locks)
  are called out in the skill's CLI section. package.json "bin" +
  shebang let `npm link` expose a `pi-gitlab` command.
- Per-item advisory lock (`.store/<item>/pi-gitlab.lock`, O_EXCL): one
  system (pi or cli) owns an item at a time; conflicts fail fast with
  named-holder info (exit 3 / tool error); dead-pid reclaim, one-shot
  holders stale after 30 min, watch holders only reclaimed on death.
- Unsigned-triggers whitelist (added post-implementation): `config.json`
  `bypassSignaturePatterns` (global) ∪ `servers.<baseUrl>.bypassSignaturePatterns`
  (per-instance) are JS regexes matched against the trimmed staged body;
  matching comments post WITHOUT the signature header (bot triggers like
  `ci test`, `/merge`). The gate preview flags them `[unsigned — whitelist
  match]`; posted note ids persist in `state.json` `viaPiNoteIds` so the
  file still renders `via_pi="true"`. Watch silencing is narrower than
  put matching: only VERBATIM full-body matches silence (recorded ids are
  the primary signal), so prose comments merely mentioning a trigger still
  notify — put-side matching stays regex-liberal (`^…$` recommended).
- Tokens never appear in tool output/files/errors; API errors are
  status + sanitized message with hints (401 → `/gitlab-auth`; 403 on
  write → "`api` scope"; 404 → visibility/host mismatch).
- 429/5xx → single retry honoring `Retry-After`; during submit these abort
  remaining items (marked ✗ not-attempted inline).
- Parser errors cite file line numbers; the repair loop is the agent's
  normal edit tools.
- Extension file writes are idle-gated and atomic (§5.2); races degrade to
  loud edit-tool failures or next-tick self-heal, never silent corruption.
- `put` validates every action against live server state (threads exist,
  anchors in current diff, resolve idempotent, fresh baseline).
- Post-submit reconcile (implementation hardening, found in live testing):
  before the post-submit re-render, `put` strips just-posted drafts from
  the file and syncs edited note/description bodies to the exact posted
  text — otherwise the 3-way merge re-applies the drafts as local edits
  and the next submit would double-post them (§4.3 idempotency).
- Instance quirks observed live (GitLab 15.11-ee behind a size-capping
  ingress): list pages 500 once a page exceeds ~150 KB — pagination
  halves `per_page` and restarts instead of failing; files ≳20 KB come
  back with an empty `diff` payload (server-side suppression), so their
  lines cannot anchor code comments and `put` rejects with "cannot
  anchor" (intended: safer to refuse than guess); both PAT-doc URL
  forms (`/-/user_settings/…` newer, `/-/profile/…` older) are shown.
- Truncation everywhere (50 KB/2000 lines), clipped-count HTML comments in
  the file.
- The item file is plain markdown under `~/.pi/agent/gitlab/{mr,issue}/`
  — the user can open, read, or hand-edit it at any point; that is the
  review surface.
- Known v1 limitation: subpath GitLab installs (`https://corp.com/gitlab`)
  don't parse.

---

## 12. Decisions log

This round:

- **Resolve etiquette (best guess, expect iteration)** — the agent flips
  `resolved` only when the operator asked (in chat or via a
  `from_operator` comment) or its own reply fully settles a simple
  question thread; humans own resolution otherwise (§10).
- **Description provenance** — own MRs post verbatim (the operator's tool
  on the operator's MR; the batch review gate carries provenance); a
  `non_owner` description edit appends the footer
  `_Description updated via pi-gitlab (AI agent) acting for @<operator>._`
  (§7).
- **Pipeline ticks** — notify on terminal transitions only
  (→ success/failed/canceled); start/progress stays silent, while the
  status attribute in the file still refreshes every tick (§9).
- **Published-comment editing** — supported via an explicit
  `update_existing_comment="true"` attribute; the skill never mentions
  it, so the agent discovers it through the dry-run error and accidents
  stay rare (§4.3, §7).
- **Element-aware merge** — dropped; text merge + git-style conflict
  markers is the whole story (§5).

Previously: file-only auth (§3); `~/.pi/agent/gitlab/` layout (§1);
no `<diff>` section / `pathsFilter` (§4.2, §6); full ids in the file,
8-char prefixes in notifications (§4.2, §9); conflict markers + the put
guard (§5.1, §7); git `merge-file` / `diff --no-index` tooling (§1, §5);
`from_operator` naming (§4.2, §8).

---

## 13. Testing

`node:test`; grammar fixtures under `test/fixtures/`. The format, merge,
and put-action modules are pure and imported directly — pi APIs are only
at the edges (tools, dialogs), so nearly everything is unit-testable
without a running pi.

- **Grammar fixtures** (`test/fixtures/*.gitlab.md`): a plain MR, an MR
  with code threads + `<code_context>`, an issue, one with staged drafts,
  templates and HTML comments, plus one malformed file per error class.
- **format.ts**: fixtures parse to the expected structure;
  serialize(parse(x)) is byte-identical; each malformed fixture errors
  with the right line number; HTML-comment regions are never parsed;
  conflict-marker detection.
- **put action computation** (pure: parsed file × fake server snapshot →
  action list): one test per §4.3 table row — anchors against a fake
  diff, `non_owner`, stale-baseline, and `update_existing_comment`
  (absent → error naming the flag; present → PUT note).
- **merge**: scripted `git merge-file` on temp files — clean tick, staged
  edits preserved, both-sides conflict → markers + notification, and the
  §5 invariant: after a submit, `base` equals the pure render of the
  post-submit server state.
- **client.ts**: mocked fetch — pagination, 401/403/404/429 mapping, and
  a token-never-appears-in-output assertion.
- **watch**: change classification (new note → notify; own `via_pi` post
  → silent; pending→running → silent; running→failed → notify),
  suppression attribution (classifyChanges returns the quiet changes
  with reasons — own posts, system notes, whitelist bodies, pipeline
  progress — surfaced by `gitlab_watch list` as health, plus failure
  surfacing: CLI tick errors on stderr, extension steers after 3
  consecutive failures then hourly), and tombstone stop-over-start
  reconstruction.
- **/gitlab-auth**: mocked `ctx.ui` + fetch; `0600` permissions;
  unreachable instance warns-but-stores.

---

## 14. Build order

Tests grow alongside each step (§13).

1. `url.ts` (MR + issue), `auth.ts`, `client.ts` (item GET, discussions
   list, discussion/note POST, note PUT (comment edits, gated by
   `update_existing_comment`), resolve PUT, description PUT, diffs —
   for code-context and `put` anchor validation — /user).
2. `/gitlab-auth` (+ username capture) and auth.json/config.json.
3. `format.ts`: serializer + parser + HTML-comment skipping — the
   grammar fixtures and parse tests (§13) land here.
4. `fetch.ts` incl. render + `git merge-file` three-way (§5.1), `.store`
   sidecars (base/prev/state.json), `.diff` via `git diff --no-index`,
   `gitlab_fetch` + staged `setActiveTools` (+ session_start wiring).
5. `put.ts`: action computation, validation (anchors, stale-baseline,
   non-owner, conflict-marker guard), dry-run, review dialog, executor
   with signature wrap, inline annotation + file rewrite, post-submit
   refresh of `.store` `base`/`prev`.
6. `watch.ts`: pollers (idle-gated merge writes per §5.2), notify,
   appendEntry/re-arm, auto-stop.
7. `SKILL.md` + `resources_discover`.
8. Polish: renderCall/renderResult, retry/backoff, `pi install` packaging.
