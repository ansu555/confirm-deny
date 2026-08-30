# Setup — the long version

The [README](README.md#setup) has the six-step path. This file is the detail behind it: the
traps, the measurements, and the reasoning. Read it when a step does not behave.

Three things must exist before CONFIRM/DENY can run: a **TrueForge server**, a **model
provider**, and a **sandbox provider**. TrueForge holds the credentials for the latter two —
**this app never sees a model key, a GitHub token, or a Daytona key**, and neither does the
sandbox. That separation is the safety claim, not a configuration detail.

```
  this app ──TRUEFORGE_TOKEN──▶ TrueForge ──┬──▶ model provider
  (no other creds)                          ├──▶ GitHub MCP
                                            └──▶ Daytona sandbox
                                                 (runs untrusted code,
                                                  holds no credentials)
```

---

## 1. Run TrueForge

```sh
npx @truefoundry/trueforge@latest
```

This is **local mode**: one process, SQLite, no Docker. It serves `http://localhost:8790`.

The boot log includes:

```
Auth is disabled; browser login is off
```

That is why `TRUEFORGE_TOKEN` is **empty**. There is no token to create and no UI login to
perform — leave the variable blank and the SDK sends no auth header.

> [!WARNING]
> Local mode is explicitly not a production or internet-facing setup: no login, data in a
> local SQLite file. For anything shared, use hosted mode — Postgres + Redis, via Docker
> Compose or the `charts/trueforge` Helm chart.

## 2. Configure it over HTTP, not the UI

Every step the quickstart describes as a click is a `POST`/`PUT` under `/api/v1/settings/*`:

| Thing | Endpoint |
|---|---|
| Model provider | `/api/v1/settings/model-providers` |
| Sandbox provider | `/api/v1/settings/sandbox-providers` |
| MCP server | `/api/v1/settings/mcp-servers` |
| Skill | `/api/v1/settings/skills` |

The exact request schemas are served at `/api/v1/openapi.json`. Read them before guessing a
field name — see the Zod warning at the bottom of this file for why that matters.

## 3. Add a model provider

The FQN is `<provider name>/<model name>`, and **dots are replaced with dashes**. A model
registered as `gemini-3.1-flash-lite` is addressed as `google-gemini/gemini-3-1-flash-lite`.
Set the result as `CONFIRM_DENY_MODEL`. `GET /api/v1/models` lists what your instance actually
exposes — use that, not what you think you registered.

> [!IMPORTANT]
> **Declare the model's real `context_length`.** A value smaller than the model's actual
> window will cancel a long triage that would otherwise finish, and the only symptom is
> `status: cancelled` with `error: null`. Declaring `131072` for a model with a ~1.3M window
> cost three failed runs here.

**What the verified runs used:** `openrouter/glm-5-3-flash`. Not because it is the best model,
but because it was the one that stayed available — see below.

<details>
<summary><b>Model availability was the binding constraint, not capability</b></summary>

<br/>

The free Google AI Studio tier returned `429` after roughly one full triage, on both
`gemini-3-1-flash-lite` and `gemini-3-5-flash`. Rate limits, not reasoning, decided which model
this project shipped on.

If you substitute a model, **test streaming tool calls and nothing else** — that is the entire
workload and it is where this breaks. Avoid `-latest` aliases: `gemini-flash-latest` returned
503 under load.

</details>

<details>
<summary><b>Gemini 3.x requires <code>thought_signature</code> to be replayed</b></summary>

<br/>

A Gemini 3.x model returns an opaque `thoughtSignature` attached to each `functionCall` part.
When that call is sent back in the conversation history, **the signature must come with it
verbatim**. Drop it and the next request fails:

```
HTTP 400  Function call is missing a thought_signature in functionCall parts.
```

Measured across a replay of one tool call:

| Model | replay without signature | replay verbatim |
|---|---|---|
| `gemini-3.1-flash-lite` | **400** | OK |
| `gemini-3.5-flash` | **400** | OK |
| `gemini-3.6-flash` | **hangs** | OK |
| `gemini-2.5-flash` | OK | OK |

Re-confirmed on `gemini-3-6-flash` during a full triage: the agent read
`SKILL.md`, the sandbox came up, and then the turn simply stopped — one tool
call, four events, `status: null`, `error: null`, no timeout. It does not always
surface as a 400; sometimes the turn just never advances.

**The symptom to watch for:** the agent makes exactly **one** tool call, then the turn dies.
Not a loop that degrades — a loop that stops at step two. That is a client bug, not a model or
prompt problem.

**Fallbacks, in order:** a Gemini 2.x model (tolerant of a dropped signature), or any
non-Gemini provider.

</details>

<details>
<summary><b>Correction: OpenRouter works fine on TrueForge v0.1.4</b></summary>

<br/>

An earlier version of this file warned against routing through OpenRouter, on the theory that
its `: OPENROUTER PROCESSING` SSE comment lines break a strict parser and produce
`Unexpected end of JSON input`.

**That is not TrueForge's behaviour.** v0.1.4 parses the stream cleanly, and every verified run
in this repository went through OpenRouter. The warning is left here, corrected rather than
deleted, because a stale caution that sends people away from a working provider is its own kind
of bad evidence.

</details>

## 4. Add the sandbox provider

Daytona is the only provider TrueForge supports.

| Field | Value |
|---|---|
| API key | your Daytona key (`dtn_…`) |
| API URL | `https://app.daytona.io/api` |
| Exec timeout | `60000` ms — raise it if a repro needs longer per command |
| Auto-delete | 30 minutes |

Two things that will stop you:

- **Set a default region in the Daytona dashboard.** Without one, sandbox provisioning returns
  a `500` with `no default region`, which reads like a TrueForge fault and is not.
- **Sandboxes accumulate.** Ten idle boxes hit the 30 GiB account disk cap and every new run
  fails. `auto_delete` is not optional housekeeping.

> [!CAUTION]
> **Verify the sandbox is real.** Standalone TrueForge logs
> `Local sandbox fallback is available` and will execute the repro **on the host** if no
> sandbox provider is configured. The run looks entirely successful while doing the one thing
> this project promises never to do.
>
> Check the sandbox id in the CLI output starts with `v1:daytona:`.

## 5. Add the GitHub MCP connector

Name it `github` (or set `GITHUB_MCP_SERVER`). It needs a PAT with `repo` scope to read issues
and post comments. The live connection exposes 47 tools; `preflight` will show you which are
writes.

## 6. Register the skill

Add from this repo at path `skills/repro-playbook`.

**Pin it to a commit SHA before demoing** so a mid-demo push cannot change agent behaviour.

## 7. Check the gate before trusting it

```sh
node packages/runner/src/cli.ts preflight
```

This lists the GitHub MCP server's **live** tools, resolves the approval policy against them
using the harness's own selector logic, and **exits non-zero if any write path is ungated**.

Run it every time. `requireApprovalForTools` *replaces* the default rather than extending it,
and its literal tool names are **never validated** — so a stale or misspelled name gates
nothing and tells you nothing. We shipped a gate for `update_issue_labels`, a tool that does
not exist, for three days. It read as a safety control in the source and was never there at
runtime.

## 8. Triage something

```sh
node packages/runner/src/cli.ts triage https://github.com/ansu555/colwrap/issues/1
```

`ansu555/colwrap` is the seeded demo target. Issues #1–#4 are written to produce four
*different* verdicts, which is what shows the agent is judging rather than agreeing.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `status: cancelled`, `error: null` | Iteration limit (raise `CONFIRM_DENY_ITERATION_LIMIT`) **or** a `context_length` declared smaller than the model's real window. There is no other signal — check both. |
| Agent makes exactly one tool call, then stops | Gemini 3.x `thought_signature` not replayed. Client bug. |
| Sandbox provisioning returns `500` | No default region set in the Daytona dashboard. |
| Every run fails after several successes | Daytona 30 GiB disk cap from accumulated sandboxes. |
| Connection hangs on the model gateway | Node resolving over IPv6. Prefix with `NODE_OPTIONS=--dns-result-order=ipv4first`. |
| A config value you set has no effect | See below. |

### Zod strips unknown keys silently

TrueForge's config objects are non-strict. An unknown key is **dropped, not rejected** — so a
misspelled field loses its value *and* leaves the required field missing, with nothing pointing
at the typo.

```js
z.object({ a: z.string() }).parse({ a: 'x', bogus: 1 })   // → { a: 'x' }
```

This is why step 2 says to read `/api/v1/openapi.json` rather than guess a field name.
