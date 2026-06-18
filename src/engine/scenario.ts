import {
  TestStepResultStatus,
  TimeConversion,
  type Attachment,
  type Envelope,
  type Exception,
  type IdGenerator,
  type Pickle,
  type TestCase,
  type TestStep,
  type TestStepResult,
} from "@cucumber/messages"
import { Cause, Clock, Effect, Exit, Option } from "effect"
import { type StepError } from "./errors.ts"
import { Registry, makeDataTable, type RegisteredSupportStepDefinition, type ResolvedStep } from "./registry.ts"
import { collectAttachments, provideStepWorld } from "./world.ts"

type AssembledStep = {
  readonly pickleStep: Pickle["steps"][number]
  readonly testStep: TestStep
  readonly resolved?: ResolvedStep
  readonly status?: TestStepResultStatus.UNDEFINED | TestStepResultStatus.AMBIGUOUS
}

type AssembledTestCase = {
  readonly pickle: Pickle
  readonly testCase: TestCase
  readonly steps: ReadonlyArray<AssembledStep>
}

type ScenarioResult = {
  readonly statuses: ReadonlyArray<TestStepResultStatus>
  readonly envelopes: ReadonlyArray<Envelope>
}

type StepExecution = {
  readonly result: TestStepResult
  readonly attachments: ReadonlyArray<Attachment>
}

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

export const emitStepDefinitions = Effect.fn("emitStepDefinitions")(function* (nextId: IdGenerator.NewId) {
  const registry = yield* Registry
  const parameterTypes = registry.parameterTypes.map((parameterType): Envelope => ({
    parameterType: {
      id: nextId(),
      name: parameterType.name,
      regularExpressions: toRegularExpressionSources(parameterType.regexp),
      preferForRegularExpressionMatch: parameterType.preferForRegexpMatch ?? false,
      useForSnippets: parameterType.useForSnippets ?? true,
    },
  }))

  const entries = registry.definitions.map((definition) => {
    const id = nextId()
    return {
      definition,
      id,
      envelope: {
        stepDefinition: {
          id,
          pattern: {
            type: definition.patternType,
            source: definition.patternSource,
          },
          sourceReference: definition.sourceReference ?? {},
        },
      },
    } satisfies { readonly definition: RegisteredSupportStepDefinition; readonly id: string; readonly envelope: Envelope }
  })
  return {
    stepDefinitionIds: entries.map((entry) => entry.id),
    envelopes: [
      ...parameterTypes,
      ...entries.map((entry) => entry.envelope),
    ],
  }
})

const toRegularExpressionSources = (regexp: string | RegExp | ReadonlyArray<string | RegExp>) => {
  const values = Array.isArray(regexp) ? regexp : [regexp]
  return values.map((value) => typeof value === "string" ? value : value.source)
}

export const assembleTestCases = Effect.fn("assembleTestCases")(function* (
  nextId: IdGenerator.NewId,
  testRunStartedId: string,
  pickles: ReadonlyArray<Pickle>,
  stepDefinitionIds: ReadonlyArray<string>,
) {
  return yield* Effect.forEach(
    pickles,
    (pickle) => assembleTestCase(nextId, testRunStartedId, pickle, stepDefinitionIds),
    { concurrency: 1 },
  )
})

const assembleTestCase = Effect.fn("assembleTestCase")(function* (
  nextId: IdGenerator.NewId,
  testRunStartedId: string,
  pickle: Pickle,
  stepDefinitionIds: ReadonlyArray<string>,
) {
  const steps = yield* Effect.forEach(
    pickle.steps,
    (pickleStep) => assembleTestStep(nextId, pickleStep, stepDefinitionIds),
    { concurrency: 1 },
  )
  return {
    pickle,
    testCase: {
      id: nextId(),
      pickleId: pickle.id,
      testSteps: steps.map((step) => step.testStep),
      testRunStartedId,
    },
    steps,
  }
})

