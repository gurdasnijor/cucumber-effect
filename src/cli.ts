import { NodeStream } from "@effect/platform-node"
import { MessageToNdjsonStream } from "@cucumber/message-streams"
import type { Envelope } from "@cucumber/messages"
import { Effect, Option, Schema, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { Readable } from "node:stream"
import { defineSupport, runFeaturesToArray, type RunFeaturesOptions } from "./index.ts"

const version = "0.1.0"

const config = {
  paths: Argument.string("feature").pipe(
    Argument.variadic({ min: 1 }),
    Argument.withDescription("Feature file paths to execute"),
  ),
  format: Flag.choice("format", ["ndjson", "message"] as const).pipe(
    Flag.withDefault("ndjson"),
    Flag.withDescription("Output format. Both choices write Cucumber message NDJSON."),
  ),
  relativeTo: Flag.path("relative-to", { pathType: "directory", mustExist: true }).pipe(
    Flag.optional,
    Flag.withDescription("Directory used to relativize feature URIs"),
  ),
} as const

type CliInput = Command.Command.Config.Infer<typeof config>

export class MessageStreamError extends Schema.TaggedErrorClass<MessageStreamError>()(
  "MessageStreamError",
  { error: Schema.Unknown },
) {}

export const renderMessagesAsNdjson = Effect.fn("renderMessagesAsNdjson")((envelopes: ReadonlyArray<Envelope>) =>
  NodeStream.toString(
    () => Readable.from(envelopes, { objectMode: true }).pipe(new MessageToNdjsonStream()),
    { onError: (error) => new MessageStreamError({ error }) },
  ))

export const runCli = Effect.fn("runCli")(function* (input: CliInput) {
  const envelopes = yield* runFeaturesToArray(input.paths, runOptions(input))
  const ndjson = yield* renderMessagesAsNdjson(envelopes)
  yield* writeStdout(ndjson)
})

export const cliCommand = Command.make("cucumber-effect", config, runCli).pipe(
  Command.withDescription("Run Cucumber feature files and emit Cucumber message NDJSON."),
  Command.withExamples([{
    command: "cucumber-effect features/example.feature --format ndjson",
    description: "Run a feature and write message envelopes to stdout",
  }]),
  Command.provide(defineSupport(() => {})),
)

export const runCliWith = Command.runWith(cliCommand, { version })

export const cliEffect = Command.run(cliCommand, { version })

const runOptions = (input: CliInput): RunFeaturesOptions =>
  Option.match(input.relativeTo, {
    onNone: () => ({}),
    onSome: (relativeTo) => ({ relativeTo }),
  })

const writeStdout = Effect.fn("writeStdout")(function* (output: string) {
  const stdio = yield* Stdio.Stdio
  yield* Stream.succeed(output).pipe(Stream.run(stdio.stdout({ endOnDone: false })))
})
