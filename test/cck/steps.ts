import { Effect } from "effect"
import { defineSupport } from "../../src/index.ts"

class Flight {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {}
}

export const cckStepsFor = (sample: string) => {
  switch (sample) {
    case "minimal":
      return defineSupport(({ Given }) => {
        Given("I have {int} cukes in my belly", () => undefined)
      })
    case "cdata":
      return defineSupport(({ Given }) => {
        Given("I have {int} <![CDATA[cukes]]> in my belly", () => undefined)
      })
    case "backgrounds":
    case "rules-backgrounds":
      return defineSupport(({ Given, When, Then }) => {
        Given("an order for {string}", () => undefined)
        When("an action", () => undefined)
        Then("an outcome", () => undefined)
      })
    case "doc-strings":
      return defineSupport(({ Given }) => {
        Given("a doc string:", () => undefined)
      })
    case "parameter-types":
      return defineSupport(({ Given, ParameterType }) => {
        ParameterType({
          name: "flight",
          regexp: /([A-Z]{3})-([A-Z]{3})/,
          transformer: (from, to) => new Flight(from, to),
        })
        Given("{flight} has been delayed", (flight) => {
          const value = flight as Flight
          if (value.from !== "LHR" || value.to !== "CDG") {
            return Effect.die("flight parameter did not transform")
          }
          return undefined
        })
      })
    case "pending":
      return defineSupport(({ Given }) => {
        Given("an implemented non-pending step", () => undefined)
        Given("an implemented step that is skipped", () => undefined)
        Given("an unimplemented pending step", () => "pending")
      })
    case "skipped":
      return defineSupport(({ Given }) => {
        Given("a step that does not skip", () => undefined)
        Given("a step that is skipped", () => undefined)
        Given("I skip a step", () => "skipped")
      })
    case "regular-expression":
      return defineSupport(({ Given }) => {
        Given(/^a (.*?)(?: and a (.*?))?(?: and a (.*?))?$/, () => undefined)
      })
    case "ambiguous":
      return defineSupport(({ Given }) => {
        Given(/^a (.*?) with (.*?)$/, () => undefined)
        Given(/^a step with (.*?)$/, () => undefined)
      })
    case "unused-steps":
      return defineSupport(({ Given }) => {
        Given("a step that is used", () => undefined)
        Given("a step that is not used", () => undefined)
      })
    default:
      return defineSupport(() => undefined)
  }
}
