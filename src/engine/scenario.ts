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
import { Cause, Clock, Effect, Exit, FileSystem, Option, Ref, Schedule } from "effect"
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
  readonly envelopes: ReadonlyArray<Envelope>
}

type ScenarioAttemptResult = ScenarioResult & {
  readonly testCaseStartedId: string
}

type StepExecution = {
  readonly result: TestStepResult
  readonly envelopes: ReadonlyArray<Envelope>
}

type StepReturn = void | "pending" | "skipped"

type StepEffect = Effect.Effect<StepReturn, StepError, WorldServices>

type ScenarioAttemptState = {
  readonly statuses: ReadonlyArray<TestStepResultStatus>
  readonly envelopes: ReadonlyArray<Envelope>
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
): Effect.fn.Return<ScenarioResult, never, FileSystem.FileSystem> {
  const attemptRef = yield* Ref.make(0)
  const envelopesRef = yield* Ref.make<ReadonlyArray<Envelope>>([])
  const finalAttempt = yield* runScenarioAttemptForRetry(nextId, assembled, supportCodeLibrary, allowedRetries, attemptRef, envelopesRef)
    .pipe(Effect.repeat({
      schedule: Schedule.recurs(allowedRetries),
      while: shouldRetryScenario,
    }))
  const envelopes = yield* Ref.get(envelopesRef)
  return {
    statuses: finalAttempt.statuses,
    envelopes,
  }
})

const shouldRetryScenario = (result: ScenarioAttemptResult) =>
  result.statuses.includes(TestStepResultStatus.FAILED)

const runScenarioAttemptForRetry = Effect.fn("runScenarioAttemptForRetry")(function* (
  nextId: IdGenerator.NewId,
  assembled: AssembledTestCase,
  supportCodeLibrary: SupportCodeLibrary,
  allowedRetries: number,
  attemptRef: Ref.Ref<number>,
  envelopesRef: Ref.Ref<ReadonlyArray<Envelope>>,
) {
  const attempt = yield* Ref.get(attemptRef)
  const attemptResult = yield* runScenarioAttemptWithEnvelopes(nextId, assembled, supportCodeLibrary, attempt)
  const willBeRetried = shouldRetryScenario(attemptResult) && attempt < allowedRetries
  const finishedAt = yield* Clock.currentTimeMillis
  yield* Ref.update(envelopesRef, (envelopes) => [
    ...envelopes,
    ...attemptResult.envelopes,
    testCaseFinishedEnvelope(attemptResult.testCaseStartedId, willBeRetried, finishedAt),
  ])
  yield* Ref.update(attemptRef, (current) => current + 1)
  return attemptResult
})

const runScenarioAttemptWithEnvelopes = Effect.fn("runScenarioAttemptWithEnvelopes")(function* (
  nextId: IdGenerator.NewId,
  assembled: AssembledTestCase,
  supportCodeLibrary: SupportCodeLibrary,
  attempt: number,
): Effect.fn.Return<ScenarioAttemptResult, never, FileSystem.FileSystem> {
  const testCaseStartedId = nextId()
  const timestamp = TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis)
  const testCaseStarted: Envelope = {
    testCaseStarted: {
      id: testCaseStartedId,
      testCaseId: assembled.id,
      timestamp,
      attempt,
    },
  }

  const scenarioRuntime = yield* makeScenarioRuntime()
  const result = yield* scenarioRuntime.provide(runScenarioAttempt(nextId, assembled, supportCodeLibrary, testCaseStartedId))

  return {
    testCaseStartedId,
    statuses: result.statuses,
    envelopes: [
      testCaseStarted,
      ...result.envelopes,
    ],
  }
})

export const runTestRunHooks = Effect.fn("runTestRunHooks")(function* (
  nextId: IdGenerator.NewId,
  testRunStartedId: string,
  hooks: ReadonlyArray<DefinedTestRunHook>,
): Effect.fn.Return<ScenarioResult, never, FileSystem.FileSystem> {
  const results = yield* Effect.forEach(
    hooks,
    (hook) => runTestRunHook(nextId, testRunStartedId, hook),
    { concurrency: 1 },
  )
  return {
    statuses: results.map((result) => result.status),
    envelopes: results.flatMap((result) => result.envelopes),
  }
})

