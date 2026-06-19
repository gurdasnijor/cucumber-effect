import {
  AttachmentContentEncoding,
  TimeConversion,
  type Attachment,
  type TestStepStarted,
} from "@cucumber/messages"
import { Clock, Context, Effect, FileSystem, Layer, Ref } from "effect"

type ActiveStep = Pick<TestStepStarted, "testCaseStartedId" | "testStepId">
type ActiveAttachmentTarget = ActiveStep | { readonly testRunHookStartedId: string }

type ScenarioRuntime = {
  readonly provide: <A, E, R>(
    effect: Effect.Effect<A, E, R | ScenarioWorld>,
  ) => Effect.Effect<A, E, Exclude<R, ScenarioWorld>>
}

type StepRuntime = {
  readonly provide: <A, E, R>(
    effect: Effect.Effect<A, E, R | ActiveStepContext | Attachments>,
  ) => Effect.Effect<A, E, Exclude<R, ActiveStepContext | Attachments>>
}

type TestRunHookRuntime = {
  readonly provide: <A, E, R>(
    effect: Effect.Effect<A, E, R | ActiveStepContext | Attachments | ScenarioWorld>,
  ) => Effect.Effect<A, E, Exclude<R, ActiveStepContext | Attachments | ScenarioWorld>>
}

export class ActiveStepContext extends Context.Service<ActiveStepContext, {
  readonly set: (active: ActiveStep) => Effect.Effect<void>
  readonly get: Effect.Effect<ActiveStep | undefined>
}>()("cucumber-effect/engine/world/ActiveStepContext") {
  static get layer() {
    return this.layerFor(undefined)
  }

  static readonly layerFor = (active: ActiveStep | undefined) =>
    Layer.effect(this, makeActiveStepContext(active))
}

export class ScenarioWorld extends Context.Service<ScenarioWorld, {
  readonly get: <A = unknown>(key: string) => Effect.Effect<A | undefined>
  readonly set: (key: string, value: unknown) => Effect.Effect<void>
}>()("cucumber-effect/engine/world/ScenarioWorld") {
  static get layer() {
    return Layer.effect(this, makeScenarioWorld)
  }
}

export class Attachments extends Context.Service<Attachments, {
  readonly attach: (
    body: string | Uint8Array,
    mediaType: string,
    options?: { readonly fileName?: string },
  ) => Effect.Effect<void>
  readonly link: (url: string, mediaType?: string) => Effect.Effect<void>
  readonly log: (body: string) => Effect.Effect<void>
  readonly collect: Effect.Effect<ReadonlyArray<Attachment>>
}>()("cucumber-effect/engine/world/Attachments") {
  static get layer() {
    return this.layerFor(undefined)
  }

  static readonly layerFor = (active: ActiveAttachmentTarget | undefined) =>
    Layer.effect(this, makeAttachments(active))
}

const makeActiveStepContext = (active: ActiveStep | undefined) =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<ActiveStep | undefined>(active)
    return ActiveStepContext.of({
      set: Effect.fn("ActiveStepContext.set")((active: ActiveStep) => Ref.set(ref, active)),
      get: Ref.get(ref),
    })
  })

const makeScenarioWorld = Effect.gen(function* () {
  const ref = yield* Ref.make<Readonly<Record<string, unknown>>>({})
  return ScenarioWorld.of({
    get: Effect.fn("ScenarioWorld.get")(function* (key: string) {
      const world = yield* Ref.get(ref)
      return world[key]
    }) as <A = unknown>(key: string) => Effect.Effect<A | undefined>,
    set: Effect.fn("ScenarioWorld.set")((key: string, value: unknown) =>
      Ref.update(ref, (world) => ({ ...world, [key]: value }))),
  })
})

