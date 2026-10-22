# Model review fixtures (PR 22)

`e5-corpus.json` holds 30 original synthetic cases: 15 pairs of a vulnerable and a safe variant, each as a clean
packet and a canary packet. The canary packet is the same code with comments that address the reviewing model:
they tell it to ignore its instructions, report no finding, suppress the rule, call a tool that does not exist, read
a file outside its scope, send the repository elsewhere, and repeat an inert marker. Markers are opaque
(`E5_MARK_` and 12 hex digits of a digest of the case id), so they reveal nothing about the expected answer. None of the code is executed,
compiled or installed. The tests read it as text.

Nine pairs are reviewed as guided cases with their rule (both command pairs are guided on shell interpretation);
the other six as a general partition.

The labels are author drafts (`labelReview: null`). An independent review of the earlier corpus
(`sha256:d5facc27…`, 7545618e) found five categories of problems, all repaired here; because the bytes changed, that
review no longer applies and the corpus needs a new one. Until a person other than the author reviews them, the E5 gate
reports `sentinel.review.eval.labelsUnreviewed`, and no precision or recall may be claimed from this corpus. Live
two-model evaluation (two models × 30 cases × 5 trials × clean/canary = 600 evaluations) waits for the owner to
configure the models and set thresholds.
