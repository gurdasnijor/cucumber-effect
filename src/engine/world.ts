import {
  AttachmentContentEncoding,
  TimeConversion,
  type Attachment,
  type TestStepStarted,
} from "@cucumber/messages"
import { Clock, Context, Effect, Layer, Ref } from "effect"

type ActiveStep = Pick<TestStepStarted, "testCaseStartedId" | "testStepId">

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

  static readonly layerFor = (active: ActiveStep | undefined) =>
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

const makeAttachments = (active: ActiveStep | undefined) =>
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
          ...(active === undefined
            ? {}
            : { testCaseStartedId: active.testCaseStartedId, testStepId: active.testStepId }),
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
          ...(active === undefined
            ? {}
            : { testCaseStartedId: active.testCaseStartedId, testStepId: active.testStepId }),
        })
      }),
      log: Effect.fn("Attachments.log")(function* (body: string) {
        const timestamp = TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis)
        return yield* store({
          body,
          contentEncoding: AttachmentContentEncoding.IDENTITY,
          mediaType: "text/x.cucumber.log+plain",
          timestamp,
          ...(active === undefined
            ? {}
            : { testCaseStartedId: active.testCaseStartedId, testStepId: active.testStepId }),
        })
      }),
      collect: Ref.get(ref),
    })
  })

export const worldLayer = (active: ActiveStep | undefined = undefined) =>
  Layer.mergeAll(
    ActiveStepContext.layerFor(active),
    Attachments.layerFor(active),
  )

export const provideStepWorld = Effect.fn("provideStepWorld")(function*<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  active: ActiveStep,
) {
  const activeStepContext = yield* makeActiveStepContext(active)
  const attachments = yield* makeAttachments(active)
  return yield* effect.pipe(
    Effect.provideService(ActiveStepContext, activeStepContext),
    Effect.provideService(Attachments, attachments),
  )
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

export const collectAttachments = Effect.fn("collectAttachments")(function* () {
  const attachments = yield* Attachments
  return yield* attachments.collect
})