const makeAttachments = (active: ActiveAttachmentTarget | undefined) =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<ReadonlyArray<Attachment>>([])
    const store = Effect.fn("Attachments.store")((attachment: Attachment) =>
      Ref.update(ref, (attachments) => [...attachments, attachment]))
    return Attachments.of({
      attach: Effect.fn("Attachments.attach")(function* (
        body: string | Uint8Array,
        mediaType: string,
        options?: { readonly fileName?: string },
      ) {
        const timestamp = TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis)
        const attachment: Attachment = {
          body: typeof body === "string" ? body : Buffer.from(body).toString("base64"),
          contentEncoding: typeof body === "string"
            ? AttachmentContentEncoding.IDENTITY
            : AttachmentContentEncoding.BASE64,
          mediaType,
          timestamp,
          ...(options?.fileName === undefined ? {} : { fileName: options.fileName }),
          ...activeAttachmentFields(active),
        }
        return yield* store(attachment)
      }),
      link: Effect.fn("Attachments.link")(function* (url: string, mediaType = "text/uri-list") {
        const timestamp = TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis)
        return yield* store({
          body: url,
          contentEncoding: AttachmentContentEncoding.IDENTITY,
          mediaType,
          timestamp,
          ...activeAttachmentFields(active),
        })
      }),
      log: Effect.fn("Attachments.log")(function* (body: string) {
        const timestamp = TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis)
        return yield* store({
          body,
          contentEncoding: AttachmentContentEncoding.IDENTITY,
          mediaType: "text/x.cucumber.log+plain",
          timestamp,
          ...activeAttachmentFields(active),
        })
      }),
      collect: Ref.get(ref),
    })
  })

const activeAttachmentFields = (active: ActiveAttachmentTarget | undefined) => {
  if (active === undefined) {
    return {}
  }
  return "testRunHookStartedId" in active
    ? { testRunHookStartedId: active.testRunHookStartedId }
    : { testCaseStartedId: active.testCaseStartedId, testStepId: active.testStepId }
}

export const worldLayer = (active: ActiveStep | undefined = undefined) =>
  Layer.mergeAll(
    ScenarioWorld.layer,
    ActiveStepContext.layerFor(active),
    Attachments.layerFor(active),
  )

export const makeScenarioRuntime = Effect.fn("makeScenarioRuntime")(function* () {
  const world = yield* makeScenarioWorld
  return {
    provide: (<A, E, R>(effect: Effect.Effect<A, E, R | ScenarioWorld>) =>
      effect.pipe(Effect.provideService(ScenarioWorld, world))) as ScenarioRuntime["provide"],
  } satisfies ScenarioRuntime
})

export const makeStepRuntime = Effect.fn("makeStepRuntime")(function* (active: ActiveStep) {
  const activeStepContext = yield* makeActiveStepContext(active)
  const attachments = yield* makeAttachments(active)
  return {
    provide: (<A, E, R>(effect: Effect.Effect<A, E, R | ActiveStepContext | Attachments>) =>
      effect.pipe(
        Effect.provideService(ActiveStepContext, activeStepContext),
        Effect.provideService(Attachments, attachments),
      )) as StepRuntime["provide"],
  } satisfies StepRuntime
})

export const makeTestRunHookRuntime = Effect.fn("makeTestRunHookRuntime")(function* (
  active: { readonly testRunHookStartedId: string },
) {
  const activeStepContext = yield* makeActiveStepContext(undefined)
  const attachments = yield* makeAttachments(active)
  const world = yield* makeScenarioWorld
  return {
    provide: (<A, E, R>(effect: Effect.Effect<A, E, R | ActiveStepContext | Attachments | ScenarioWorld>) =>
      effect.pipe(
        Effect.provideService(ActiveStepContext, activeStepContext),
        Effect.provideService(Attachments, attachments),
        Effect.provideService(ScenarioWorld, world),
      )) as TestRunHookRuntime["provide"],
  } satisfies TestRunHookRuntime
})

export const attach = Effect.fn("attach")(function* (
  body: string | Uint8Array,
  mediaType: string,
  options?: { readonly fileName?: string },
) {
  const attachments = yield* Attachments
  return yield* attachments.attach(body, mediaType, options)
})

export const log = Effect.fn("log")(function* (body: string) {
  const attachments = yield* Attachments
  return yield* attachments.log(body)
})

export const link = Effect.fn("link")(function* (url: string, mediaType?: string) {
  const attachments = yield* Attachments
  return yield* attachments.link(url, mediaType)
})

export const collectAttachments = Effect.fn("collectAttachments")(function* () {
  const attachments = yield* Attachments
  return yield* attachments.collect
})

export const getWorld = Effect.fn("getWorld")(function*<A = unknown>(key: string) {
  const world = yield* ScenarioWorld
  return yield* world.get<A>(key)
})

export const setWorld = Effect.fn("setWorld")(function* (key: string, value: unknown) {
  const world = yield* ScenarioWorld
  return yield* world.set(key, value)
})

export type WorldServices = ActiveStepContext | Attachments | ScenarioWorld | FileSystem.FileSystem
