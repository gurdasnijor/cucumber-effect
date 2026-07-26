import { NodeStream } from "@effect/platform-node"
import { MessageToNdjsonStream } from "@cucumber/message-streams"
import { Effect, Option, Schema, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { defineSupport, runFeatures, type RunFeaturesOptions } from "./index.ts"

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

class MessageStreamError extends Schema.TaggedErrorClass<MessageStreamError>()(
  "MessageStreamError",
  { error: Schema.Unknown },
) {}

const runCli = Effect.fn("runCli")(function* (input: CliInput) {
  const stdio = yield* Stdio.Stdio
  yield* runFeatures(input.paths, runOptions(input)).pipe(
    NodeStream.pipeThroughDuplex({
      evaluate: () => new MessageToNdjsonStream(),
      onError: (error) => new MessageStreamError({ error }),
    }),
    Stream.run(stdio.stdout({ endOnDone: false })),
  )
})

const cliCommand = Command.make("cucumber-effect", config, runCli).pipe(
  Command.withDescription("Run Cucumber feature files and emit Cucumber message NDJSON."),
  Command.withExamples([{
    command: "cucumber-effect features/example.feature --format ndjson",
    description: "Run a feature and write message envelopes to stdout",
  }]),
  Command.provide(defineSupport(() => {})),
)

export const cliEffect = Command.run(cliCommand, { version })

const runOptions = (input: CliInput): RunFeaturesOptions =>
  Option.match(input.relativeTo, {
    onNone: () => ({}),
    onSome: (relativeTo) => ({ relativeTo }),
  })
