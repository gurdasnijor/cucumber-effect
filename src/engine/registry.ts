import {
  buildSupportCode,
  type NewParameterType,
  type SupportCodeFunction,
  type SupportCodeLibrary,
} from "@cucumber/core"
import type { IdGenerator } from "@cucumber/messages"
import { Context, Layer, type Effect } from "effect"
import type { StepError } from "./errors.ts"
import type { ActiveStepContext, Attachments } from "./world.ts"

type StepReturn<R> =
  | void
  | "pending"
  | "skipped"
  | Promise<void | "pending" | "skipped">
  | Effect.Effect<void | "pending" | "skipped", StepError, R | ActiveStepContext | Attachments>

export type StepImplementation<R = never> = (...args: ReadonlyArray<unknown>) => StepReturn<R>

type SupportParameterType<T = unknown> = Omit<NewParameterType, "sourceReference" | "transformer"> & {
  readonly transformer?: (...matches: ReadonlyArray<string>) => T
  readonly sourceReference?: NewParameterType["sourceReference"]
}

type SupportStepDefinition = {
  readonly pattern: string | RegExp
  readonly implementation: StepImplementation<unknown>
}

type SupportRegistration =
  | { readonly _tag: "ParameterType"; readonly definition: SupportParameterType }
  | { readonly _tag: "Step"; readonly definition: SupportStepDefinition }

export type SupportBuilder = {
  readonly Given: <R>(expression: string | RegExp, implementation: StepImplementation<R>) => void
  readonly When: <R>(expression: string | RegExp, implementation: StepImplementation<R>) => void
  readonly Then: <R>(expression: string | RegExp, implementation: StepImplementation<R>) => void
  readonly ParameterType: <T>(definition: SupportParameterType<T>) => void
}

export class Registry extends Context.Service<Registry, {
  readonly buildSupportCodeLibrary: (nextId: IdGenerator.NewId) => SupportCodeLibrary
}>()("cucumber-effect/engine/registry") {}

export const defineSupport = (register: (builder: SupportBuilder) => void) => {
  const registrations: Array<SupportRegistration> = []
  const defineStep = <R>(pattern: string | RegExp, implementation: StepImplementation<R>) => {
    registrations.push({
      _tag: "Step",
      definition: { pattern, implementation: implementation as StepImplementation<unknown> },
    })
  }

  register({
    Given: defineStep,
    When: defineStep,
    Then: defineStep,
    ParameterType: (definition) => registrations.push({ _tag: "ParameterType", definition }),
  })

  return Layer.succeed(Registry, Registry.of({
    buildSupportCodeLibrary: (nextId) => buildRegisteredSupport(registrations, nextId),
  }))
}

const buildRegisteredSupport = (
  registrations: ReadonlyArray<SupportRegistration>,
  nextId: IdGenerator.NewId,
) => {
  const builder = buildSupportCode({ newId: nextId })
  for (const registration of registrations) {
    if (registration._tag === "ParameterType") {
      builder.parameterType(toCoreParameterType(registration.definition))
    } else {
      builder.step({
        pattern: registration.definition.pattern,
        fn: registration.definition.implementation as SupportCodeFunction,
        sourceReference: {},
      })
    }
  }
  return builder.build()
}

const toCoreParameterType = (definition: SupportParameterType): NewParameterType => ({
  name: definition.name,
  regexp: definition.regexp,
  sourceReference: definition.sourceReference ?? {},
  ...(definition.useForSnippets === undefined ? {} : { useForSnippets: definition.useForSnippets }),
  ...(definition.preferForRegexpMatch === undefined ? {} : { preferForRegexpMatch: definition.preferForRegexpMatch }),
  ...(definition.transformer === undefined
    ? {}
    : { transformer: (...matches: string[]) => definition.transformer?.(...matches) }),
})
