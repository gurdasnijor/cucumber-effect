import {
  CucumberExpression,
  ParameterType,
  ParameterTypeRegistry,
  RegularExpression,
  type Argument,
  type Expression,
  type RegExps,
  type StringOrRegExp,
} from "@cucumber/cucumber-expressions"
import { StepDefinitionPatternType, type SourceReference, type StepMatchArgument } from "@cucumber/messages"
import { Context, Effect, Layer } from "effect"
import { AmbiguousStep, type StepError, UndefinedStep } from "./errors.ts"
import type { EventBus } from "./event-bus.ts"
import type { ActiveStepContext, Attachments } from "./world.ts"

class SupportDataTable {
  constructor(private readonly rows: ReadonlyArray<ReadonlyArray<string>>) {}

  raw() {
    return this.rows
  }

  transpose() {
    const width = this.rows.reduce((max, row) => Math.max(max, row.length), 0)
    return new SupportDataTable(Array.from({ length: width }, (_, column) =>
      this.rows.map((row) => row[column] ?? "")))
  }
}

type StepReturn =
  | void
  | "pending"
  | "skipped"
  | Effect.Effect<void | "pending" | "skipped", StepError, ActiveStepContext | Attachments | EventBus>

export type StepImplementation = (...args: ReadonlyArray<unknown>) => StepReturn

type SupportStepDefinition = {
  readonly expression: StringOrRegExp
  readonly implementation: StepImplementation
  readonly sourceReference?: SourceReference
}

export type RegisteredSupportStepDefinition = SupportStepDefinition & {
  readonly patternType: StepDefinitionPatternType
  readonly patternSource: string
  readonly expressionObject: Expression
}

type SupportParameterType<T = unknown> = {
  readonly name: string
  readonly regexp: RegExps
  readonly transformer: (...matches: ReadonlyArray<string>) => T
  readonly useForSnippets?: boolean
  readonly preferForRegexpMatch?: boolean
}

export type ResolvedStep = {
  readonly definition: RegisteredSupportStepDefinition
  readonly definitionIndex: number
  readonly args: ReadonlyArray<unknown>
  readonly matchArguments: ReadonlyArray<StepMatchArgument>
}

export type SupportBuilder = {
  readonly Given: (expression: StringOrRegExp, implementation: StepImplementation) => void
  readonly When: (expression: StringOrRegExp, implementation: StepImplementation) => void
  readonly Then: (expression: StringOrRegExp, implementation: StepImplementation) => void
  readonly ParameterType: <T>(definition: SupportParameterType<T>) => void
}

export class Registry extends Context.Service<Registry, {
  readonly definitions: ReadonlyArray<RegisteredSupportStepDefinition>
  readonly parameterTypes: ReadonlyArray<SupportParameterType>
  readonly match: (text: string) => Effect.Effect<ReadonlyArray<ResolvedStep>>
  readonly resolve: (text: string) => Effect.Effect<ResolvedStep, UndefinedStep | AmbiguousStep>
}>()("cucumber-effect/engine/registry") {
  static readonly layerFromDefinitions = (
    definitions: ReadonlyArray<SupportStepDefinition>,
    parameterTypes: ReadonlyArray<SupportParameterType>,
  ) =>
    Layer.effect(this, Effect.sync(() => {
      const parameterTypeRegistry = new ParameterTypeRegistry()
      for (const definition of parameterTypes) {
        parameterTypeRegistry.defineParameterType(new ParameterType(
          definition.name,
          definition.regexp,
          null,
          (...matches) => definition.transformer(...matches),
          definition.useForSnippets,
          definition.preferForRegexpMatch,
        ))
      }

      const registered = definitions.map((definition) => {
        if (definition.expression instanceof RegExp) {
          return {
            ...definition,
            patternType: StepDefinitionPatternType.REGULAR_EXPRESSION,
            patternSource: definition.expression.source,
            expressionObject: new RegularExpression(definition.expression, parameterTypeRegistry),
          }
        }
        return {
          ...definition,
          patternType: StepDefinitionPatternType.CUCUMBER_EXPRESSION,
          patternSource: definition.expression,
          expressionObject: new CucumberExpression(definition.expression, parameterTypeRegistry),
        }
      })

      return Registry.of({
        definitions: registered,
        parameterTypes,
        match: Effect.fn("Registry.match")((text: string) =>
          Effect.sync(() => findMatches(registered, text))),
        resolve: Effect.fn("Registry.resolve")(function* (text: string) {
          const matches = yield* Effect.sync(() => findMatches(registered, text))
          if (matches.length === 0) {
            return yield* new UndefinedStep({ text })
          }
          if (matches.length > 1) {
            return yield* new AmbiguousStep({ text, count: matches.length })
          }
          return matches[0] as ResolvedStep
        }),
      })
    }))
}

const findMatches = (registered: ReadonlyArray<RegisteredSupportStepDefinition>, text: string) =>
  registered.flatMap((definition, definitionIndex) => {
    const args = definition.expressionObject.match(text)
    return args === null
      ? []
      : [{
        definition,
        definitionIndex,
        args: args.map((arg) => arg.getValue(null)),
        matchArguments: args.map(toStepMatchArgument),
      }]
  })

export const makeDataTable = (rows: ReadonlyArray<ReadonlyArray<string>>) => new SupportDataTable(rows)

export const defineSupport = (register: (builder: SupportBuilder) => void) => {
  const definitions: Array<SupportStepDefinition> = []
  const parameterTypes: Array<SupportParameterType> = []
  const add = (expression: StringOrRegExp, implementation: StepImplementation) => {
    definitions.push({ expression, implementation })
  }
  register({
    Given: add,
    When: add,
    Then: add,
    ParameterType: (definition) => {
      parameterTypes.push(definition)
    },
  })
  return Registry.layerFromDefinitions(definitions, parameterTypes)
}

const toStepMatchArgument = (argument: Argument): StepMatchArgument => {
  const parameterTypeName = argument.getParameterType().name
  return {
    group: toGroup(argument.group),
    ...(parameterTypeName === undefined ? {} : { parameterTypeName }),
  }
}

const toGroup = (group: Argument["group"]): StepMatchArgument["group"] => ({
  ...(group.start === undefined ? {} : { start: group.start }),
  value: group.value,
  ...(group.children === undefined ? {} : { children: group.children.map(toGroup) }),
})
