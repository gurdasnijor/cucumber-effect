import {
  DataTable,
  makeTestPlan,
  type AssembledTestCase,
  type AssembledTestStep,
  type DefinedTestRunHook,
  type PreparedStep,
  type SupportCodeFunction,
  type SupportCodeLibrary,
} from "@cucumber/core"
import {
  TestStepResultStatus,
  TimeConversion,
  type Envelope,
  type Exception,
  type GherkinDocument,
  type IdGenerator,
  type Pickle,
  type TestStepResult,
} from "@cucumber/messages"
import { Cause, Clock, Effect, Exit, FileSystem, Option } from "effect"
import { type StepError } from "./errors.ts"
import {
  collectAttachments,
  makeScenarioRuntime,
  makeStepRuntime,
  makeTestRunHookRuntime,
  type ScenarioWorld,
  type WorldServices,
} from "./world.ts"
import { makeSnippets } from "./snippets.ts"

type ScenarioResult = {
  readonly statuses: ReadonlyArray<TestStepResultStatus>
}

type ScenarioAttemptResult = ScenarioResult & {
  readonly testCaseStartedId: string
}

type StepExecution = {
  readonly result: TestStepResult
}

type StepReturn = void | "pending" | "skipped"

type StepEffect = Effect.Effect<StepReturn, StepError, WorldServices>

type ScenarioAttemptState = {
  readonly statuses: ReadonlyArray<TestStepResultStatus>
  readonly failedish: boolean
  readonly skipped: boolean
}

const NON_SUCCESS_STATUSES = new Set<TestStepResultStatus>([
  TestStepResultStatus.PENDING,
  TestStepResultStatus.UNDEFINED,
  TestStepResultStatus.AMBIGUOUS,
  TestStepResultStatus.FAILED,
])

export const supportCodeEnvelopes = (supportCodeLibrary: SupportCodeLibrary) =>
  supportCodeLibrary.toEnvelopes()

export const assembleTestCases = (
  nextId: IdGenerator.NewId,
  testRunStartedId: string,
  supportCodeLibrary: SupportCodeLibrary,
  gherkinDocuments: ReadonlyArray<GherkinDocument>,
  pickles: ReadonlyArray<Pickle>,
): ReadonlyArray<AssembledTestCase> =>
  gherkinDocuments.flatMap((gherkinDocument) =>
    makeTestPlan({
      testRunStartedId,
      gherkinDocument,
      pickles: pickles.filter((pickle) => pickle.uri === gherkinDocument.uri),
      supportCodeLibrary,
    }, { newId: nextId }).testCases
  )

export const runScenario = Effect.fn("runScenario")(function* (
  nextId: IdGenerator.NewId,
  assembled: AssembledTestCase,
  supportCodeLibrary: SupportCodeLibrary,
  allowedRetries: number,
  writeEnvelope: (envelope: Envelope) => Effect.Effect<void>,
): Effect.fn.Return<ScenarioResult, never, FileSystem.FileSystem> {
  return yield* runScenarioAttempts(nextId, assembled, supportCodeLibrary, allowedRetries, 0, writeEnvelope)
})

const shouldRetryScenario = (result: ScenarioAttemptResult) =>
  result.statuses.includes(TestStepResultStatus.FAILED)

const runScenarioAttempts = Effect.fn("runScenarioAttempts")(function* (
  nextId: IdGenerator.NewId,
  assembled: AssembledTestCase,
  supportCodeLibrary: SupportCodeLibrary,
  allowedRetries: number,
  attempt: number,
  writeEnvelope: (envelope: Envelope) => Effect.Effect<void>,
): Effect.fn.Return<ScenarioResult, never, FileSystem.FileSystem> {
  const attemptResult = yield* runScenarioAttempt(nextId, assembled, supportCodeLibrary, attempt, writeEnvelope)
  const willBeRetried = shouldRetryScenario(attemptResult) && attempt < allowedRetries
  const finishedAt = yield* Clock.currentTimeMillis
  yield* writeEnvelope(testCaseFinishedEnvelope(attemptResult.testCaseStartedId, willBeRetried, finishedAt))
  if (!willBeRetried) {
    return {
      statuses: attemptResult.statuses,
    }
  }
  const next = yield* runScenarioAttempts(
    nextId,
    assembled,
    supportCodeLibrary,
    allowedRetries,
    attempt + 1,
    writeEnvelope,
  )
  return {
    statuses: next.statuses,
  }
})

