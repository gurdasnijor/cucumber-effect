import {
  TestStepResultStatus,
  TimeConversion,
  type Exception,
  type IdGenerator,
  type Pickle,
  type TestCase,
  type TestStep,
  type TestStepResult,
} from "@cucumber/messages"
import { Cause, Clock, Effect, Exit, Option } from "effect"
import { type StepError } from "./errors.ts"
import { publish } from "./event-bus.ts"
import { Registry, makeDataTable, type RegisteredSupportStepDefinition, type ResolvedStep } from "./registry.ts"
import { ActiveStepContext, worldLayer } from "./world.ts"

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

const NON_SUCCESS_STATUSES = new Set<TestStepResultStatus>([
  TestStepResultStatus.PENDING,
  TestStepResultStatus.UNDEFINED,
  TestStepResultStatus.AMBIGUOUS,
  TestStepResultStatus.FAILED,
])

export const emitStepDefinitions = Effect.fn("emitStepDefinitions")(function* (nextId: IdGenerator.NewId) {
  const registry = yield* Registry
  for (const parameterType of registry.parameterTypes) {
    yield* publish({
      parameterType: {
        id: nextId(),
        name: parameterType.name,
        regularExpressions: toRegularExpressionSources(parameterType.regexp),
        preferForRegularExpressionMatch: parameterType.preferForRegexpMatch ?? false,
        useForSnippets: parameterType.useForSnippets ?? true,
      },
    })
  }

  const entries: Array<{ readonly definition: RegisteredSupportStepDefinition; readonly id: string }> = []
  for (const definition of registry.definitions) {
    const id = nextId()
    entries.push({ definition, id })
    yield* publish({
      stepDefinition: {
        id,
        pattern: {
          type: definition.patternType,
          source: definition.patternSource,
        },
        sourceReference: definition.sourceReference ?? {},
      },
    })
  }
  return entries.map((entry) => entry.id)
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
  const registry = yield* Registry
  const testCases: Array<AssembledTestCase> = []

  for (const pickle of pickles) {
    const testSteps: Array<TestStep> = []
    const steps: Array<AssembledStep> = []
    for (const pickleStep of pickle.steps) {
      const testStepId = nextId()
      const candidates = yield* registry.match(pickleStep.text)
      if (candidates.length === 0) {
        const testStep: TestStep = {
          id: testStepId,
          pickleStepId: pickleStep.id,
          stepDefinitionIds: [],
          stepMatchArgumentsLists: [],
        }
        testSteps.push(testStep)
        steps.push({ pickleStep, testStep, status: TestStepResultStatus.UNDEFINED })
      } else if (candidates.length > 1) {
        const testStep: TestStep = {
          id: testStepId,
          pickleStepId: pickleStep.id,
          stepDefinitionIds: candidates.flatMap((candidate) => {
            const definitionId = stepDefinitionIds[candidate.definitionIndex]
            return definitionId === undefined ? [] : [definitionId]
          }),
          stepMatchArgumentsLists: candidates.map((candidate) => ({
            stepMatchArguments: candidate.matchArguments,
          })),
        }
        testSteps.push(testStep)
        steps.push({ pickleStep, testStep, status: TestStepResultStatus.AMBIGUOUS })
      } else {
        const resolved = candidates[0] as ResolvedStep
        const definitionId = stepDefinitionIds[resolved.definitionIndex]
        const testStep: TestStep = {
          id: testStepId,
          pickleStepId: pickleStep.id,
          stepDefinitionIds: definitionId === undefined ? [] : [definitionId],
          stepMatchArgumentsLists: [{ stepMatchArguments: resolved.matchArguments }],
        }
        testSteps.push(testStep)
        steps.push({ pickleStep, testStep, resolved })
      }
    }

    const testCase: TestCase = {
      id: nextId(),
      pickleId: pickle.id,
      testSteps,
      testRunStartedId,
    }
    yield* publish({ testCase })
    testCases.push({ pickle, testCase, steps })
  }

  return testCases
})

export const runScenario = Effect.fn("runScenario")(function* (
  nextId: IdGenerator.NewId,
  assembled: AssembledTestCase,
  attempt: number,
) {
  const testCaseStartedId = nextId()
  const timestamp = TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis)
  yield* publish({
    testCaseStarted: {
      id: testCaseStartedId,
      testCaseId: assembled.testCase.id,
      timestamp,
      attempt,
    },
  })

  const statuses = yield* runScenarioAttempt(assembled, testCaseStartedId).pipe(Effect.provide(worldLayer()))

  yield* publish({
    testCaseFinished: {
      testCaseStartedId,
      timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis),
      willBeRetried: false,
    },
  })

  return statuses
})

const runScenarioAttempt = Effect.fn("runScenarioAttempt")(function* (
  assembled: AssembledTestCase,
  testCaseStartedId: string,
) {
  const statuses = new Set<TestStepResultStatus>()
  let failedish = false
  let skipped = false

  for (const step of assembled.steps) {
    yield* publish({
      testStepStarted: {
        testCaseStartedId,
        testStepId: step.testStep.id,
        timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis),
      },
    })

    const activeStep = yield* ActiveStepContext
    yield* activeStep.set({ testCaseStartedId, testStepId: step.testStep.id })

    const result = failedish || skipped
      ? zeroDurationResult(TestStepResultStatus.SKIPPED)
      : yield* executeStep(step)

    statuses.add(result.status)
    if (result.status === TestStepResultStatus.SKIPPED && !failedish) {
      skipped = true
    }
    if (result.status !== TestStepResultStatus.PASSED && result.status !== TestStepResultStatus.SKIPPED) {
      failedish = true
    }

    yield* publish({
      testStepFinished: {
        testCaseStartedId,
        testStepId: step.testStep.id,
        testStepResult: result,
        timestamp: TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis),
      },
    })
  }

  return statuses
})

const executeStep = Effect.fn("executeStep")(function* (step: AssembledStep) {
  if (step.status !== undefined) {
    return zeroDurationResult(step.status)
  }
  if (step.resolved === undefined) {
    return zeroDurationResult(TestStepResultStatus.UNDEFINED)
  }

  const started = yield* Clock.currentTimeMillis
  const exit = yield* invokeStep(step.resolved, step.pickleStep).pipe(Effect.exit)
  const ended = yield* Clock.currentTimeMillis
  const duration = TimeConversion.millisecondsToDuration(ended - started)

  return Exit.match(exit, {
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
