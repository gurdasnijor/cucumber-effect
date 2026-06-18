import { Schema } from "effect"

export class StepPending extends Schema.TaggedErrorClass<StepPending>()("StepPending", {
  reason: Schema.String,
}) {}

export class StepSkipped extends Schema.TaggedErrorClass<StepSkipped>()("StepSkipped", {
  reason: Schema.String,
}) {}

export class StepFailed extends Schema.TaggedErrorClass<StepFailed>()("StepFailed", {
  message: Schema.String,
  type: Schema.String,
  stack: Schema.optionalKey(Schema.String),
}) {}

export class UndefinedStep extends Schema.TaggedErrorClass<UndefinedStep>()("UndefinedStep", {
  text: Schema.String,
}) {}

export class AmbiguousStep extends Schema.TaggedErrorClass<AmbiguousStep>()("AmbiguousStep", {
  text: Schema.String,
  count: Schema.Number,
}) {}

export class GherkinStreamError extends Schema.TaggedErrorClass<GherkinStreamError>()("GherkinStreamError", {
  error: Schema.Unknown,
}) {}

export type StepError = StepPending | StepSkipped | StepFailed
