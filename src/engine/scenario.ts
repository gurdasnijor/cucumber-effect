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
  type Attachment,
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
  provideScenarioWorld,
  provideStepWorld,
  provideTestRunHookWorld,
  type ScenarioWorld,
  type WorldServices,
} from "./world.ts"

type ScenarioResult = {
  readonly statuses: ReadonlyArray<TestStepResultStatus>
  readonly envelopes: ReadonlyArray<Envelope>
}

type StepExecution = {
  readonly result: TestStepResult
  readonly attachments: ReadonlyArray<Attachment>
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
  attempt: number,
): Effect.fn.Return<ScenarioResult, never, FileSystem.FileSystem> {
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

  const result = yield* provideScenarioWorld(runScenarioAttempt(assembled, testCaseStartedId))

  const testCaseFinished: Envelope = {
    testCaseFinished: {
      testCaseStartedId,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis),
      willBeRetried: false,
    },
  }

  return {
    statuses: result.statuses,
    envelopes: [
      testCaseStarted,
      ...result.envelopes,
      testCaseFinished,
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
  const execution = yield* Effect.gen(function* () {
    const exit = yield* invokeSupportFunction(hook.fn, []).pipe(Effect.exit)
    const attachments = yield* collectAttachments()
    return { exit, attachments }
  }).pipe((effect) => provideTestRunHookWorld(effect, { testRunHookStartedId }))
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
  assembled: AssembledTestCase,
  testCaseStartedId: string,
) {
  const initial: ScenarioAttemptState = {
    statuses: [],
    envelopes: [],
    failedish: false,
    skipped: false,
  }

  return yield* assembled.testSteps.reduce(
    (effect, step) => effect.pipe(Effect.flatMap((state) => runScenarioStep(state, step, testCaseStartedId))),
    Effect.succeed(initial) as Effect.Effect<ScenarioAttemptState, never, ScenarioWorld | FileSystem.FileSystem>,
  )
})

const runScenarioStep = Effect.fn("runScenarioStep")(function* (
  state: ScenarioAttemptState,
  step: AssembledTestStep,
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
    ? { result: zeroDurationResult(TestStepResultStatus.SKIPPED), attachments: [] }
    : state.failedish && !step.always
      ? executeStepAfterFailure(step)
      : yield* executeStep(step, { testCaseStartedId, testStepId: step.id })

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
      ...execution.attachments.map((attachment): Envelope => ({ attachment })),
      testStepFinished,
    ],
    failedish,
    skipped,
  }
})

const executeStep = Effect.fn("executeStep")(function* (
  step: AssembledTestStep,
  active: { readonly testCaseStartedId: string; readonly testStepId: string },
): Effect.fn.Return<StepExecution, never, ScenarioWorld | FileSystem.FileSystem> {
  const prepared = step.prepare()
  if (prepared.type === "undefined") {
    return { result: zeroDurationResult(TestStepResultStatus.UNDEFINED), attachments: [] }
  }
  if (prepared.type === "ambiguous") {
    return { result: zeroDurationResult(TestStepResultStatus.AMBIGUOUS), attachments: [] }
  }

  const started = yield* Clock.currentTimeMillis
  const execution = yield* Effect.gen(function* () {
    const exit = yield* invokeStep(prepared).pipe(Effect.exit)
    const attachments = yield* collectAttachments()
    return { exit, attachments }
  }).pipe((effect) => provideStepWorld(effect, active))
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

  return { result, attachments: execution.attachments }
})

const executeStepAfterFailure = (step: AssembledTestStep): StepExecution => {
  const prepared = step.prepare()
  if (prepared.type === "undefined") {
    return { result: zeroDurationResult(TestStepResultStatus.UNDEFINED), attachments: [] }
  }
  if (prepared.type === "ambiguous") {
    return { result: zeroDurationResult(TestStepResultStatus.AMBIGUOUS), attachments: [] }
  }
  return { result: zeroDurationResult(TestStepResultStatus.SKIPPED), attachments: [] }
}

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
      return { status: TestStepResultStatus.PENDING, message: value.reason, exception: exceptionFrom(value, "StepPending", value.reason) }
    }
    if (value._tag === "StepSkipped") {
      return { status: TestStepResultStatus.SKIPPED, message: value.reason, exception: exceptionFrom(value, "StepSkipped", value.reason) }
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

const exceptionFrom = (error: unknown, type: string, message: string): Exception => ({
  type,
  message,
  stackTrace: `${type}: ${message}`,
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
