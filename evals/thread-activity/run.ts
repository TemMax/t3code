#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ClaudeTextGeneration from "../../apps/server/src/textGeneration/ClaudeTextGeneration.ts";
import * as CodexTextGeneration from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import * as ProcessRunner from "../../apps/server/src/processRunner.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { cases } from "./cases.ts";
import { gradeCase, type Answer } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string" },
    out: { type: "string" },
    samples: { type: "string", default: "5" },
    case: { type: "string", multiple: true },
  },
});
if (!values.model || !values.out)
  throw new Error("Use --model <claude-* or gpt-* id> --out <directory> [--samples <n>].");
const model = values.model;
const outputDirectory = values.out;
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be 1 or more.");
const selected = values.case ? cases.filter((entry) => values.case?.includes(entry.id)) : cases;
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

const makeGeneration = Effect.fn("evaluateThreadActivity.generation")(function* () {
  if (model.startsWith("claude-")) {
    const generation: ProviderTextGeneration = yield* ClaudeTextGeneration.makeClaudeTextGeneration(
      yield* decodeClaudeSettings({}),
    );
    return { generation, instanceId: ProviderInstanceId.make("claude") };
  }
  if (model.startsWith("gpt-")) {
    const generation: ProviderTextGeneration = yield* CodexTextGeneration.makeCodexTextGeneration(
      yield* decodeCodexSettings({}),
    );
    return { generation, instanceId: ProviderInstanceId.make("codex") };
  }
  return yield* Effect.die(new Error(`Unsupported model ${model}. Use a claude-* or gpt-* id.`));
});

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-activity-evaluation-" });
    const { generation, instanceId } = yield* makeGeneration();
    const rows = [];
    for (const entry of selected) {
      const answers: Array<Answer> = [];
      const errors: Array<string> = [];
      for (let sample = 0; sample < samples; sample++) {
        const result = yield* generation
          .generateThreadActivity({
            cwd,
            digest: entry.digest,
            previous: null,
            modelSelection: { instanceId, model },
          })
          .pipe(Effect.result);
        if (result._tag === "Success") answers.push(result.success);
        else errors.push(result.failure.detail);
      }
      // An error is a failed sample, so it must not shrink the denominator.
      const graded = gradeCase(entry, answers);
      const verdict =
        errors.length > 0
          ? { pass: false, reason: `${errors.length} sample(s) errored: ${errors[0]}` }
          : graded;
      rows.push({ id: entry.id, expected: entry.phase, ...verdict, answers, errors });
    }
    yield* fs.makeDirectory(outputDirectory, { recursive: true });
    yield* fs.writeFileString(
      path.join(outputDirectory, "results.json"),
      yield* encodeReport(rows),
    );
    const lines = rows.map((row) => `${row.pass ? "pass" : "FAIL"}  ${row.id}  ${row.reason}`);
    const passed = rows.filter((row) => row.pass).length;
    const report = `${lines.join("\n")}\n\n${model}: ${passed}/${rows.length} cases passed\n`;
    yield* fs.writeFileString(path.join(outputDirectory, "summary.txt"), report);
    process.stdout.write(report);
  }).pipe(
    Effect.provide(
      ProcessRunner.layer.pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-activity-evaluation-state-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
