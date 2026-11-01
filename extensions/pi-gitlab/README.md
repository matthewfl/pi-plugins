# pi-gitlab

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that lets
the agent work with **GitLab merge requests and issues** — reading and
replying to discussion threads, leaving code-review comments, updating
descriptions or titles, resolving threads, and watching items for changes — while
keeping the human in control with review-gated writes by default.

## Why you might want it

- **Review before posting by default.** The agent stages everything it
  wants to say as edits in one local file; when it's done, you get a single
  review dialog with the whole batch. Approve once, or cancel and nothing
  happens. Explicit bypass mode, disabling `confirmBeforePost`, and CLI
  `put --submit` skip this dialog (see below).
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

Requires Node.js **22.19+**, Pi, and `git` on your `PATH` (used for
three-way merges and diffs).

1. Install the extension:
   ```sh
   pi install npm:@matthewfl/pi-gitlab
   ```
   Restart Pi (or run `/reload` in an existing session). To try it without
   saving an installation, use `pi -e npm:@matthewfl/pi-gitlab`.
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

Example `config.json` with every key set to its default value:

```json
{
  "confirmBeforePost": true,
  "signatureHeader": "_🤖 Automatically written by pi-gitlab (AI agent). Review before acting._",
  "botUsernames": [],
  "watchIntervalSeconds": 120,
  "bypassSignaturePatterns": [],
  "servers": {}
}
```

All keys are optional; omitted keys use these defaults. `servers` is empty
by default; see the bot-trigger example above for per-server overrides.

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

```sh
npm install --global --omit=peer @matthewfl/pi-gitlab
pi-gitlab login <base-url>   # token via GITLAB_TOKEN env, --stdin, or a TTY prompt
pi-gitlab fetch <item-url>
pi-gitlab put [--dry-run|--submit] <item-url>
pi-gitlab watch <item-url> [--interval s]
pi-gitlab skill             # print the agent behavior guide
```

The standalone CLI has no runtime npm dependencies; `--omit=peer` avoids
installing the Pi host packages it does not need. The npm package ships a
compiled JavaScript CLI, so no TypeScript runner is required. From a source
checkout, `node bin/pi-gitlab.ts ...` also works on Node.js 22.19+. Either way:
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
agent follows are in
[`skills/gitlab-mr-review/SKILL.md`](skills/gitlab-mr-review/SKILL.md).

## Development

Run these commands from `extensions/pi-gitlab` in the repository:

```sh
npm ci
npm run typecheck
npm test
npm run build
pi -e ./index.ts
```

- `npm run build` compiles the standalone CLI into `dist/` and copies its
  behavior guide. Pi loads the TypeScript extension directly.
- `npm run load-check` checks extension loading and the auth dialog via a
  local Pi executable, using fake credentials and an isolated data directory.
- `npm run package-check` packs and installs the tarball in a temporary
  directory, checks the installed CLI and bundled guide, and runs the Pi
  load check against the installed extension.
- Live drivers under `scripts/` (auth setup, fetch/put/watch against a real
  instance) mirror the tool calls for testing without a model turn.

## Publishing

From `extensions/pi-gitlab`, with npm credentials authorized for the
`@matthewfl` scope:

```sh
npm ci
npm run typecheck
npm test
npm run package-check
npm pack --dry-run   # builds the CLI and lists public package contents
npm publish         # publishConfig.access is public
```

The initial version is `0.1.0`; increment `package.json`'s version for each
subsequent release. Only runtime TypeScript modules, the compiled CLI, skills,
README, license, and package metadata are included; tests, live drivers, and
local configuration are excluded. `prepublishOnly` runs typechecking and tests,
and `prepack` builds the CLI automatically.

## License

[MIT](LICENSE).
