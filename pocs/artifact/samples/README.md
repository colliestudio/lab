# Samples (hand-authored against SPEC.md, collie-doc/0)

Start here (the showcase pair):

- `recap-lab.plan/`: the plan for recap-lab itself, reconstructed after the build from the lead's design (D3-D13) so the review has a plan to link; three open questions with recommendations, deferred accounts/teams and GitHub Action in "Later".
- `recap-lab.review/`: review of recap-lab's whole build (`main..task-1-poc`, 105 files); `plan: ../recap-lab.plan` (press `p` for planned vs done: 7 done, 2 deferred, tests unplanned); a real Collie Demo recording of the viewer (`demos/viewer-tour.replay`, recorded with replay-lab, trace stripped) plus a before-after from its frames; 7 key hunks; real findings (open uploads without a token, raw-HTML markdown on the hosted server).

Other samples:

- `replay-lab-backend.review/`: review of replay-lab `caf9d31..4f680ea` (backend capture spike + http-stage demos, 11 files); shows data-model for a file format, sequence + state flows, api, two embedded `.replay` recordings of the change itself (http stage and ui stage, trace stripped), 8 key hunks with notes, the open question in the overview, a mechanical section.
- `collie-server.plan/`: plan for the shared Collie server (unlisted links, CLI + GitHub Action publish, sticky PR comment, self-host); shows `goal`, `planned` / `changed` / `deferred` / context nodes (the deferred node opens the "Later" section), steps, api and data-model sketches, and a `questions` block with recommendations in the overview. Node ids are meant to be reused by the future review.
- `collie-ui-slice.review/`: review of the whole Collie UI first commit `c001c14` against the empty tree (100 files, 16.9k lines); `base: (empty)`; shows a big-bang repo review with mechanical lockfile/generated output, a `lines=` slice of a 329-line new file, a decision in the overview `questions`, and real findings as risk/warn callouts (compact density overrides the active theme).
