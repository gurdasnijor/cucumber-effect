import type { SupportCodeLibrary } from "@cucumber/core"
import {
  PickleStepType,
  type PickleStep,
  type PickleStepArgument,
  type Snippet,
} from "@cucumber/messages"

const PRIMITIVE_TYPES = new Set(["Number", "String"])

const METHOD_BY_TYPE: Record<PickleStepType, string> = {
  [PickleStepType.CONTEXT]: "Given",
  [PickleStepType.ACTION]: "When",
  [PickleStepType.OUTCOME]: "Then",
  [PickleStepType.UNKNOWN]: "Given",
}

export const makeSnippets = (
  pickleStep: PickleStep,
  supportCodeLibrary: SupportCodeLibrary,
): ReadonlyArray<Snippet> => {
  const method = METHOD_BY_TYPE[pickleStep.type ?? PickleStepType.UNKNOWN]
  const stepArgument = makeStepArgument(pickleStep.argument)
  return supportCodeLibrary
    .getExpressionGenerator()
    .generateExpressions(pickleStep.text)
    .map((expression) => {
      const allArguments = expression.parameterInfos.map((parameterInfo) => {
        let result = parameterInfo.name + (parameterInfo.count === 1 ? "" : parameterInfo.count.toString())
        if (parameterInfo.type !== null) {
          const sanitizedType = PRIMITIVE_TYPES.has(parameterInfo.type)
            ? parameterInfo.type.toLowerCase()
            : parameterInfo.type
          result += `: ${sanitizedType}`
        }
        return result
      })
      if (stepArgument !== "") {
        allArguments.push(stepArgument)
      }
      return {
        language: "typescript",
        code: `${method}(${JSON.stringify(expression.source)}, (${allArguments.join(", ")}) => {
  return "pending"
})`,
      }
    })
}

const makeStepArgument = (pickleStepArgument: PickleStepArgument | undefined) => {
  if (pickleStepArgument?.dataTable !== undefined) {
    return "dataTable: DataTable"
  }
  if (pickleStepArgument?.docString !== undefined) {
    return "docString: string"
  }
  return ""
}
