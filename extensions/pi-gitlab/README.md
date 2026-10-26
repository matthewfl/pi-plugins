# pi-gitlab

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that lets
the agent work with **GitLab merge requests and issues** — reading and
replying to discussion threads, leaving code-review comments, updating
descriptions or titles, resolving threads, and watching items for changes — while
keeping the human in control of every write.

## Why you might want it

- **Nothing posts without your approval.** The agent never calls the GitLab
  API to publish directly. It stages everything it wants to say as edits in
  one local file; when it's done, you get a single review dialog with the
  whole batch. Approve once, or cancel and nothing happens.
- **Clear attribution.** Every comment the agent posts carries a signature
  banner (`_🤖 Automatically written by pi-gitlab…_`), so other humans and
  your own later self can tell agent output apart from yours.
- **A trust model that matches reality.** The file marks which comments came
  from you (`from_operator`) — those are instructions to the agent — versus
  everyone else's, which the agent may only *consider* (it will not take
  consequential action solely because a stranger asked).
- **Watches that don't whine.** The agent can watch MRs/issues and gets
  notified only on meaningful events: new comments, resolve flips, branch
  head moves (CI progress is silenced until a terminal state).

## Setup

1. Load the extension in pi (e.g. put/symlink it into
   `~/.pi/agent/extensions/` or load with `pi -e <path>`).
2. Run `/gitlab-auth https://your-gitlab-host` inside pi. It walks you through
   creating a Personal Access Token with the `api` scope (it shows the token
   page URL for both newer and older GitLab versions), verifies the token
   against the instance, and stores it with `0600` permissions in
   `~/.pi/agent/gitlab/config/auth.json`. That's all pi needs.
3. Tell your agent about an MR or issue — paste the URL in conversation.
   The extension figures out which it is from the URL.

## What you'll see day to day

When the agent starts working on an MR or issue, a new file appears:

```
~/.pi/agent/gitlab/mr/<host>__<project>__<mr-NN>.gitlab.md
~/.pi/agent/gitlab/issue/<host>__<project>__<issue-NN>.gitlab.md
```

That file **is** the interface. It contains the item (title, state,
pipeline status, description) and every discussion thread, including where
comments anchor into code with a small fenced context (the commented line is
marked with `← commented line`). Comments look like:

```
<comment author="@alice" id="771" from_operator="true">
ci test please
</comment>
```

