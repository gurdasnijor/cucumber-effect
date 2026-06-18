#!/usr/bin/env -S node --disable-warning=ExperimentalWarning --experimental-transform-types

import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { cliEffect } from "../cli.ts"

NodeRuntime.runMain(cliEffect.pipe(Effect.provide(NodeServices.layer)))
