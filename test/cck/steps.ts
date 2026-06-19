import { DataTable } from "@cucumber/core"
import { Effect, FileSystem } from "effect"
import { strict as assert } from "node:assert"
import { attach, defineSupport, getWorld, link, log, setWorld } from "../../src/index.ts"

class Flight {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {}
}

const kitRoot = "node_modules/@cucumber/compatibility-kit/features"

const kitFile = (sample: string, file: string) => `${kitRoot}/${sample}/${file}`

export const cckStepsFor = (sample: string) => {
  switch (sample) {
    case "all-statuses":
      return defineSupport(({ Given }) => {
        Given(/^a step$/, () => undefined)
        Given(/^a failing step$/, () => {
          throw new Error("whoops")
        })
        Given(/^a pending step$/, () => "pending")
        Given(/^a skipped step$/, () => "skipped")
        Given(/^an ambiguous (.*?)$/, () => undefined)
        Given(/^(.*?) ambiguous step$/, () => undefined)
      })
    case "attachments":
      return defineSupport(({ When }) => {
        When("the string {string} is attached as {string}", (text, mediaType) =>
          attach(String(text), String(mediaType)))
        When("the string {string} is logged", (text) => log(String(text)))
        When("text with ANSI escapes is logged", () =>
          log("This displays a \x1b[31mr\x1b[0m\x1b[91ma\x1b[0m\x1b[33mi\x1b[0m\x1b[32mn\x1b[0m\x1b[34mb\x1b[0m\x1b[95mo\x1b[0m\x1b[35mw\x1b[0m"))
        When("the following string is attached as {string}:", (mediaType, text) =>
          attach(String(text), String(mediaType)))
        When("an array with {int} bytes is attached as {string}", (size, mediaType) =>
          attach(Buffer.from([...Array(Number(size)).keys()]), String(mediaType)))
        When("a PDF document is attached and renamed", () =>
          attachFixture("attachments", "document.pdf", "application/pdf", { fileName: "renamed.pdf" }))
        When("a link to {string} is attached", (uri) => link(String(uri)))
        When("the string {string} is attached as {string} before a failure", (text, mediaType) =>
          attach(String(text), String(mediaType)).pipe(Effect.andThen(Effect.die(new Error("whoops")))))
      })
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
    case "data-tables":
      return defineSupport(({ When, Then }) => {
        When("the following table is transposed:", (table) =>
          setWorld("transposed", (table as DataTable).transpose().raw()))
        Then("it should be:", (expected) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(yield* getWorld("transposed"), (expected as DataTable).raw())
          }))
      })
    case "doc-strings":
      return defineSupport(({ Given }) => {
        Given("a doc string:", () => undefined)
      })
    case "empty":
      return defineSupport(() => undefined)
    case "examples-tables":
      return defineSupport(({ Given, When, Then }) => {
        Given("there are {int} cucumbers", (initialCount) => setWorld("count", Number(initialCount)))
        Given("there are {int} friends", (initialFriends) => setWorld("friends", Number(initialFriends)))
        When("I eat {int} cucumbers", (eatCount) =>
          Effect.gen(function* () {
            const count = yield* getWorld<number>("count")
            yield* setWorld("count", (count ?? 0) - Number(eatCount))
          }))
        Then("I should have {int} cucumbers", (expectedCount) =>
          Effect.gen(function* () {
            const count = yield* getWorld<number>("count")
            assert.strictEqual(count, Number(expectedCount))
          }))
        Then("each person can eat {int} cucumbers", (expectedShare) =>
          Effect.gen(function* () {
            const count = yield* getWorld<number>("count")
            const friends = yield* getWorld<number>("friends")
            assert.strictEqual(Math.floor((count ?? 0) / (1 + (friends ?? 0))), Number(expectedShare))
          }))
      })
    case "examples-tables-attachment":
      return defineSupport(({ When }) => {
        When("a JPEG image is attached", () =>
          attachFixture("examples-tables-attachment", "cucumber.jpeg", "image/jpeg"))
        When("a PNG image is attached", () =>
          attachFixture("examples-tables-attachment", "cucumber.png", "image/png"))
      })
    case "examples-tables-undefined":
      return defineSupport(({ Given, When, Then }) => {
        Given("there are {int} cucumbers", (initialCount) => setWorld("count", Number(initialCount)))
        When("I eat {int} cucumbers", (eatCount) =>
          Effect.gen(function* () {
            const count = yield* getWorld<number>("count")
            yield* setWorld("count", (count ?? 0) - Number(eatCount))
          }))
        Then("I should have {int} cucumbers", (expectedCount) =>
          Effect.gen(function* () {
            const count = yield* getWorld<number>("count")
            assert.strictEqual(count, Number(expectedCount))
          }))
      })
    case "failedish-combinations":
      return defineSupport(({ Given }) => {
        Given(/^a step$/, () => undefined)
        Given(/^a skipped step$/, () => "skipped")
        Given(/^a pending step$/, () => "pending")
        Given(/^an ambiguous (.*?)$/, () => undefined)
        Given(/^(.*?) ambiguous step$/, () => undefined)
        Given(/^a failing step$/, () => {
          throw new Error("whoops")
        })
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
    case "rules":
      return defineSupport(({ Given, When, Then }) => {
        Given("the customer has {int} cents", (money) => setWorld("money", Number(money)))
        Given("there are chocolate bars in stock", () => setWorld("stock", ["Mars"]))
        Given("there are no chocolate bars in stock", () => setWorld("stock", []))
        When("the customer tries to buy a {int} cent chocolate bar", (price) =>
          Effect.gen(function* () {
            const money = yield* getWorld<number>("money")
            const stock = [...((yield* getWorld<Array<string>>("stock")) ?? [])]
            if ((money ?? 0) >= Number(price)) {
              yield* setWorld("chocolate", stock.pop())
              yield* setWorld("stock", stock)
            }
          }))
        Then("the sale should not happen", () =>
          Effect.gen(function* () {
            assert.strictEqual(yield* getWorld("chocolate"), undefined)
          }))
        Then("the sale should happen", () =>
          Effect.gen(function* () {
            assert.ok(yield* getWorld("chocolate"))
          }))
      })
    case "undefined":
      return defineSupport(({ Given }) => {
        Given("an implemented step", () => undefined)
        Given("a step that will be skipped", () => undefined)
      })
    case "unknown-parameter-type":
      return defineSupport(({ Given }) => {
        Given("{airport} is closed because of a strike", () => {
          throw new Error("Should not be called because airport parameter type has not been defined")
        })
      })
    default:
      return defineSupport(() => undefined)
  }
}

const attachFixture = (
  sample: string,
  file: string,
  mediaType: string,
  options?: { readonly fileName?: string },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const body = yield* fs.readFile(kitFile(sample, file)).pipe(Effect.orDie)
    yield* attach(body, mediaType, options)
  })
