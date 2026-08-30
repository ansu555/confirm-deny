# CONFIRM/DENY

Turns an unverified bug report into a **verified case file** — or a defensible
*"cannot reproduce"* with proof of what it tried.

It never runs a stranger's code on the maintainer's machine, and it never posts
in their name until they say so.

Built on [TrueForge](https://github.com/truefoundry/trueforge) for The Agent
Harness Hackathon.

---

## What it actually does

Given a GitHub issue URL, the agent:

1. reads the issue and its thread (GitHub MCP, read-only, ungated)
2. clones the repo **inside a Daytona sandbox** at the reported version
3. writes the smallest script that would exhibit the failure and runs it,
   capturing exit code, stdout, stderr, and duration
4. reaches a verdict — `REPRODUCED`, `CANNOT_REPRODUCE`, `NEEDS_INFO`,
   `DUPLICATE`, or `NOT_A_BUG`
5. writes a schema-validated case file separating **evidence** (what the
   sandbox emitted) from **inference** (what the model concluded)
6. calls `add_issue_comment` — **and the turn stops there, for a human**

Here is a real reply it produced for [`colwrap#1`](https://github.com/ansu555/colwrap/issues/1),
having found the bug unaided:

> This is caused by an off-by-one error in the `_fits` helper function, which
> uses a strict inequality (`<`) instead of a non-strict one (`<=`) when
> checking if a word fits on the current line.

It was told the symptom. It found the operator.
The full reply is [posted on the issue](https://github.com/ansu555/colwrap/issues/1#issuecomment-5468809989),
approved by a human at the gate.

The case file behind that reply, pulled from the sandbox and validated:

```
verdict    : REPRODUCED
confidence : low (derived)
exitCode   : 1
firstBad   : v2.3.0
bisect     : v2.0.0 ✓  v2.1.0 ✓  v2.2.0 ✓  v2.3.0 ✗  v2.4.0 ✗
```

**`confidence` is the interesting field.** It came out `low` on a run that got
everything right, because the agent listed five things it could not verify —
the reporter's Python 3.11 (the sandbox had 3.13.15), their exact width-72 text
(never shared), the fix against `indent` / `break_long_words` /
`wrap_paragraphs`. Confidence is derived from the evidence on our side, never
reported by the model, so honesty costs the agent its score and it has no way to
inflate it. That is the design working, not a weak result.

## The informed gate

Approval prompts are common. Most are rubber stamps, because the human is asked
*"post this comment — OK?"* with the evidence forty messages up the scroll.

CONFIRM/DENY's gate arrives carrying the traceback, the exit code, the runnable
repro, and an explicit list of **what the agent could not verify** — the field
that actually causes a human to press Deny.

Two decisions make it a gate rather than a checkbox:

- **The exact payload is shown verbatim.** Never a paraphrase. If a human
  approves a summary, they did not approve the action.
- **Deny requires a reason.** The harness makes `reason` optional. We do not.
  The reason goes back into the agent's context, it revises, and it asks again.

## Try it

Requires Node ≥ 22.14, a Daytona API key, a model provider key, and a GitHub
PAT with `repo`.

```bash
# 1. the harness — local mode: one process, SQLite, no Docker
npx @truefoundry/trueforge@latest        # serves http://localhost:8790

# 2. configure it (see SETUP.md — every step is an API call, not a click)

# 3. audit the approval policy against the LIVE tool list
node packages/runner/src/cli.ts preflight

# 4. triage a real issue
node packages/runner/src/cli.ts triage https://github.com/ansu555/colwrap/issues/1

# optional: publish the same agent so it runs from the TrueForge chat UI
node packages/runner/src/register-agent.ts
```

Set `CONFIRM_DENY_MODEL` to a model your instance exposes, exactly as
`GET /api/v1/models` names it — `openrouter/glm-5-3-flash`, say. Provider names
replace dots with dashes, so `gemini-3.1-flash-lite` is registered as
`gemini-3-1-flash-lite`. `TRUEFORGE_TOKEN` is empty in local mode, which
disables auth.

`preflight` refuses to start if any write path on your server would run
ungated:

```
✓ every write path on this server pauses for a human
  gated: 19 tools (18 @write + delete_file)
```

**Run `preflight` first, always.** It is not a formality — see below.

## Why the harness is load-bearing

Every feature here is used because removing it makes the job impossible, not to
tick a box.

| Feature | Remove it and… |
|---|---|
| **Sandbox** | you are executing a stranger's repro on your laptop |
| **Tool approval** | the agent posts in the maintainer's name unreviewed |
| **Skills** | the repro procedure is a wall of prompt, loaded always |
| **MCP** | no issue to read and no reply to post |
| **Sub-agents** | version bisect is serial instead of four tags at once |
| **Context management** | a long issue thread plus sandbox output blows the window |

The credential boundary is **architectural, not a policy we wrote**: the agent
loop and every key stay on the TrueForge server. The sandbox only does exec and
files. There is no supported channel for handing it a credential — which is
also why this works on public repositories only. That is not a limitation to
apologise for; it is the reason the safety claim holds.

## Three things we got wrong, found by running it

Written down because they are more useful than the parts that worked.

**1. Our instructions disabled our own gate.** The skill said *"Draft the reply,
then stop."* The agent spec said *"you never decide to post them."* The per-issue
message said *"Do not post anything."* An obedient model did exactly that:
drafted, called nothing, ended the turn — and **no approval gate ever opened**,
because a gate only fires when the tool is actually called. The wording was
written to sound safe and its effect was to disable the safety mechanism it
described. Refusing to call the tool does not protect the maintainer; it leaves
them with nothing to decide.

**2. We gated a tool that does not exist.** Our approval policy listed
`update_issue_labels` for three days. The first `preflight` against a live
GitHub MCP connection showed that neither it nor `label_write` exists — there is
no label-write tool of any name. Nothing validates `require_approval_for_tools`,
so an unknown literal is silently ignored: it read as a gate in the source and
was never there at runtime. This is why `preflight` audits against the live tool
list instead of trusting the names in our own code.

**3. The local sandbox fallback would have faked a pass.** Standalone TrueForge
logs `Local sandbox fallback is available` and will execute code **on the host**
if no sandbox provider is configured. A run would look completely successful
while doing the one thing this project promises never to do. Check that the
sandbox id starts `v1:daytona:`.

## Tests

```bash
npx vitest run     # 41 tests
```

The one worth pointing at is the **gate regression test**: a fixture of a paused
turn asserting the runner emits exactly one `user.tool_approval` per pending
call, with the right `toolCallId`, and that a deny carries its reason. It goes
red the day the gate stops firing — a regression test for a safety property.

The verdict invariants are executable too, enforced inside the schema rather
than beside it: `REPRODUCED` requires evidence with a non-zero exit code,
`CANNOT_REPRODUCE` requires evidence with a zero exit code, `NEEDS_INFO`
requires no evidence and exactly one specific question, `DUPLICATE` requires a
stated reason. **A verdict that cannot show its evidence fails the build.**

Deliberately not tested: load, cross-browser, and a mocked GitHub MCP server.
Sandbox behaviour is exercised through real runs — a mocked sandbox would test
nothing that matters here.

## Honest status

- The **CLI is the product**; there is no bespoke web UI. A triage desk was
  designed and cut against its own deadline. Instead,
  `node packages/runner/src/register-agent.ts` publishes the same agent to your
  TrueForge instance, so it runs from the stock chat UI — which already ships an
  approval bar with deny-and-reason. A great agent in a stock UI beats a
  mediocre agent in a custom one.
- **Bisect runs in parallel sub-agents**, one working directory each under
  `/work/bisect/<version>/`. This was planned as the first thing to cut; it
  survived because the agent fans out on its own once `dynamicSubAgents` is
  enabled, which is a fair illustration of what the harness is doing for us.
- The store is a JSON file with an atomic write — a deliberate choice, not an
  oversight. TrueForge's session is the source of truth and anything lost is
  recoverable by re-reading it.
- **Model availability, not model capability, was the binding constraint.** The
  free Gemini tier returned `429` after roughly one run; `openrouter/glm-5-3-flash`
  is what the verified runs used. Notably, the OpenRouter SSE stream that had
  been blamed for an earlier `Unexpected end of JSON input` parses cleanly here —
  that was never TrueForge's problem.
- `verify-gate` and `pull-test` style probes were used during development and
  deleted rather than shipped as half-tests.

## Qodo Code Review Evidence

- [PR #1 — Make the agent call the write tool so the approval gate can fire](https://github.com/ansu555/confirm-deny/pull/1)
- [PR #2 — Add CI, and correct the README to match what the project actually does](https://github.com/ansu555/confirm-deny/pull/2)

Both merged. Every substantive change after the first live run went through a
pull request rather than straight to `main`, and PR #2 merged green on CI —
typecheck plus the 41 tests.

Stated plainly, because the project's own honesty rule applies to its own
README: **the trail is real but thin.** The build spent its day standing the
harness up, and the pull requests start from the point where the agent first
ran end to end. Earlier commits went directly to `main` via an editor
auto-committer, which is visible in the history and is not backdated or
disguised here.

## Licence

MIT
