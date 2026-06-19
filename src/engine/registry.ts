import {
  buildSupportCode,
  type NewParameterType,
  type SupportCodeFunction,
  type SupportCodeLibrary,
} from "@cucumber/core"
import type { IdGenerator } from "@cucumber/messages"
import { Context, Effect, Layer } from "effect"
import type { StepError } from "./errors.ts"
import type { WorldServices } from "./world.ts"

type StepReturn =
  | void
  | "pending"
  | "skipped"
  | Promise<void | "pending" | "skipped">
  | Effect.Effect<void | "pending" | "skipped", StepError, WorldServices>
  | Effect.fn.Return<void | "pending" | "skipped", StepError, WorldServices>

export type StepImplementation = (...args: ReadonlyArray<unknown>) => StepReturn

type SupportParameterType<T = unknown> = Omit<NewParameterType, "sourceReference" | "transformer"> & {
  readonly transformer?: (...matches: ReadonlyArray<string>) => T
  readonly sourceReference?: NewParameterType["sourceReference"]
}

type SupportHookOptions = {
  readonly name?: string
  readonly tags?: string
  readonly sourceReference?: NewParameterType["sourceReference"]
}

type SupportStepDefinition = {
  readonly pattern: string | RegExp
  readonly implementation: StepImplementation
}

type SupportHookDefinition = {
  readonly options: SupportHookOptions
  readonly implementation: StepImplementation
}

type SupportRegistration =
  | { readonly _tag: "ParameterType"; readonly definition: SupportParameterType }
  | { readonly _tag: "Step"; readonly definition: SupportStepDefinition }
  | { readonly _tag: "Before"; readonly definition: SupportHookDefinition }
  | { readonly _tag: "After"; readonly definition: SupportHookDefinition }
  | { readonly _tag: "BeforeAll"; readonly definition: SupportHookDefinition }
  | { readonly _tag: "AfterAll"; readonly definition: SupportHookDefinition }

export type SupportBuilder = {
  readonly Given: (expression: string | RegExp, implementation: StepImplementation) => void
  readonly When: (expression: string | RegExp, implementation: StepImplementation) => void
  readonly Then: (expression: string | RegExp, implementation: StepImplementation) => void
  readonly Before: (options: SupportHookOptions, implementation: StepImplementation) => void
  readonly After: (options: SupportHookOptions, implementation: StepImplementation) => void
  readonly BeforeAll: (options: SupportHookOptions, implementation: StepImplementation) => void
  readonly AfterAll: (options: SupportHookOptions, implementation: StepImplementation) => void
  readonly ParameterType: <T>(definition: SupportParameterType<T>) => void
}

export class Registry extends Context.Service<Registry, {
  readonly buildSupportCodeLibrary: (nextId: IdGenerator.NewId) => SupportCodeLibrary
}>()("cucumber-effect/engine/registry") {}

export const defineSupport = (register: (builder: SupportBuilder) => void) => {
  const registrations: Array<SupportRegistration> = []
  const defineStep = (pattern: string | RegExp, implementation: StepImplementation) => {
    registrations.push({
      _tag: "Step",
      definition: { pattern, implementation },
    })
  }
  const defineHook = (
    _tag: "Before" | "After" | "BeforeAll" | "AfterAll",
    options: SupportHookOptions,
    implementation: StepImplementation,
  ) => {
    registrations.push({
      _tag,
      definition: { options, implementation },
    })
  }

  register({
    Given: defineStep,
    When: defineStep,
    Then: defineStep,
    Before: (options, implementation) => defineHook("Before", options, implementation),
    After: (options, implementation) => defineHook("After", options, implementation),
    BeforeAll: (options, implementation) => defineHook("BeforeAll", options, implementation),
    AfterAll: (options, implementation) => defineHook("AfterAll", options, implementation),
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
    } else if (registration._tag === "Step") {
      builder.step({
        pattern: registration.definition.pattern,
        fn: liftSupportFunction(registration.definition.pattern, registration.definition.implementation),
        sourceReference: {},
      })
    } else if (registration._tag === "Before") {
      builder.beforeHook(toCoreHook(registration.definition))
    } else if (registration._tag === "After") {
      builder.afterHook(toCoreHook(registration.definition))
    } else if (registration._tag === "BeforeAll") {
      builder.beforeAllHook(toCoreHook(registration.definition))
    } else {
      builder.afterAllHook(toCoreHook(registration.definition))
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

const toCoreHook = (definition: SupportHookDefinition) => ({
  fn: liftSupportFunction(definition.options.name ?? "hook", definition.implementation),
  sourceReference: definition.options.sourceReference ?? {},
  ...(definition.options.name === undefined ? {} : { name: definition.options.name }),
  ...(definition.options.tags === undefined ? {} : { tags: definition.options.tags }),
})

const liftSupportFunction = (name: string | RegExp, implementation: StepImplementation): SupportCodeFunction =>
  isGeneratorFunction(implementation)
    ? Effect.fn(typeof name === "string" ? name : name.source)(implementation as GeneratorStepImplementation) as SupportCodeFunction
    : implementation as SupportCodeFunction

type GeneratorStepImplementation = (
  ...args: ReadonlyArray<unknown>
) => Effect.fn.Return<void | "pending" | "skipped", StepError, WorldServices>

const isGeneratorFunction = (value: unknown) =>
  typeof value === "function" && value.constructor.name === "GeneratorFunction"
