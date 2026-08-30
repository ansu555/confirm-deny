# Verdict rules

Five verdicts. Each one may only be reached when the evidence that justifies it
is in hand. These rules are enforced by a schema after you write the case file —
if the verdict and the evidence disagree, the case file is rejected.

| Verdict | Means | You must have |
|---|---|---|
| `REPRODUCED` | The failure was observed | Evidence, **non-zero exit code**, a repro script |
| `CANNOT_REPRODUCE` | Ran faithfully, did not fail | Evidence, **zero exit code**, what you tried and varied |
| `NEEDS_INFO` | The report lacks something essential | **No evidence**, and exactly one specific question |
| `DUPLICATE` | Same root cause as an existing issue | ≥1 linked issue, each with a stated reason |
| `NOT_A_BUG` | Behaviour is as documented | A link to the doc or test that defines it |

## The traps

**Do not reach for `REPRODUCED` because the issue looked convincing.** The exit
code decides, not the prose. If the script exited 0, you did not reproduce it —
either the bug needs different conditions, or it is not there.

**Do not reach for `CANNOT_REPRODUCE` when your setup failed.** A missing
dependency, a wrong Python version, a clone that 404'd — those are not evidence
that the bug is absent. That is a broken attempt. Fix the setup, or return
`NEEDS_INFO` explaining what you could not get working. Claiming a
non-reproduction on the back of a broken environment is the single most harmful
thing you can do here: it closes a real bug.

**`NEEDS_INFO` is not a way out of a hard reproduction.** It is for reports
missing something you cannot infer. If you can infer the version from a
traceback or a lockfile in the thread, infer it and proceed.

**`DUPLICATE` requires a reason, not a resemblance.** "Both mention wrapping" is
not a root cause. State the shared mechanism.

**`NOT_A_BUG` requires a citation.** Your reading of the intent is not enough —
find the docs, the docstring, or the test that pins the behaviour. If no such
thing exists, the behaviour is undocumented, and that is a real finding, not a
`NOT_A_BUG`.

## unverifiedClaims

List everything load-bearing that you could not check. Examples that belong
there:

- "The reporter says this started after upgrading; I did not test their prior version."
- "I could not confirm the reporter's OS — I ran Linux, they may be on Windows."
- "The workaround suggested in comment #3 is untested."

An empty `unverifiedClaims` on a complicated report is not a strong case file.
It is an incomplete one.