const runScenarioAttempt = Effect.fn("runScenarioAttempt")(function* (
  nextId: IdGenerator.NewId,
  assembled: AssembledTestCase,
  supportCodeLibrary: SupportCodeLibrary,
  attempt: number,
  writeEnvelope: (envelope: Envelope) => Effect.Effect<void>,
): Effect.fn.Return<ScenarioAttemptResult, never, FileSystem.FileSystem> {
  const testCaseStartedId = nextId()
  const timestamp = TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis)
  yield* writeEnvelope({
    testCaseStarted: {
      id: testCaseStartedId,
      testCaseId: assembled.id,
      timestamp,
      attempt,
    },
  })

  const scenarioRuntime = yield* makeScenarioRuntime()
  const result = yield* scenarioRuntime.provide(runScenarioSteps(
    nextId,
    assembled,
    supportCodeLibrary,
    testCaseStartedId,
    writeEnvelope,
  ))

  return {
    testCaseStartedId,
    statuses: result.statuses,
  }
})

export const runTestRunHooks = Effect.fn("runTestRunHooks")(function* (
  nextId: IdGenerator.NewId,
  testRunStartedId: string,
  hooks: ReadonlyArray<DefinedTestRunHook>,
  writeEnvelope: (envelope: Envelope) => Effect.Effect<void>,
): Effect.fn.Return<ScenarioResult, never, FileSystem.FileSystem> {
  const results = yield* Effect.forEach(
    hooks,
    (hook) => runTestRunHook(nextId, testRunStartedId, hook, writeEnvelope),
    { concurrency: 1 },
  )
  return {
    statuses: results.map((result) => result.status),
  }
})

const runTestRunHook = Effect.fn("runTestRunHook")(function* (
  nextId: IdGenerator.NewId,
  testRunStartedId: string,
  hook: DefinedTestRunHook,
  writeEnvelope: (envelope: Envelope) => Effect.Effect<void>,
) {
  const testRunHookStartedId = nextId()
  yield* writeEnvelope({
    testRunHookStarted: {
      id: testRunHookStartedId,
      testRunStartedId,
      hookId: hook.id,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis),
    },
  })
  const started = yield* Clock.currentTimeMillis
  const runtime = yield* makeTestRunHookRuntime({ testRunHookStartedId })
  const execution = yield* runtime.provide(Effect.gen(function* () {
    const exit = yield* invokeSupportFunction(hook.fn, []).pipe(Effect.exit)
    const attachments = yield* collectAttachments()
    return { exit, attachments }
  }))
  const ended = yield* Clock.currentTimeMillis
  const duration = TimeConversion.millisecondsToDuration(ended - started)
  const result = Exit.match(execution.exit, {
    onSuccess: (value): TestStepResult => ({
      status: value === "pending"
        ? TestStepResultStatus.PENDING
        : value === "skipped"
          ? TestStepResultStatus.SKIPPED
          : TestStepResultStatus.PASSED,
      duration,
    }),
    onFailure: (cause): TestStepResult => ({
      ...resultFromCause(cause),
      duration,
    }),
  })
  yield* Effect.forEach(
    execution.attachments,
    (attachment) => writeEnvelope({ attachment }),
    { concurrency: 1, discard: true },
  )
  yield* writeEnvelope({
    testRunHookFinished: {
      testRunHookStartedId,
      result,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis),
    },
  })
  return {
    status: result.status,
  }
})

const runScenarioSteps = Effect.fn("runScenarioSteps")(function* (
  nextId: IdGenerator.NewId,
  assembled: AssembledTestCase,
  supportCodeLibrary: SupportCodeLibrary,
  testCaseStartedId: string,
  writeEnvelope: (envelope: Envelope) => Effect.Effect<void>,
) {
  const initial: ScenarioAttemptState = {
    statuses: [],
    failedish: false,
    skipped: false,
  }

  return yield* assembled.testSteps.reduce(
    (effect, step) =>
      effect.pipe(Effect.flatMap((state) =>
        runScenarioStep(nextId, state, step, supportCodeLibrary, testCaseStartedId, writeEnvelope)
      )),
    Effect.succeed(initial) as Effect.Effect<ScenarioAttemptState, never, ScenarioWorld | FileSystem.FileSystem>,
  )
})

