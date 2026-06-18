import type { Envelope } from "@cucumber/messages"
import { Context, Effect, Exit, Layer, PubSub, Stream, type Take } from "effect"

export class EventBus extends Context.Service<EventBus, {
  readonly publish: (envelope: Envelope) => Effect.Effect<void>
  readonly finish: Effect.Effect<void>
  readonly envelopes: Stream.Stream<Envelope>
}>()("cucumber-effect/engine/event-bus/EventBus") {
  static get layer() {
    return Layer.effect(this, makeEventBus)
  }
}

const makeEventBus = Effect.gen(function* () {
  const pubsub = yield* PubSub.bounded<Take.Take<Envelope>>({
    capacity: 1024,
    replay: 1024,
  })
  return EventBus.of({
    publish: Effect.fn("EventBus.publish")((envelope: Envelope) =>
      PubSub.publish(pubsub, [envelope]).pipe(Effect.asVoid)),
    finish: PubSub.publish(pubsub, Exit.succeed<void>(undefined)).pipe(Effect.asVoid),
    envelopes: Stream.fromPubSubTake(pubsub),
  })
})

export const publish = Effect.fn("publish")(function* (envelope: Envelope) {
  const eventBus = yield* EventBus
  return yield* eventBus.publish(envelope)
})

export const finish = Effect.fn("finish")(function* () {
  const eventBus = yield* EventBus
  return yield* eventBus.finish
})

export const envelopeStream = Effect.fn("envelopeStream")(function* () {
  const eventBus = yield* EventBus
  return eventBus.envelopes
})
