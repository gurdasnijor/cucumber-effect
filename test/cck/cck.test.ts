import { it, expect } from "@effect/vitest"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Path } from "effect"
import { runFeaturesToArray } from "../../src/index.ts"
import { normalizeForCckComparison, readCckNdjsonMessages } from "./normalize.ts"
import { cckStepsFor } from "./steps.ts"

const kitRoot = "node_modules/@cucumber/compatibility-kit/features"

const samples = [
  "all-statuses",
  "attachments",
  "minimal",
  "cdata",
  "backgrounds",
  "data-tables",
  "doc-strings",
  "empty",
  "examples-tables",
  "examples-tables-attachment",
  "examples-tables-undefined",
  "failedish-combinations",
  "global-hooks",
  "global-hooks-afterall-error",
  "global-hooks-attachments",
  "global-hooks-beforeall-error",
  "hooks",
  "hooks-attachment",
  "hooks-conditional",
  "hooks-named",
  "hooks-skipped",
  "hooks-undefined",
  "parameter-types",
  "pending",
  "skipped",
  "skipped-failing-hook",
  "regular-expression",
  "retry",
  "retry-ambiguous",
  "retry-pending",
  "retry-undefined",
  "ambiguous",
  "unused-steps",
  "rules",
  "undefined",
  "unknown-parameter-type",
] as const

it.effect.each(samples)("CCK fixture: %s", (sample) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const featurePath = path.join(kitRoot, sample, featureFileName(sample))
    const ndjsonPath = path.join(kitRoot, sample, `${sample}.ndjson`)
    const actual = yield* runFeaturesToArray([featurePath], {
      relativeTo: kitRoot,
      ...runOptions(sample),
    })
    const expected = yield* readCckNdjsonMessages(yield* fs.readFileString(ndjsonPath))
    expect(normalizeForCckComparison(actual)).toEqual(normalizeForCckComparison(expected))
  }).pipe(Effect.provide(Layer.mergeAll(cckStepsFor(sample), NodeFileSystem.layer, NodePath.layer))))

const featureFileName = (sample: string) =>
  sample === "examples-tables-undefined" ? "examples-undefined.feature" : `${sample}.feature`

const runOptions = (sample: string) =>
  sample.startsWith("retry") ? { allowedRetries: 2 } : {}