const runScenarioStep = Effect.fn("runScenarioStep")(function* (
  nextId: IdGenerator.NewId,
  state: ScenarioAttemptState,
  step: AssembledTestStep,
  supportCodeLibrary: SupportCodeLibrary,
  testCaseStartedId: string,
  writeEnvelope: (envelope: Envelope) => Effect.Effect<void>,
): Effect.fn.Return<ScenarioAttemptState, never, ScenarioWorld | FileSystem.FileSystem> {
  yield* writeEnvelope({
    testStepStarted: {
      testCaseStartedId,
      testStepId: step.id,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis),
    },
  })

  const execution = state.skipped && !step.always
    ? { result: zeroDurationResult(TestStepResultStatus.SKIPPED) }
    : state.failedish && !step.always
      ? yield* executeStepAfterFailure(nextId, step, supportCodeLibrary, writeEnvelope)
      : yield* executeStep(nextId, step, supportCodeLibrary, { testCaseStartedId, testStepId: step.id }, writeEnvelope)

  const result = execution.result
  const skipped = state.skipped || (result.status === TestStepResultStatus.SKIPPED && !state.failedish)
  const failedish = state.failedish ||
    (result.status !== TestStepResultStatus.PASSED && result.status !== TestStepResultStatus.SKIPPED)

  yield* writeEnvelope({
    testStepFinished: {
      testCaseStartedId,
      testStepId: step.id,
      testStepResult: result,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis),
    },
  })

  return {
    statuses: [...state.statuses, result.status],
    failedish,
    skipped,
  }
})

const executeStep = Effect.fn("executeStep")(function* (
  nextId: IdGenerator.NewId,
  step: AssembledTestStep,
  supportCodeLibrary: SupportCodeLibrary,
  active: { readonly testCaseStartedId: string; readonly testStepId: string },
  writeEnvelope: (envelope: Envelope) => Effect.Effect<void>,
): Effect.fn.Return<StepExecution, never, ScenarioWorld | FileSystem.FileSystem> {
  const prepared = step.prepare()
  if (prepared.type === "undefined") {
    yield* writeEnvelope(suggestionEnvelope(nextId, prepared.pickleStep, supportCodeLibrary))
    return {
      result: zeroDurationResult(TestStepResultStatus.UNDEFINED),
    }
  }
  if (prepared.type === "ambiguous") {
    return { result: zeroDurationResult(TestStepResultStatus.AMBIGUOUS) }
  }

  const started = yield* Clock.currentTimeMillis
  const runtime = yield* makeStepRuntime(active)
  const execution = yield* runtime.provide(Effect.gen(function* () {
    const exit = yield* invokeStep(prepared).pipe(Effect.exit)
    const attachments = yield* collectAttachments()
    return { exit, attachments }
  }))
  const ended = yield* Clock.currentTimeMillis
  const duration = TimeConversion.millisecondsToDuration(ended - started)

  const result = Exit.match(execution.exit, {
    onSuccess: (value): TestStepResult => ({
      status: value === "pending"
        ? TestStepResultStatus.PENDING
        : value === "skipped"
          ? TestStepResultStatus.SKIPPED
          : TestStepResultStatus.PASSED,
      duration,
    }),
    onFailure: (cause): TestStepResult => ({
      ...resultFromCause(cause),
      duration,
    }),
  })

  yield* Effect.forEach(
    execution.attachments,
    (attachment) => writeEnvelope({ attachment }),
    { concurrency: 1, discard: true },
  )

  return {
    result,
  }
})

const executeStepAfterFailure = Effect.fn("executeStepAfterFailure")(function* (
  nextId: IdGenerator.NewId,
  step: AssembledTestStep,
  supportCodeLibrary: SupportCodeLibrary,
  writeEnvelope: (envelope: Envelope) => Effect.Effect<void>,
): Effect.fn.Return<StepExecution> {
  const prepared = step.prepare()
  if (prepared.type === "undefined") {
    yield* writeEnvelope(suggestionEnvelope(nextId, prepared.pickleStep, supportCodeLibrary))
    return {
      result: zeroDurationResult(TestStepResultStatus.UNDEFINED),
    }
  }
  if (prepared.type === "ambiguous") {
    return { result: zeroDurationResult(TestStepResultStatus.AMBIGUOUS) }
  }
  return { result: zeroDurationResult(TestStepResultStatus.SKIPPED) }
})

