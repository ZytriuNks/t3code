import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { hydratePosixHome, resolveBaseDir } from "./os-jank.ts";

it.effect("uses the Experimental default home for CLI runtime state", () =>
  Effect.gen(function* () {
    const baseDir = yield* resolveBaseDir(undefined);
    assert.equal(baseDir, NodePath.join(NodeOS.homedir(), ".t3-experimental"));
  }).pipe(Effect.provide(NodeServices.layer)),
);
it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});