const assembleTestStep = Effect.fn("assembleTestStep")(function* (
  nextId: IdGenerator.NewId,
  pickleStep: Pickle["steps"][number],
  stepDefinitionIds: ReadonlyArray<string>,
): Effect.fn.Return<AssembledStep, never, Registry> {
  const registry = yield* Registry
  const testStepId = nextId()
  const candidates = yield* registry.match(pickleStep.text)
  if (candidates.length === 0) {
    return {
      pickleStep,
      testStep: {
        id: testStepId,
        pickleStepId: pickleStep.id,
        stepDefinitionIds: [],
        stepMatchArgumentsLists: [],
      },
      status: TestStepResultStatus.UNDEFINED,
    }
  }
  if (candidates.length > 1) {
    return {
      pickleStep,
      testStep: {
        id: testStepId,
        pickleStepId: pickleStep.id,
        stepDefinitionIds: candidates.flatMap((candidate) => {
          const definitionId = stepDefinitionIds[candidate.definitionIndex]
          return definitionId === undefined ? [] : [definitionId]
        }),
        stepMatchArgumentsLists: candidates.map((candidate) => ({
          stepMatchArguments: candidate.matchArguments,
        })),
      },
      status: TestStepResultStatus.AMBIGUOUS,
    }
  }

  const resolved = candidates[0] as ResolvedStep
  const definitionId = stepDefinitionIds[resolved.definitionIndex]
  return {
    pickleStep,
    testStep: {
      id: testStepId,
      pickleStepId: pickleStep.id,
      stepDefinitionIds: definitionId === undefined ? [] : [definitionId],
      stepMatchArgumentsLists: [{ stepMatchArguments: resolved.matchArguments }],
    },
    resolved,
  }
})

export const runScenario = Effect.fn("runScenario")(function* (
  nextId: IdGenerator.NewId,
  assembled: AssembledTestCase,
  attempt: number,
): Effect.fn.Return<ScenarioResult> {
  const testCaseStartedId = nextId()
  const timestamp = TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis)
  const testCaseStarted: Envelope = {
    testCaseStarted: {
      id: testCaseStartedId,
      testCaseId: assembled.testCase.id,
      timestamp,
      attempt,
    },
  }

  const result = yield* runScenarioAttempt(assembled, testCaseStartedId)

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

  return yield* assembled.steps.reduce(
    (effect, step) => effect.pipe(Effect.flatMap((state) => runScenarioStep(state, step, testCaseStartedId))),
    Effect.succeed(initial),
  )
})

const runScenarioStep = Effect.fn("runScenarioStep")(function* (
  state: ScenarioAttemptState,
  step: AssembledStep,
  testCaseStartedId: string,
): Effect.fn.Return<ScenarioAttemptState> {
  const testStepStarted: Envelope = {
    testStepStarted: {
      testCaseStartedId,
      testStepId: step.testStep.id,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis),
    },
  }

  const execution = state.failedish || state.skipped
    ? { result: zeroDurationResult(TestStepResultStatus.SKIPPED), attachments: [] }
    : yield* executeStep(step, { testCaseStartedId, testStepId: step.testStep.id })

  const result = execution.result
  const skipped = state.skipped || (result.status === TestStepResultStatus.SKIPPED && !state.failedish)
  const failedish = state.failedish ||
    (result.status !== TestStepResultStatus.PASSED && result.status !== TestStepResultStatus.SKIPPED)

  const testStepFinished: Envelope = {
    testStepFinished: {
      testCaseStartedId,
      testStepId: step.testStep.id,
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
  step: AssembledStep,
  active: { readonly testCaseStartedId: string; readonly testStepId: string },
): Effect.fn.Return<StepExecution> {
  if (step.status !== undefined) {
    return { result: zeroDurationResult(step.status), attachments: [] }
  }
  if (step.resolved === undefined) {
    return { result: zeroDurationResult(TestStepResultStatus.UNDEFINED), attachments: [] }
  }

  const resolved = step.resolved
  const started = yield* Clock.currentTimeMillis
  const execution = yield* Effect.gen(function* () {
    const exit = yield* invokeStep(resolved, step.pickleStep).pipe(Effect.exit)
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

const invokeStep = (
  resolved: ResolvedStep,
  pickleStep: Pickle["steps"][number],
) => {
  const dataTable = pickleStep.argument?.dataTable === undefined
    ? undefined
    : makeDataTable(pickleStep.argument.dataTable.rows.map((row) => row.cells.map((cell) => cell.value)))
  const docString = pickleStep.argument?.docString?.content
  const args = [
    ...resolved.args,
    ...(dataTable === undefined ? [] : [dataTable]),
    ...(docString === undefined ? [] : [docString]),
  ]
  return Effect.sync(() => resolved.definition.implementation(...args)).pipe(
    Effect.flatMap((returned) => Effect.isEffect(returned) ? returned : Effect.succeed(returned)),
  )
}

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
  return {
    status: TestStepResultStatus.FAILED,
    message: String(squashed),
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
