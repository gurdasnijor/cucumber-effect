import { NodeChildProcessSpawner, NodeFileSystem, NodePath, NodeTerminal } from "@effect/platform-node"
import { it, expect } from "@effect/vitest"
import { Effect, Layer, Ref, Sink, Stdio } from "effect"
import { runCliWith } from "../../src/cli.ts"
import { readCckNdjsonMessages } from "../cck/normalize.ts"

const cliEnvironment = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.mergeAll(
    NodeFileSystem.layer,
    NodePath.layer,
    NodeTerminal.layer,
  ),
)

it.effect("writes Cucumber message NDJSON to stdout", () =>
  Effect.gen(function* () {
    const stdout = yield* Ref.make("")
    const stderr = yield* Ref.make("")
    const stdio = Stdio.layerTest({
      stdout: () => Sink.forEach((chunk: string | Uint8Array) => Ref.update(stdout, (output) => output + chunkToString(chunk))),
      stderr: () => Sink.forEach((chunk: string | Uint8Array) => Ref.update(stderr, (output) => output + chunkToString(chunk))),
    })

    yield* runCliWith([
      "node_modules/@cucumber/compatibility-kit/features/minimal/minimal.feature",
      "--relative-to",
      "node_modules/@cucumber/compatibility-kit/features",
      "--format",
      "message",
    ]).pipe(Effect.provide(Layer.mergeAll(cliEnvironment, stdio)))

    expect(yield* Ref.get(stderr)).toEqual("")
    const envelopes = yield* readCckNdjsonMessages(yield* Ref.get(stdout))

    expect(envelopes.some((envelope) => envelope.source?.uri === "minimal/minimal.feature")).toBe(true)
    expect(envelopes.some((envelope) => envelope.testRunFinished?.success === false)).toBe(true)
  }))

const chunkToString = (chunk: string | Uint8Array) =>
  typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