const suggestionEnvelope = (
  nextId: IdGenerator.NewId,
  pickleStep: Pickle["steps"][number],
  supportCodeLibrary: SupportCodeLibrary,
): Envelope => ({
  suggestion: {
    id: nextId(),
    pickleStepId: pickleStep.id,
    snippets: makeSnippets(pickleStep, supportCodeLibrary),
  },
})

const invokeStep = (prepared: PreparedStep): StepEffect =>
  invokeSupportFunction(prepared.fn, [
    ...prepared.args.map((arg) => arg.getValue(null)),
    ...(prepared.dataTable === undefined ? [] : [DataTable.from(prepared.dataTable)]),
    ...(prepared.docString === undefined ? [] : [prepared.docString.content]),
  ])

const invokeSupportFunction = (fn: SupportCodeFunction, args: ReadonlyArray<unknown>): StepEffect =>
  Effect.suspend(() => {
    const returned: unknown = fn(...args)
    if (isStepEffect(returned)) {
      return returned
    }
    if (isPromiseLike(returned)) {
      return Effect.promise(() => returned)
    }
    if (isStepReturn(returned)) {
      return Effect.succeed(returned)
    }
    return Effect.die(new TypeError(
      isGenerator(returned)
        ? "Support code returned a Generator. Use an Effect generator body so the DSL can lift it before execution."
        : `Unsupported support code return value: ${String(returned)}`,
    ))
  })

const isStepEffect = (value: unknown): value is StepEffect => Effect.isEffect(value)

const isPromiseLike = (value: unknown): value is Promise<void | "pending" | "skipped"> =>
  typeof value === "object" && value !== null && "then" in value && typeof value.then === "function"

const isStepReturn = (value: unknown): value is StepReturn =>
  value === undefined || value === "pending" || value === "skipped"

const isGenerator = (value: unknown) =>
  typeof value === "object" &&
  value !== null &&
  "next" in value &&
  typeof value.next === "function" &&
  "throw" in value &&
  typeof value.throw === "function"

const resultFromCause = (cause: Cause.Cause<StepError>): Omit<TestStepResult, "duration"> => {
  const error = Cause.findErrorOption(cause)
  if (Option.isSome(error)) {
    const value = error.value
    if (value._tag === "StepPending") {
      return { status: TestStepResultStatus.PENDING, message: value.reason }
    }
    if (value._tag === "StepSkipped") {
      return { status: TestStepResultStatus.SKIPPED, message: value.reason }
    }
    if (value._tag === "StepFailed") {
      return {
        status: TestStepResultStatus.FAILED,
        message: value.message,
        exception: {
          type: value.type,
          message: value.message,
          ...(value.stack === undefined ? {} : { stackTrace: value.stack }),
        },
      }
    }
  }
  const squashed = Cause.squash(cause)
  const message = squashed instanceof Error ? squashed.message : String(squashed)
  return {
    status: TestStepResultStatus.FAILED,
    message,
    exception: exceptionFromUnknown(squashed),
  }
}

const zeroDurationResult = (status: TestStepResultStatus): TestStepResult => ({
  status,
  duration: TimeConversion.millisecondsToDuration(0),
})

const testCaseFinishedEnvelope = (
  testCaseStartedId: string,
  willBeRetried: boolean,
  timestampMillis: number,
): Envelope => ({
  testCaseFinished: {
    testCaseStartedId,
    timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(timestampMillis),
    willBeRetried,
  },
})

const exceptionFromUnknown = (error: unknown): Exception => {
  if (error instanceof Error) {
    return {
      type: error.constructor.name || "Error",
      message: error.message,
      stackTrace: error.stack ?? `${error.constructor.name}: ${error.message}`,
    }
  }
  return {
    type: "Error",
    message: String(error),
    stackTrace: String(error),
  }
}

export const testRunSuccess = (statuses: Iterable<TestStepResultStatus>) => {
  for (const status of statuses) {
    if (NON_SUCCESS_STATUSES.has(status)) {
      return false
    }
  }
  return true
}
