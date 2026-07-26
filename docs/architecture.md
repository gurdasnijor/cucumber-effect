# Architecture

`cucumber-effect` has two separate flows that should stay visible in the code:

- **Data plane**: the public Cucumber Messages stream, `Stream<Envelope>`.
- **Control plane**: the private runner state used to decide what to execute next.

Keeping these separate is the main design constraint for `src/engine/run.ts`.

## Data Plane

The data plane is the observable output of a run. It is the only stream exposed by the engine:

```ts
runFeatures(paths, options): Stream<Envelope, RunnerError, RunnerServices>
```

Consumers such as the CLI, CCK tests, formatters, reporters, and future plugins should consume this stream. Examples of data-plane messages are:

- `source`
- `gherkinDocument`
- `pickle`
- `stepDefinition`
- `testRunStarted`
- `testCase`
- `testCaseStarted`
- `testStepStarted`
- `attachment`
- `testStepFinished`
- `testCaseFinished`
- `testRunFinished`

This stream must preserve Cucumber message ordering. It should not carry private runner-only state.

## Control Plane

The control plane is the runner's private state machine. It contains values that determine what happens next:

- parsed `GherkinDocument`s and `Pickle`s
- `SupportCodeLibrary`
- `testRunStartedId`
- before-all hook statuses
- assembled test cases
- scenario attempt statuses
- after-all hook statuses
- final run success

These values are not themselves public messages. They should remain ordinary Effect values, passed through the runner's linear control flow.

## Runtime Shape

The runner should read as a sequence of Cucumber phases:

```ts
const runControlPlane = Effect.fn("runControlPlane")(function* (
  paths,
  options,
  dataPlane,
) {
  const nextId = IdGenerator.incrementing()

  const gherkin = yield* parseGherkin(paths, options, nextId, dataPlane)
  const support = yield* buildSupportCode(nextId, dataPlane)
  const testRun = yield* startTestRun(nextId, dataPlane)

  const beforeAll = yield* runBeforeAll(testRun, support, nextId, dataPlane)

  const testCases = testRunSuccess(beforeAll.statuses)
    ? yield* assembleAndWriteTestCases(gherkin, support, testRun, nextId, dataPlane)
    : []

  const scenarios = yield* runScenarios(testCases, support, nextId, options, dataPlane)
  const afterAll = yield* runAfterAll(testRun, support, nextId, dataPlane)

  yield* finishTestRun(testRun, beforeAll, scenarios, afterAll, dataPlane)
})
```

The exact helper names can change, but the shape should not:

1. The control plane decides the next action.
2. The data plane writes envelopes as those actions happen.
3. The public API exposes only the data-plane stream.

## Stream Boundary

Internally, scenario execution naturally writes envelopes over time. A small private stream bridge can turn that linear producer into the public stream:

```ts
const runFeatures = (paths, options) =>
  envelopeStreamFromRuntime((dataPlane) =>
    runControlPlane(paths, options, dataPlane)
  )
```

The queue or callback mechanics belong only in this bridge. They should not obscure the Cucumber runtime phases.

## What To Avoid

Avoid mixing planes in a single dense function:

```ts
const parsed = yield* parseAndWrite(...)
const support = yield* build(...)
yield* write(...)
const testCases = ...
yield* write(...)
const statuses = ...
yield* write(...)
```

That style makes it hard to tell which values are public messages and which values are private execution state.

Also avoid creating a second internal event model unless there is a concrete need for it. A `RunnerEvent` stream or `PubSub` would add coordination complexity before the engine has multiple live consumers.

## Alignment With Cucumber JS

Cucumber JS uses an `eventBroadcaster` for the data plane and runtime objects such as the coordinator, support library, and test case runner for the control plane.

The Effect version should map that to:

- `Stream<Envelope>` for the data plane
- `Effect` control flow for the runner state machine
- `Layer` / services for scoped runtime dependencies
