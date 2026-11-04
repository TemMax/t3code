# Thread activity

Checks that the live activity label ("researching", "testing", and so on) names the right phase and a sensible subject. It calls the real `generateThreadActivity` path with digests in the format of `buildActivityDigest`.

## Run

```sh
cd evals
pnpm thread-activity --model claude-haiku-5-5 --out runs/activity-haiku --samples 5
pnpm thread-activity --model gpt-6-luna --out runs/activity-luna --case testing-todo-beats-edits
```

- `claude-*` models run through the Claude CLI, `gpt-*` models through Codex. Both use your local login.
- Flags: `--model <id>`, `--out <dir>`, `--samples <n>` (default 5), `--case <id>` (repeatable).
- A case passes when the phase matches in at least 80% of its samples, and every label survives `sanitizeThreadActivityLabel` unchanged and contains an accepted keyword. A sample that errors fails the case. A case with no expected phase only needs a valid answer.
- Writes `results.json` and `summary.txt`.
- Cost: 16 cases times the sample count of short calls on the cheapest model.

## Add a case

Add an entry to `cases.ts` with a digest, the expected phase, and the label keywords you accept. Cases at a phase boundary, such as `testing-todo-beats-edits` and `debugging-edits-while-failing`, matter most.
