import { NdjsonToMessageStream } from "@cucumber/message-streams"
import type { Envelope } from "@cucumber/messages"
import { Effect, Schema } from "effect"

type Json = undefined | null | boolean | number | string | Json[] | { readonly [key: string]: Json }

export class NdjsonMessageStreamError extends Schema.TaggedErrorClass<NdjsonMessageStreamError>()(
  "NdjsonMessageStreamError",
  { error: Schema.Unknown },
) {}

export const messagesFromNdjson = Effect.fn("messagesFromNdjson")((input: string) =>
  Effect.callback<ReadonlyArray<Envelope>, NdjsonMessageStreamError>((resume) => {
    const stream = new NdjsonToMessageStream()
    const envelopes: Array<Envelope> = []
    const onData = (chunk: unknown) => {
      envelopes.push(chunk as Envelope)
    }
    const onError = (error: unknown) => {
      resume(new NdjsonMessageStreamError({ error }))
    }
    const onEnd = () => {
      resume(Effect.succeed(envelopes))
    }

    stream.on("data", onData)
    stream.once("error", onError)
    stream.once("end", onEnd)
    stream.end(input)

    return Effect.sync(() => {
      stream.off("data", onData)
      stream.off("error", onError)
      stream.off("end", onEnd)
    })
  }))

export const normalize = (envelopes: ReadonlyArray<Envelope>): ReadonlyArray<Json> => {
  const ids = new Map<string, string>()
  const remap = (id: string) => {
    const existing = ids.get(id)
    if (existing !== undefined) {
      return existing
    }
    const next = String(ids.size)
    ids.set(id, next)
    return next
  }

  return envelopes
    .filter((envelope) => envelope.suggestion === undefined)
    .map((envelope) => normalizeValue(envelope as unknown as Json, remap, undefined))
}

const normalizeValue = (
  value: Json,
  remap: (id: string) => string,
  key: string | undefined,
): Json => {
  if (value === undefined || value === null || typeof value === "boolean" || typeof value === "number") {
    return value
  }
  if (typeof value === "string") {
    return shouldRemapId(key) ? remap(value) : stripPath(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, remap, key))
  }

  if (key === "timestamp") {
    return { seconds: 0, nanos: 0 }
  }
  if (key === "duration") {
    return { seconds: 0, nanos: 0 }
  }
  if ("meta" in value) {
    return { meta: { protocolVersion: "31.1.0" } }
  }
  if ("sourceReference" in value) {
    const entries = Object.entries(value).filter(([entryKey, entryValue]) =>
      entryKey !== "sourceReference" && entryValue !== undefined)
    return Object.fromEntries(entries.map(([entryKey, entryValue]) => [
      entryKey,
      normalizeValue(entryValue, remap, entryKey),
    ]))
  }

  return Object.fromEntries(Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .map(([entryKey, entryValue]) => [
      entryKey,
      normalizeValue(entryValue, remap, entryKey),
    ]))
}

const shouldRemapId = (key: string | undefined) =>
  key === "id" ||
  key === "astNodeId" ||
  key === "pickleId" ||
  key === "pickleStepId" ||
  key === "testCaseId" ||
  key === "testStepId" ||
  key === "testRunStartedId" ||
  key === "testCaseStartedId" ||
  key === "testRunHookStartedId" ||
  key === "hookId" ||
  key === "stepDefinitionIds" ||
  key === "astNodeIds"

const stripPath = (value: string) =>
  value
    .replaceAll(process.cwd(), "<cwd>")
    .replace(/samples\/[^:\n]+/g, "samples/<path>")
    .replace(/node_modules\/[^:\n]+/g, "node_modules/<path>")
