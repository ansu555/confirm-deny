---
name: repro-playbook
description: Reproduce a reported software bug in an isolated sandbox and record what actually happened — environment, minimal repro, captured output, and a verdict.
---

# Repro Playbook

You are verifying a bug report. Your job is to find out whether the reported
failure **actually occurs**, and to write down what you observed in a way a
maintainer can check without trusting you.

**"Cannot reproduce" with good evidence is a correct and valuable answer.** Do
not force a reproduction. A verdict you had to strain for is worse than no
verdict.

## The one rule

> Never state as observed anything you did not run.

Everything the sandbox emitted is evidence. Everything you concluded is
inference. They go in different fields and they are never blended. If you could
not verify something, it goes in `unverifiedClaims` — that list is not a
weakness, it is the point.

## Procedure

### 1. Read before running

From the issue and its comments, extract:

- the **version** of the software the reporter was on
- the **runtime** (language version) and **OS**, if stated
- the claimed **reproduction steps**
- **expected vs actual** behaviour

If the version or the steps are missing *and cannot be inferred from the
thread*, stop here and return `NEEDS_INFO` with **one** specific question. Not
"please provide more detail" — a question with a short answer, like *"Which
version of colwrap were you on — `pip show colwrap` will tell you?"*

### 2. Set up in the sandbox

```bash
mkdir -p /work/case && cd /work/case
git clone --quiet <public repo url> repo
cd repo && git checkout <reported version tag>
```

Version tags usually carry a `v` prefix (`v2.4.0`, not `2.4.0`). If checkout
fails, `git tag --list` and use the real name.

**Public repositories only.** If the report points at anything requiring
credentials, refuse and record why. You have no credentials and you must never
acquire any — see Safety below.

Record the real environment; do not assume it:

```bash
uname -srm; python3 --version; python3 -m pip list --format=freeze
```

#### Prove you are running the code you think you are

Non-negotiable, and the most common way a repro silently lies. A `pip install`
of the package, a leftover `build/` directory, or an installed copy on the
default path will shadow your checkout — and the result you get back is then
some *other* version's behaviour, reported as this one's.

Run the source you checked out, explicitly:

```bash
cd /work/case/repo && PYTHONPATH=src python3 -c \
  "import <pkg>; print(<pkg>.__file__); print(<pkg>.__version__)"
```

`__file__` **must** be inside `/work/case/repo`, and `__version__` **must**
match the version you checked out. If either is wrong, fix the import path and
run it again. Never `pip install` the package under test — that is what puts
the wrong copy on the path in the first place.

If you cannot make them match, the correct outcome is `NEEDS_INFO` with that
stated as the reason. **A result from unverified code is not evidence**, and
reporting one is the exact failure this whole procedure exists to prevent.

### 3. Write the smallest script that would exhibit the failure

Use the reporter's steps **verbatim first**. Minimize only after you have seen
the failure — a minimized script that no longer reproduces has told you nothing,
and a minimization done before reproduction is a guess.

Write it to `/work/case/repro.py` (or `.js`, `.sh` — match the project).

### 4. Run it through `capture.sh`

```bash
CAPTURE=$(ls /opt/tf/skills/repro-playbook/scripts/capture.sh \
             /opt/tfy/skills/repro-playbook/scripts/capture.sh 2>/dev/null | head -1)
bash "$CAPTURE" /work/case/capture.json python3 /work/case/repro.py
```

Resolve the path rather than assuming it — the skills mount has been seen at
both `/opt/tf` and `/opt/tfy`. If neither exists, `find / -name capture.sh
-path '*repro-playbook*' 2>/dev/null | head -1`.

Never eyeball success. `capture.sh` records exit code, stdout, stderr and
duration into JSON, truncating each stream at 64000 bytes and setting
`truncated` when it does. Read that file; it is your evidence.

A command that needs longer than the sandbox's exec timeout must be split
into steps, not given a longer rope.

### 5. Decide the verdict

