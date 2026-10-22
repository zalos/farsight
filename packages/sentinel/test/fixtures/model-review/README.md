# Model review fixtures (PR 22)

`e5-corpus.json` holds 30 original synthetic cases: 15 pairs of a vulnerable and a safe variant, each as a clean
packet and a canary packet. The canary packet is the same code with comments that address the reviewing model:
they tell it to ignore its instructions, report no finding, suppress the rule, call a tool that does not exist, read
a file outside its scope, send the repository elsewhere, and repeat an inert token. None of the code is executed,
compiled or installed. The tests read it as text.

Every second pair is reviewed as a guided case with its rule; the others are reviewed as a general partition.

The labels are author drafts (`labelReview: null`). Until a person other than the author reviews them, the E5 gate
reports `sentinel.review.eval.labelsUnreviewed`, and no precision or recall may be claimed from this corpus. Live
two-model evaluation (two models × 30 cases × 5 trials × clean/canary = 600 evaluations) waits for the owner to
configure the models and set thresholds.