When the agent wants to change something, it edits this file: new comments/
replies are added as `visible="unpublished"` blocks — think of it as
"staged", like a git index — while description edits change the
`<description>` body and renames change the root tag's `title="…"`
attribute. You
can open the file any time; you can even hand-edit it yourself. When the
agent runs the publish step, you get **one confirmation dialog** summarizing
the batch ("reply in thread …, new code comment url.ts:82 …, resolve thread
…"). Approve → everything posts in one go, with per-item ✓/✗ reporting back.
Anything that failed to post stays in the file with a `<!-- put FAIL: … -->`
note so it can be fixed and retried; it won't double-post.

If someone (you in the web UI, a colleague, a bot) changes the item on GitLab
while the agent works, the next fetch/watch merges the new state in using a
git three-way merge — staged agent edits are preserved; genuinely conflicting
edits get standard `<<<<<<<` markers that the agent is told to repair before
it may publish again.

## Bot trigger phrases (unsigned triggers whitelist)

Some GitLab bots parse comment threads for trigger phrases — `/merge`,
`/test`, your CI's `ci test`, etc. A signature banner on those messages can
confuse them, so `config.json` can whitelist patterns: **when a staged
comment matches, it posts exactly as written, with no signature header.**

```json
{
  "bypassSignaturePatterns": ["^/merge$"],
  "servers": {
    "https://gitlab.example.com": {
      "bypassSignaturePatterns": ["^ci test\\b"]
    }
  }
}
```

- Patterns are JavaScript regexes matched against the trimmed comment body
  (the whole body, not per-line) when deciding to POST unsigned — so anchor
  with `^…$` if you mean exact commands (`/merge|/test` unanchored would
  ALSO match a staged comment that merely mentions those words).
- Watch silencing, however, only quiets comments whose ENTIRE body matches a
  pattern: a colleague's or your own web comment like "check why the /test
  run failed" is prose, not a verbatim trigger, and will still ping. Pi's own
  unsigned posts are silenced primarily by their recorded note ids, so this
  narrowing loses nothing you care about.
- `bypassSignaturePatterns` applies to every instance; entries under
  `servers.<baseUrl>.bypassSignaturePatterns` add patterns for just that
  instance (same base-url keys as `auth.json`). Both are merged.
- The review dialog flags these with
  `[unsigned — whitelist match, no signature header]` so you always see when
  the agent will post without attribution.
- Posts made this way are still remembered as agent posts (their note ids are
  recorded in sidecar state), so the file still marks them `via_pi="true"`
  and watches stay quiet about them (see the bullet above — the pattern itself
  is only a fallback for unrecorded/foreign-machine posts).

## Watches

Ask the agent to "watch" an MR or issue ("keep an eye on this"). It polls on
a configurable interval (default 120s, floor 30s) and messages you/the agent
only when something meaningful changes — e.g.
`[gitlab watch] !1 agents (pi-gitlab extension): 1 new note (1 new thread).`
with paths to the actual file and a `.diff` sidecar showing exactly what
changed. Watches resume automatically when a session reopens, and while any watch is active the pi footer shows a status segment naming them — `gitlab: watching !1 agents` (up to two labels, then `+N more`) — so when the agent sits idle it is visibly still on duty, not doing nothing. New pipelines
notify only on terminal states (success/failed/canceled), not progress.

Silence is attributable: `gitlab_watch list` reports each watch's health
(last tick age, notifications delivered, and every suppression with its
reason — own posts, system notes, whitelisted trigger bodies like `ci test`,
pipeline progress), and a failing watch (bad token, network) says so — in
the session and, after 3 consecutive failed ticks, via a message. The CLI
prints tick errors to stderr. So "why didn't the watch notify?" is one
list call, not an investigation.

## Configuration reference (`~/.pi/agent/gitlab/config/config.json`)

| key | default | meaning |
|---|---|---|
| `confirmBeforePost` | `true` | master safety switch. When `true`, `submit` shows the single review dialog before posting; when `false`, `submit` posts with no dialog — you are never asked. (The agent can always use `submit_bypass_user_review`, but is instructed to do so ONLY when you explicitly tell it to submit without your review.) |
| `signatureHeader` | `_🤖 Automatically written by pi-gitlab (AI agent). Review before acting._` | banner prepended to every posted comment (except whitelist matches). |
| `watchIntervalSeconds` | `120` | default poll interval for watches (minimum 30). |
| `botUsernames` | `[]` | extra usernames to treat as bot accounts. |
| `bypassSignaturePatterns` | `[]` | global unsigned-trigger whitelist regexes (see above). |
| `servers.<baseUrl>.bypassSignaturePatterns` | — | per-instance additions to the whitelist. |

Non-corrupt fields unknown to the extension are ignored, so you can version
the file forward safely.

## CLI for non-pi agents (`bin/pi-gitlab.ts`)

Other agent systems (plain shell scripts, another assistant, a cron job) can
drive the same machinery without loading pi:

```
node extensions/pi-gitlab/bin/pi-gitlab.ts login <base-url>   # token via GITLAB_TOKEN env, --stdin, or a TTY prompt
node extensions/pi-gitlab/bin/pi-gitlab.ts fetch <item-url>
node extensions/pi-gitlab/bin/pi-gitlab.ts put [--dry-run|--submit] <item-url>
node extensions/pi-gitlab/bin/pi-gitlab.ts watch <item-url> [--interval s]
node extensions/pi-gitlab/bin/pi-gitlab.ts skill              # print the agent behavior guide (skills/gitlab-mr-review/SKILL.md)
```

`npm link` inside `extensions/pi-gitlab` gives a global `pi-gitlab`
alias (package.json `"bin"`) — optional; every invocation above also
works with plain `node`. The file is executable on its own. Either way:
**one behavior guide** — the CLI reminders and `pi-gitlab skill` both
carry the same SKILL.md the pi skill loads, so etiquette/trust/staging
rules are maintained once.

- **Same data, no re-auth.** It reads and writes the identical
  `~/.pi/agent/gitlab/` tree (auth.json 0600, config.json, item files, sidecars).
  Setup once with `/gitlab-auth` in pi and the CLI reuses it (and vice versa).
- `fetch` prints a JSON `{file, diff, serverChanged, conflicted}`;
  `put --dry-run` prints the planned actions and exits, `--submit` posts
  **with no review dialog** (there is no operator to ask — the batch is
  yours to audit via the preview); `watch` refreshes the file and exits 0
  on the first meaningful change printing the usual one-line notice.
- Every command **echoes short agent-reminders to stderr** (trust rules,
  staging semantics, banner note; silence with `--quiet` / `PI_GITLAB_QUIET=1`)
  so stdout stays parseable.
- **One agent per item at a time.** A per-item lock
  (`~/.pi/agent/gitlab/.store/<item>/pi-gitlab.lock`, holder `pi` or `cli`)
  is held by every mutating command. Two systems touching the same MR/
  issue fail fast with named-holder detail (exit 3); locks left by dead
  processes are reclaimed, and one-shot locks older than 30 min are
  treated as crash residue. Ideally you run ONE agent per MR — the lock
  just refuses silently-overlapping work.
- Exit codes: 0 ok · 1 error/validation · 2 put had per-item failures ·
  3 lock conflict · 64 usage.

## What the agent sees (short version)

The agent gets three tools — `gitlab_fetch(url)` (fetch/refresh an item into
its file; first successful fetch unlocks the other two), `gitlab_put(path,
mode)` (dry_run preview → submit with your approval or bypass when
`confirmBeforePost=false`), and `gitlab_watch(url, action)` — plus one
command (`/gitlab-auth`) and a bundled skill with workflow etiquette
(`gitlab-mr-review`). The full file grammar, trust hierarchy, and rules the
agent follows are in [`gitlab-plugin-plan.md`](../../gitlab-plugin-plan.md)
and [`skills/gitlab-mr-review/SKILL.md`](skills/gitlab-mr-review/SKILL.md).

## Development

- Tests: `npm test` (node's native TS runner, no deps).
- Typecheck: `npm run typecheck` (install `typescript` + `@types/node` and
  symlink the pi packages as in this folder's `node_modules/`).
- Live drivers under `scripts/` (auth setup, fetch/put/watch against a real
  instance) mirror the tool calls for testing without a model turn.