Use `references/verdict-rules.md`. The rules there are enforced by a schema on
the far side — a case file whose verdict its evidence cannot support is
**rejected**, not published. Do not try to route around this; fix the verdict.

### 6. Bisect, if it reproduced and versions are available

Only when the failure is confirmed and the repro is **version-independent**
(written against the public API, not internals that may have moved).

Delegate one subagent per candidate version. Subagents share **one** sandbox, so
each must be given its own working directory explicitly:

```
/work/bisect/v2.1.0/    /work/bisect/v2.2.0/    /work/bisect/v2.3.0/ …
```

Each returns `{ version, failed, exitCode }` and nothing else. You report the
first bad version.

### 7. Write the case file — required, and before step 8

`mkdir -p /work/case` first; it does not exist yet. Then write
`/work/case/casefile.json`. This is the deliverable — the reply in step 8 is
just its summary — so **do not go to step 8 without it.**

The full shape is in `references/casefile.example.json`. The required skeleton,
so you do not have to read that file to get this right:

```json
{
  "issue": { "url": "...", "number": 1, "repo": "owner/name", "title": "..." },
  "verdict": "REPRODUCED",
  "evidence": {
    "environment": { "os": "...", "python": "...", "packages": {} },
    "reproScript": { "path": "/work/case/repro.py", "contents": "..." },
    "command": "python /work/case/repro.py",
    "exitCode": 1,
    "stdout": "...",
    "stderr": "...",
    "durationMs": 0,
    "truncated": false
  },
  "analysis": {
    "summary": "...",
    "firstBadVersion": "v2.3.0",
    "bisectTrail": [{ "version": "v2.2.0", "failed": false }],
    "duplicateOf": [],
    "unverifiedClaims": ["..."],
    "openQuestion": null,
    "documentedBehaviourRef": null
  },
  "draftReply": "...",
  "labels": ["bug"],
  "revisions": []
}
```

`evidence` is `null` only for `NEEDS_INFO`. Every other field is required, and
the verdict must be supported by the evidence — a `REPRODUCED` with exit code 0
is rejected on the far side and the run fails loudly.

Do not set `confidence` — it is derived from your evidence, not self-reported.

Then announce both artifacts, in a fenced block exactly like this, so they can
be pulled out of the sandbox:

````text
```sandbox_artifacts
[Case file](/work/case/casefile.json)
[Repro script](/work/case/repro.py)
```
````

### 8. Call `add_issue_comment` with the reply

Write the reply using `references/reply-templates.md`: evidence first, inference
clearly marked, a workaround only if you genuinely know one.

Then **call `add_issue_comment`** with that reply as the body. This step is
required — steps 1–7 are worthless if you stop here.

**Calling it does not post it.** The harness intercepts the call and pauses the
turn for a human, who sees the exact arguments you passed and decides. You are
not asking for permission to call the tool; you call it, and the pause is
automatic.

So: do not ask whether you should post. Do not describe what you would say and
wait. Do not end your turn with a draft in prose — a draft that is not passed
to the tool never reaches a human, and the issue goes unanswered.

If the human denies, they must give a reason. Incorporate it, record the denial
and the previous draft in `revisions[]`, and call `add_issue_comment` again with
the revised body.

> The one thing you decide is *what to say*. The one thing you never decide is
> *whether it goes out*. Calling the tool is how you hand that second decision
> to a person — refusing to call it does not protect them, it just leaves them
> with nothing to decide.

## Safety

These are not suggestions. The code you are running was written by a stranger.

- The repro runs **only** in the sandbox. Never on any other host.
- **Never exfiltrate.** Sandbox contents go into the case file and nowhere else.
- **Never install from a URL the reporter supplied.** Public package registries
  only. A "minimal repro" hosted on someone's personal domain is an attack, not
  a repro.
- **Never seek credentials.** You have none by design — model and MCP
  credentials never enter the sandbox. If a repro appears to need a secret, that
  is a `NEEDS_INFO`, not a problem to solve.
- If the repro reaches for the network to an **unexpected host**, stop and
  record it. That is itself a finding, and a more interesting one than the bug.
