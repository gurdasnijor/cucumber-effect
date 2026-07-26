import { NodeStream } from "@effect/platform-node"
import { GherkinStreams, type IGherkinStreamOptions } from "@cucumber/gherkin-streams"
import {
  type GherkinDocument,
  IdGenerator,
  type Pickle,
  TimeConversion,
  type Envelope,
} from "@cucumber/messages"
import { Effect, FileSystem, Queue, Stream } from "effect"
import { GherkinStreamError } from "./errors.ts"
import { Registry } from "./registry.ts"
import { assembleTestCases, runScenario, runTestRunHooks, supportCodeEnvelopes, testRunSuccess } from "./scenario.ts"

export type RunFeaturesOptions = Pick<IGherkinStreamOptions, "relativeTo"> & {
  readonly allowedRetries?: number
}

type ParsedGherkin = {
  readonly gherkinDocuments: ReadonlyArray<GherkinDocument>
  readonly pickles: ReadonlyArray<Pickle>
}

export const runFeatures = (
  paths: ReadonlyArray<string>,
  options: RunFeaturesOptions = {},
): Stream.Stream<Envelope, GherkinStreamError, Registry | FileSystem.FileSystem> =>
  Stream.callback<Envelope, GherkinStreamError, Registry | FileSystem.FileSystem>(
    (queue) => {
      const writeEnvelope = (envelope: Envelope) =>
        Queue.offer(queue, envelope).pipe(Effect.asVoid)
      const nextId = IdGenerator.incrementing()
      return runFeaturePlan(paths, nextId, options, writeEnvelope).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => Queue.failCause(queue, cause),
          onSuccess: () => Queue.end(queue),
        }),
      )
    },
    { bufferSize: 256, strategy: "suspend" },
  )

const runFeaturePlan = Effect.fn("runFeaturePlan")(function* (
  paths: ReadonlyArray<string>,
  nextId: IdGenerator.NewId,
  options: RunFeaturesOptions,
  writeEnvelope: (envelope: Envelope) => Effect.Effect<void>,
) {
  const parsed = yield* gherkinEnvelopeStream(paths, nextId, options).pipe(
    Stream.tap(writeEnvelope),
    Stream.runFold((): ParsedGherkin => ({ gherkinDocuments: [], pickles: [] }), (state, envelope): ParsedGherkin => ({
      gherkinDocuments: envelope.gherkinDocument === undefined
        ? state.gherkinDocuments
        : [...state.gherkinDocuments, envelope.gherkinDocument],
      pickles: envelope.pickle === undefined ? state.pickles : [...state.pickles, envelope.pickle],
    })),
  )

  const registry = yield* Registry
  const supportCodeLibrary = registry.buildSupportCodeLibrary(nextId)
  yield* Stream.fromIterable(supportCodeEnvelopes(supportCodeLibrary)).pipe(
    Stream.runForEach(writeEnvelope),
  )

  const testRunStartedId = nextId()
  yield* writeEnvelope({
    testRunStarted: {
      id: testRunStartedId,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(0),
    },
  })

  const beforeAllResult = yield* runTestRunHooks(
    nextId,
    testRunStartedId,
    supportCodeLibrary.getAllBeforeAllHooks(),
    writeEnvelope,
  )
  const shouldRunTestCases = testRunSuccess(beforeAllResult.statuses)
  const testCases = shouldRunTestCases
    ? assembleTestCases(nextId, testRunStartedId, supportCodeLibrary, parsed.gherkinDocuments, parsed.pickles)
    : []
  yield* Stream.fromIterable(testCases).pipe(
    Stream.map((testCase): Envelope => ({ testCase: testCase.toMessage() })),
    Stream.runForEach(writeEnvelope),
  )

  const scenarioResults = yield* Effect.forEach(
    testCases,
    (testCase) => runScenario(nextId, testCase, supportCodeLibrary, options.allowedRetries ?? 0, writeEnvelope),
    { concurrency: 1 },
  )
  const afterAllResult = yield* runTestRunHooks(
    nextId,
    testRunStartedId,
    [...supportCodeLibrary.getAllAfterAllHooks()].reverse(),
    writeEnvelope,
  )
  const statuses = [
    ...beforeAllResult.statuses,
    ...scenarioResults.flatMap((result) => result.statuses),
    ...afterAllResult.statuses,
  ]

  yield* writeEnvelope({
    testRunFinished: {
      testRunStartedId,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(0),
      success: testRunSuccess(statuses),
    },
  })
})

const gherkinEnvelopeStream = (
  paths: ReadonlyArray<string>,
  nextId: IdGenerator.NewId,
  options: RunFeaturesOptions,
): Stream.Stream<Envelope, GherkinStreamError> => {
  const gherkinOptions: IGherkinStreamOptions = {
    includeSource: true,
    includeGherkinDocument: true,
    includePickles: true,
    newId: nextId,
    ...(options.relativeTo === undefined ? {} : { relativeTo: options.relativeTo }),
  }
  return NodeStream.fromReadable<Envelope, GherkinStreamError>({
    evaluate: () => GherkinStreams.fromPaths(paths, gherkinOptions),
    onError: (error) => new GherkinStreamError({ error }),
  })
}
