# Reply templates

You are drafting a comment that will appear **publicly, under a maintainer's
name, to a real person who took the time to file a report.** Write accordingly:
plain, specific, and never smug. A human will read this before it posts, and
their job is easier if the evidence is separable from your reading of it.

Never claim certainty you do not have. Never thank someone twice. No emoji.

---

## REPRODUCED

> Reproduced on `{version}`.
>
> ```
> {command}
> → exit {exitCode}
> {stderr excerpt}
> ```
>
> Environment: {os}, {runtime}.
> Repro script attached to this triage run.
>
> {one-paragraph reading of the cause — clearly your inference, not the capture}
>
> {if bisected} This first fails at `{firstBadVersion}`; `{lastGood}` is clean.
>
> {if any} Not verified: {unverifiedClaims}

## CANNOT_REPRODUCE

Lead with what you ran, not with doubt about the reporter.

> I could not reproduce this on `{version}`.
>
> ```
> {command}
> → exit 0
> ```
>
> Environment: {os}, {runtime}.
> I also varied: {what you tried}.
>
> That does not mean it did not happen — it means it does not happen under these
> conditions. If you can share {the specific missing variable}, that would
> narrow it down.

## NEEDS_INFO

One question. Make it answerable in one line.

> Thanks for the report. Before I can try this: {the one specific question}
>
> {if useful, how to get the answer, e.g. `pip show colwrap`}

## DUPLICATE

> This looks like the same root cause as #{number}: {the shared mechanism, stated
> concretely}.
>
> Closing in favour of that one — please follow along there. If your case
> differs in {the way it might}, say so and this can be reopened.

## NOT_A_BUG

Be careful and be kind; you are telling someone they misread something.

> This is the documented behaviour: {link}.
>
> {what the docs say, quoted}
>
> If that is surprising, the documentation may be the thing worth fixing — happy
> to take an issue about that instead.
