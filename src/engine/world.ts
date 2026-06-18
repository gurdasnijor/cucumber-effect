import {
  AttachmentContentEncoding,
  TimeConversion,
  type Attachment,
  type TestStepStarted,
} from "@cucumber/messages"
import { Clock, Context, Effect, Layer, Ref } from "effect"
import { EventBus } from "./event-bus.ts"

type ActiveStep = Pick<TestStepStarted, "testCaseStartedId" | "testStepId">

export class ActiveStepContext extends Context.Service<ActiveStepContext, {
  readonly set: (active: ActiveStep) => Effect.Effect<void>
  readonly get: Effect.Effect<ActiveStep | undefined>
}>()("cucumber-effect/engine/world/ActiveStepContext") {
  static get layer() {
    return Layer.effect(this, makeActiveStepContext)
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
}>()("cucumber-effect/engine/world/Attachments") {
  static get layer() {
    return Layer.effect(this, makeAttachments)
  }
}

const makeActiveStepContext = Effect.gen(function* () {
  const ref = yield* Ref.make<ActiveStep | undefined>(undefined)
  return ActiveStepContext.of({
    set: Effect.fn("ActiveStepContext.set")((active: ActiveStep) => Ref.set(ref, active)),
    get: Ref.get(ref),
  })
})

const makeAttachments = Effect.gen(function* () {
  const activeStep = yield* ActiveStepContext
  const eventBus = yield* EventBus
  return Attachments.of({
    attach: Effect.fn("Attachments.attach")(function* (
    body: string | Uint8Array,
    mediaType: string,
    options?: { readonly fileName?: string },
  ) {
      const active = yield* activeStep.get
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
      return yield* eventBus.publish({ attachment })
    }),
  link: Effect.fn("Attachments.link")(function* (url: string, mediaType = "text/uri-list") {
    const active = yield* activeStep.get
    const timestamp = TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis)
    return yield* eventBus.publish({
      attachment: {
        body: url,
        contentEncoding: AttachmentContentEncoding.IDENTITY,
        mediaType,
        timestamp,
        ...(active === undefined
          ? {}
          : { testCaseStartedId: active.testCaseStartedId, testStepId: active.testStepId }),
      },
    })
  }),
  log: Effect.fn("Attachments.log")(function* (body: string) {
    const active = yield* activeStep.get
    const timestamp = TimeConversion.millisecondsSinceEpochToTimestamp(yield* Clock.currentTimeMillis)
    return yield* eventBus.publish({
      attachment: {
        body,
        contentEncoding: AttachmentContentEncoding.IDENTITY,
        mediaType: "text/x.cucumber.log+plain",
        timestamp,
        ...(active === undefined
          ? {}
          : { testCaseStartedId: active.testCaseStartedId, testStepId: active.testStepId }),
      },
    })
  }),
  })
})

export const worldLayer = () =>
  Layer.mergeAll(
    ActiveStepContext.layer,
    Attachments.layer.pipe(Layer.provideMerge(ActiveStepContext.layer)),
  )

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
