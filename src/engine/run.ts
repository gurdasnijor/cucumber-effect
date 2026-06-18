import { NodeStream } from "@effect/platform-node"
import { GherkinStreams, type IGherkinStreamOptions } from "@cucumber/gherkin-streams"
import {
  IdGenerator,
  TestStepResultStatus,
  TimeConversion,
  type Envelope,
} from "@cucumber/messages"
import { Effect, Stream } from "effect"
import { GherkinStreamError } from "./errors.ts"
import type { Registry } from "./registry.ts"
import { assembleTestCases, emitStepDefinitions, runScenario, testRunSuccess } from "./scenario.ts"

export type RunFeaturesOptions = Pick<IGherkinStreamOptions, "relativeTo">

export const runFeatures = (
  paths: ReadonlyArray<string>,
  options: RunFeaturesOptions = {},
): Stream.Stream<Envelope, GherkinStreamError, Registry> =>
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

  const stepDefinitions = yield* emitStepDefinitions(nextId)
  const testRunStartedId = nextId()
  const testRunStarted: Envelope = {
    testRunStarted: {
      id: testRunStartedId,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(0),
    },
  }

  const testCases = yield* assembleTestCases(nextId, testRunStartedId, parsed.pickles, stepDefinitions.stepDefinitionIds)
  const scenarioResults = yield* Effect.forEach(
    testCases,
    (testCase) => runScenario(nextId, testCase, 0),
    { concurrency: 1 },
  )
  const statuses = scenarioResults.flatMap((result) => result.statuses)

  const testRunFinished: Envelope = {
    testRunFinished: {
      testRunStartedId,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(0),
      success: testRunSuccess(statuses),
    },
  }

  return [
    ...parsed.envelopes,
    ...stepDefinitions.envelopes,
    testRunStarted,
    ...testCases.map((testCase): Envelope => ({ testCase: testCase.testCase })),
    ...scenarioResults.flatMap((result) => result.envelopes),
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
  const pickles = envelopes.flatMap((envelope) => envelope.pickle === undefined ? [] : [envelope.pickle])

  return { envelopes, pickles }
})
