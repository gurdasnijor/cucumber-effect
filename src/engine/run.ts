import { GherkinStreams, type IGherkinStreamOptions } from "@cucumber/gherkin-streams"
import {
  IdGenerator,
  TestStepResultStatus,
  TimeConversion,
  type Envelope,
} from "@cucumber/messages"
import { Effect, Stream } from "effect"
import { GherkinStreamError } from "./errors.ts"
import { EventBus, envelopeStream, finish, publish } from "./event-bus.ts"
import type { Registry } from "./registry.ts"
import { assembleTestCases, emitStepDefinitions, runScenario, testRunSuccess } from "./scenario.ts"

export type RunFeaturesOptions = Pick<IGherkinStreamOptions, "relativeTo"> & {
  readonly uriPrefix?: string
}

export const runFeatures = (
  paths: ReadonlyArray<string>,
  options: RunFeaturesOptions = {},
): Stream.Stream<Envelope, GherkinStreamError, Registry> =>
  Stream.unwrap(Effect.gen(function* () {
    const nextId = IdGenerator.incrementing()
    const stream = yield* envelopeStream()
    return stream.pipe(Stream.mergeEffect(runFeaturePlan(paths, nextId, options)))
  })).pipe(Stream.provide(EventBus.layer))

export const runFeaturesToArray = Effect.fn("runFeaturesToArray")(function* (
  paths: ReadonlyArray<string>,
  options: RunFeaturesOptions = {},
) {
  const nextId = IdGenerator.incrementing()
  return yield* Effect.gen(function* () {
    const stream = yield* envelopeStream()
    return yield* Stream.runCollect(stream.pipe(Stream.mergeEffect(runFeaturePlan(paths, nextId, options))))
      .pipe(Effect.map((chunk) => [...chunk] as ReadonlyArray<Envelope>))
  }).pipe(Effect.provide(EventBus.layer))
})

const runFeaturePlan = Effect.fn("runFeaturePlan")(function* (
  paths: ReadonlyArray<string>,
  nextId: IdGenerator.NewId,
  options: RunFeaturesOptions,
) {
  yield* publish(metaEnvelope)

  const parsed = yield* gherkinEnvelopesFromPaths(paths, nextId, options)
  for (const envelope of parsed.envelopes) {
    yield* publish(envelope)
  }

  const stepDefinitionIds = yield* emitStepDefinitions(nextId)
  const testRunStartedId = nextId()
  yield* publish({
    testRunStarted: {
      id: testRunStartedId,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(0),
    },
  })

  const testCases = yield* assembleTestCases(nextId, testRunStartedId, parsed.pickles, stepDefinitionIds)
  const statuses = new Set<TestStepResultStatus>()
  for (const testCase of testCases) {
    const scenarioStatuses = yield* runScenario(nextId, testCase, 0)
    for (const status of scenarioStatuses) {
      statuses.add(status)
    }
  }

  yield* publish({
    testRunFinished: {
      testRunStartedId,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(0),
      success: testRunSuccess(statuses),
    },
  })

  return yield* finish()
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
  const envelopes = (yield* collectReadableEnvelopes(GherkinStreams.fromPaths(paths, gherkinOptions)))
    .map((envelope) => prefixEnvelopeUri(envelope, options.uriPrefix))
  const pickles = envelopes.flatMap((envelope) => envelope.pickle === undefined ? [] : [envelope.pickle])

  return { envelopes, pickles }
})

const collectReadableEnvelopes = (readable: NodeJS.ReadableStream) =>
  Effect.callback<ReadonlyArray<Envelope>, GherkinStreamError>((resume) => {
    const envelopes: Array<Envelope> = []
    const onData = (chunk: unknown) => {
      envelopes.push(chunk as Envelope)
    }
    const onError = (error: unknown) => {
      resume(new GherkinStreamError({ error }))
    }
    const onEnd = () => {
      resume(Effect.succeed(envelopes))
    }

    readable.on("data", onData)
    readable.once("error", onError)
    readable.once("end", onEnd)

    return Effect.sync(() => {
      readable.off("data", onData)
      readable.off("error", onError)
      readable.off("end", onEnd)
    })
  })

const prefixEnvelopeUri = (envelope: Envelope, prefix: string | undefined): Envelope => {
  if (prefix === undefined) {
    return envelope
  }
  return {
    ...envelope,
    ...(envelope.source === undefined ? {} : { source: { ...envelope.source, uri: prefixUri(envelope.source.uri, prefix) } }),
    ...(envelope.gherkinDocument?.uri === undefined
      ? {}
      : { gherkinDocument: { ...envelope.gherkinDocument, uri: prefixUri(envelope.gherkinDocument.uri, prefix) } }),
    ...(envelope.pickle === undefined ? {} : { pickle: { ...envelope.pickle, uri: prefixUri(envelope.pickle.uri, prefix) } }),
  }
}

const prefixUri = (uri: string, prefix: string) =>
  uri.startsWith(`${prefix}/`) ? uri : `${prefix}/${uri}`

const metaEnvelope: Envelope = {
  meta: {
    protocolVersion: "31.1.0",
    implementation: {
      name: "cucumber-effect",
      version: "0.1.0",
    },
    runtime: {
      name: "Node.js",
      version: "24",
    },
    os: {
      name: "unknown",
      version: "unknown",
    },
    cpu: {
      name: "unknown",
    },
  },
}
