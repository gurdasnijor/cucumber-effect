import { it, expect } from "@effect/vitest"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Path } from "effect"
import { runFeaturesToArray } from "../../src/index.ts"
import { messagesFromNdjson, normalize } from "./normalize.ts"
import { cckStepsFor } from "./steps.ts"

const kitRoot = "node_modules/@cucumber/compatibility-kit/features"

const samples = [
  "minimal",
  "cdata",
  "backgrounds",
  "doc-strings",
  "parameter-types",
  "pending",
  "skipped",
  "regular-expression",
  "ambiguous",
  "unused-steps",
] as const

it.effect.each(samples)("CCK fixture: %s", (sample) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const featurePath = path.join(kitRoot, sample, `${sample}.feature`)
    const ndjsonPath = path.join(kitRoot, sample, `${sample}.ndjson`)
    const actual = yield* runFeaturesToArray([featurePath], {
      relativeTo: kitRoot,
      uriPrefix: "samples",
    })
    const expected = yield* messagesFromNdjson(yield* fs.readFileString(ndjsonPath))
    expect(normalize(actual)).toEqual(normalize(expected))
  }).pipe(Effect.provide(Layer.mergeAll(cckStepsFor(sample), NodeFileSystem.layer, NodePath.layer))))