const runTestRunHook = Effect.fn("runTestRunHook")(function* (
  nextId: IdGenerator.NewId,
  testRunStartedId: string,
  hook: DefinedTestRunHook,
) {
  const testRunHookStartedId = nextId()
  const testRunHookStarted: Envelope = {
    testRunHookStarted: {
      id: testRunHookStartedId,
      testRunStartedId,
      hookId: hook.id,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis),
    },
  }
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
  const testRunHookFinished: Envelope = {
    testRunHookFinished: {
      testRunHookStartedId,
      result,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis),
    },
  }
  return {
    status: result.status,
    envelopes: [
      testRunHookStarted,
      ...execution.attachments.map((attachment): Envelope => ({ attachment })),
      testRunHookFinished,
    ],
  }
})

const runScenarioAttempt = Effect.fn("runScenarioAttempt")(function* (
  nextId: IdGenerator.NewId,
  assembled: AssembledTestCase,
  supportCodeLibrary: SupportCodeLibrary,
  testCaseStartedId: string,
) {
  const initial: ScenarioAttemptState = {
    statuses: [],
    envelopes: [],
    failedish: false,
    skipped: false,
  }

  return yield* assembled.testSteps.reduce(
    (effect, step) =>
      effect.pipe(Effect.flatMap((state) => runScenarioStep(nextId, state, step, supportCodeLibrary, testCaseStartedId))),
    Effect.succeed(initial) as Effect.Effect<ScenarioAttemptState, never, ScenarioWorld | FileSystem.FileSystem>,
  )
})

const runScenarioStep = Effect.fn("runScenarioStep")(function* (
  nextId: IdGenerator.NewId,
  state: ScenarioAttemptState,
  step: AssembledTestStep,
  supportCodeLibrary: SupportCodeLibrary,
  testCaseStartedId: string,
): Effect.fn.Return<ScenarioAttemptState, never, ScenarioWorld | FileSystem.FileSystem> {
  const testStepStarted: Envelope = {
    testStepStarted: {
      testCaseStartedId,
      testStepId: step.id,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis),
    },
  }

  const execution = state.skipped && !step.always
    ? { result: zeroDurationResult(TestStepResultStatus.SKIPPED), envelopes: [] }
    : state.failedish && !step.always
      ? executeStepAfterFailure(nextId, step, supportCodeLibrary)
      : yield* executeStep(nextId, step, supportCodeLibrary, { testCaseStartedId, testStepId: step.id })

  const result = execution.result
  const skipped = state.skipped || (result.status === TestStepResultStatus.SKIPPED && !state.failedish)
  const failedish = state.failedish ||
    (result.status !== TestStepResultStatus.PASSED && result.status !== TestStepResultStatus.SKIPPED)

  const testStepFinished: Envelope = {
    testStepFinished: {
      testCaseStartedId,
      testStepId: step.id,
      testStepResult: result,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis),
    },
  }

  return {
    statuses: [...state.statuses, result.status],
    envelopes: [
      ...state.envelopes,
      testStepStarted,
      ...execution.envelopes,
      testStepFinished,
    ],
    failedish,
    skipped,
  }
})

const executeStep = Effect.fn("executeStep")(function* (
  nextId: IdGenerator.NewId,
  step: AssembledTestStep,
  supportCodeLibrary: SupportCodeLibrary,
  active: { readonly testCaseStartedId: string; readonly testStepId: string },
): Effect.fn.Return<StepExecution, never, ScenarioWorld | FileSystem.FileSystem> {
  const prepared = step.prepare()
  if (prepared.type === "undefined") {
    return {
      result: zeroDurationResult(TestStepResultStatus.UNDEFINED),
      envelopes: [suggestionEnvelope(nextId, prepared.pickleStep, supportCodeLibrary)],
    }
  }
  if (prepared.type === "ambiguous") {
    return { result: zeroDurationResult(TestStepResultStatus.AMBIGUOUS), envelopes: [] }
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

  return {
    result,
    envelopes: execution.attachments.map((attachment): Envelope => ({ attachment })),
  }
})

const executeStepAfterFailure = (
  nextId: IdGenerator.NewId,
  step: AssembledTestStep,
  supportCodeLibrary: SupportCodeLibrary,
): StepExecution => {
  const prepared = step.prepare()
  if (prepared.type === "undefined") {
    return {
      result: zeroDurationResult(TestStepResultStatus.UNDEFINED),
      envelopes: [suggestionEnvelope(nextId, prepared.pickleStep, supportCodeLibrary)],
    }
  }
  if (prepared.type === "ambiguous") {
    return { result: zeroDurationResult(TestStepResultStatus.AMBIGUOUS), envelopes: [] }
  }
  return { result: zeroDurationResult(TestStepResultStatus.SKIPPED), envelopes: [] }
}

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
