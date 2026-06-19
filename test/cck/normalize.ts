import { NodeStream } from "@effect/platform-node"
import { NdjsonToMessageStream } from "@cucumber/message-streams"
import type { Envelope } from "@cucumber/messages"
import { Effect, Schema, Stream } from "effect"
import { Readable } from "node:stream"

// CCK fixtures are produced by another implementation. These helpers keep the
// assertion focused on message semantics instead of generated ids, timestamps,
// source-reference paths, and the fixture repo's "samples/" path convention.
type Json = undefined | null | boolean | number | string | Json[] | { readonly [key: string]: Json }

export class NdjsonMessageStreamError extends Schema.TaggedErrorClass<NdjsonMessageStreamError>()(
  "NdjsonMessageStreamError",
  { error: Schema.Unknown },
) {}

export const readCckNdjsonMessages = Effect.fn("readCckNdjsonMessages")((input: string) =>
  NodeStream.fromReadable<Envelope, NdjsonMessageStreamError>({
    evaluate: () => Readable.from([input]).pipe(new NdjsonToMessageStream()),
    onError: (error) => new NdjsonMessageStreamError({ error }),
  }).pipe(Stream.runCollect))

export const normalizeForCckComparison = (envelopes: ReadonlyArray<Envelope>): ReadonlyArray<Json> => {
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
    .filter((envelope) => envelope.suggestion === undefined && envelope.meta === undefined)
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
  if ("sourceReference" in value) {
    const entries = Object.entries(value).filter(([entryKey, entryValue]) =>
      entryKey !== "sourceReference" && entryKey !== "stackTrace" && entryValue !== undefined)
    return Object.fromEntries(entries.map(([entryKey, entryValue]) => [
      entryKey,
      normalizeValue(entryValue, remap, entryKey),
    ]))
  }

  return Object.fromEntries(Object.entries(value)
    .filter(([entryKey, entryValue]) => entryKey !== "stackTrace" && entryValue !== undefined)
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
    .replace(/(?:samples\/)?[a-z0-9-]+\/[a-z0-9-]+\.feature(?:\.md)?/gi, "samples/<path>")
    .replace(/samples\/[^:\n]+/g, "samples/<path>")
    .replace(/node_modules\/[^:\n]+/g, "node_modules/<path>")
