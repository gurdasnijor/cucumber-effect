import { NodeStream } from "@effect/platform-node"
import { GherkinStreams, type IGherkinStreamOptions } from "@cucumber/gherkin-streams"
import {
  IdGenerator,
  TimeConversion,
  type Envelope,
} from "@cucumber/messages"
import { Effect, FileSystem, Stream } from "effect"
import { GherkinStreamError } from "./errors.ts"
import { Registry } from "./registry.ts"
import { assembleTestCases, runScenario, runTestRunHooks, supportCodeEnvelopes, testRunSuccess } from "./scenario.ts"

export type RunFeaturesOptions = Pick<IGherkinStreamOptions, "relativeTo"> & {
  readonly allowedRetries?: number
}

export const runFeatures = (
  paths: ReadonlyArray<string>,
  options: RunFeaturesOptions = {},
): Stream.Stream<Envelope, GherkinStreamError, Registry | FileSystem.FileSystem> =>
  Stream.fromIterableEffect(runFeaturesToArray(paths, options))

export const runFeaturesToArray = Effect.fn("runFeaturesToArray")(function* (
  paths: ReadonlyArray<string>,
  options: RunFeaturesOptions = {},
) {
  const nextId = IdGenerator.incrementing()
  return yield* runFeaturePlan(paths, nextId, options)
})

const runFeaturePlan = Effect.fn("runFeaturePlan")(function* (
  paths: ReadonlyArray<string>,
  nextId: IdGenerator.NewId,
  options: RunFeaturesOptions,
) {
  const parsed = yield* gherkinEnvelopesFromPaths(paths, nextId, options)
  const registry = yield* Registry
  const supportCodeLibrary = registry.buildSupportCodeLibrary(nextId)

  const supportEnvelopes = supportCodeEnvelopes(supportCodeLibrary)
  const testRunStartedId = nextId()
  const testRunStarted: Envelope = {
    testRunStarted: {
      id: testRunStartedId,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(0),
    },
  }

  const beforeAllResult = yield* runTestRunHooks(nextId, testRunStartedId, supportCodeLibrary.getAllBeforeAllHooks())
  const shouldRunTestCases = testRunSuccess(beforeAllResult.statuses)
  const testCases = shouldRunTestCases
    ? assembleTestCases(nextId, testRunStartedId, supportCodeLibrary, parsed.gherkinDocuments, parsed.pickles)
    : []
  const scenarioResults = yield* Effect.forEach(
    testCases,
    (testCase) => runScenario(nextId, testCase, supportCodeLibrary, options.allowedRetries ?? 0),
    { concurrency: 1 },
  )
  const afterAllResult = yield* runTestRunHooks(nextId, testRunStartedId, [...supportCodeLibrary.getAllAfterAllHooks()].reverse())
  const statuses = [
    ...beforeAllResult.statuses,
    ...scenarioResults.flatMap((result) => result.statuses),
    ...afterAllResult.statuses,
  ]

  const testRunFinished: Envelope = {
    testRunFinished: {
      testRunStartedId,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(0),
      success: testRunSuccess(statuses),
    },
  }

  return [
    ...parsed.envelopes,
    ...supportEnvelopes,
    testRunStarted,
    ...beforeAllResult.envelopes,
    ...testCases.map((testCase): Envelope => ({ testCase: testCase.toMessage() })),
    ...scenarioResults.flatMap((result) => result.envelopes),
    ...afterAllResult.envelopes,
    testRunFinished,
  ]
})

const gherkinEnvelopesFromPaths = Effect.fn("gherkinEnvelopesFromPaths")(function* (
  paths: ReadonlyArray<string>,
  nextId: IdGenerator.NewId,
  options: RunFeaturesOptions,
) {
  const gherkinOptions: IGherkinStreamOptions = {
    includeSource: true,
    includeGherkinDocument: true,
    includePickles: true,
    newId: nextId,
    ...(options.relativeTo === undefined ? {} : { relativeTo: options.relativeTo }),
  }
  const envelopes = yield* NodeStream.fromReadable<Envelope, GherkinStreamError>({
    evaluate: () => GherkinStreams.fromPaths(paths, gherkinOptions),
    onError: (error) => new GherkinStreamError({ error }),
  }).pipe(Stream.runCollect)
  const gherkinDocuments = envelopes.flatMap((envelope) => envelope.gherkinDocument === undefined ? [] : [envelope.gherkinDocument])
  const pickles = envelopes.flatMap((envelope) => envelope.pickle === undefined ? [] : [envelope.pickle])

  return { envelopes, gherkinDocuments, pickles }
})
