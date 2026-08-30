# Setup

Three things have to exist before CONFIRM/DENY can run: a TrueForge server, a
model provider, and a sandbox provider. TrueForge holds the credentials for the
latter two — **this app never sees a model key, a GitHub token, or a Daytona
key**, and neither does the sandbox. That separation is the safety claim, not a
configuration detail.

```
  this app ──TRUEFORGE_TOKEN──▶ TrueForge ──┬──▶ model provider
  (no other creds)                          ├──▶ GitHub MCP
                                            └──▶ Daytona sandbox
                                                 (runs untrusted code,
                                                  holds no credentials)
```

## 1. Run TrueForge

```sh
npx @truefoundry/trueforge@latest
```

Defaults to `http://localhost:3000` with SQLite. Create an API token in its UI
and put it in `.env` as `TRUEFORGE_TOKEN`.

## 2. Add a model provider

Settings → Model Providers → **Google Gemini**.

| Field | Value |
|---|---|
| API key | your Google AI Studio key |
| Model | `gemini-3.1-flash-lite` |

The FQN is `<provider name>/<model name>` — set it as `CONFIRM_DENY_MODEL`,
e.g. `google-gemini/gemini-3.1-flash-lite`.

Verified 2026-08-30 — streaming tool calls work, zero SSE comment lines, ~1.3s
to first function call.

> [!danger] Gemini 3.x requires `thought_signature` to be replayed
> A Gemini 3.x model returns an opaque `thoughtSignature` attached to each
> `functionCall` part. When you send that call back in the conversation
> history, **the signature must come with it verbatim**. Drop it and the next
> request fails:
>
> ```
> HTTP 400  Function call is missing a thought_signature in functionCall parts.
> ```
>
> Measured across a replay of one tool call:
>
> | Model | replay without signature | replay verbatim |
> |---|---|---|
> | `gemini-3.1-flash-lite` | **400** | OK |
> | `gemini-3.5-flash` | **400** | OK |
> | `gemini-2.5-flash` | OK | OK |
>
> **The symptom to watch for:** the agent makes exactly **one** tool call, then
> the turn dies. Not a loop that degrades — a loop that stops at step two. If
> you see that, this is why, and it is a client bug, not a model or prompt
> problem.
>
> **Fallbacks, in order:** a Gemini 2.x model (tolerant of a dropped
> signature); or any non-Gemini provider TrueForge supports natively — OpenAI,
> Anthropic, Zai, Moonshot, Alibaba, Together, Fireworks — none of which have
> this requirement.

> [!danger] Do not route this through OpenRouter
> OpenRouter prefixes **every** stream with `: OPENROUTER PROCESSING` SSE
> comment lines. A parser that does not skip lines beginning with `:` throws
> **`Unexpected end of JSON input`**, which is what TrueForge does.
>
> This is not a slow-model artifact — it was reproduced on every model tested,
> including one that answered in 1.0 seconds. Gemini direct emits **zero**
> comment lines.

**If you substitute a model, test streaming tool calls and nothing else** —
that is the entire workload, and it is where this breaks. Avoid `-latest`
aliases: `gemini-flash-latest` returned 503 under load. Backups verified clean:
`gemini-3.5-flash`, `gemini-3.5-flash-lite`.

## 3. Add the sandbox provider

Settings → Sandbox → **Daytona** (the only provider TrueForge supports).

| Field | Value |
|---|---|
| API key | your Daytona key (`dtn_…`) |
| API URL | `https://app.daytona.io/api` |
| Exec timeout | `60000` ms — raise it if a repro needs longer per command |

## 4. Add the GitHub MCP connector

Settings → Connectors → **GitHub**. Name it `github` (or set
`GITHUB_MCP_SERVER`). It needs a PAT with `repo` scope to read issues and post
comments.

## 5. Register the skill

Settings → Skills → add from this repo, path `skills/repro-playbook`, pinned to
a ref. Pin it to a **commit SHA before demoing** so a mid-demo push cannot
change agent behaviour.

## 6. Check the gate before trusting it

```sh
node packages/runner/src/cli.ts preflight
```

This lists the GitHub MCP server's **live** tools, resolves the approval policy
against them using the harness's own selector logic, and **exits non-zero if any
write path is ungated**.

Run it. TrueForge's `requireApprovalForTools` list *replaces* the default rather
than extending it, and its literal tool names are never validated — so a stale
or misspelled name gates nothing and tells you nothing. This command is the only
thing standing between that and a demo where the agent posts a comment nobody
approved.

## 7. Triage something

```sh
node packages/runner/src/cli.ts triage https://github.com/ansu555/colwrap/issues/1
```

`ansu555/colwrap` is the seeded demo target. Issues #1–#4 are written to produce
four *different* verdicts, which is what shows the agent is judging rather than
agreeing.
