// @effect-diagnostics nodeBuiltinImport:off - uses real Vitest discovery in an isolated fixture without running its tests.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

const root = NodePath.resolve(import.meta.dirname, "..");

it("routes current server and root tests while excluding nested Claude worktree copies", () => {
  const cwd = NodeFS.mkdtempSync(NodePath.join(import.meta.dirname, ".vitest-discovery-"));
  const write = (file: string, content: string) => {
    const path = NodePath.join(cwd, file);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, content);
  };
  try {
    write("package.json", JSON.stringify({ private: true, type: "module" }));
    const config = NodePath.join(cwd, "vite.config.ts");
    write("vite.config.ts", NodeFS.readFileSync(NodePath.join(root, "vite.config.ts"), "utf8"));
    const configUrl = NodeURL.pathToFileURL(config).href;
    for (const dir of [
      "apps/desktop",
      "apps/mobile",
      "apps/server",
      "apps/web",
      "packages/client-runtime",
    ]) {
      write(
        `${dir}/vite.config.mjs`,
        `
        import base from ${JSON.stringify(configUrl)};
        const { projects, ...test } = base.test;
        export default { test: { ...test, name: ${JSON.stringify(dir === "apps/server" ? "t3" : dir)} } };
      `,
      );
    }
    const files = [
      "apps/server/src/check-gates.test.ts",
      "packages/shared/src/check-gates.test.ts",
      "scripts/check-gates.test.ts",
    ];
    for (const file of files) {
      write(file, 'throw new Error("Discovery must not execute tests");');
      write(
        `.claude/worktrees/copy/${file}`,
        'throw new Error("Nested checkout must be excluded");',
      );
    }
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { createVitest } from "vite-plus/test/node";
      import * as path from "node:path";
      const ctx = await createVitest({ root: process.argv[1], config: process.argv[2], watch: false, cache: false });
      try {
        const files = ${JSON.stringify(files)};
        const specs = await ctx.globTestSpecifications(files);
        const nested = await ctx.globTestSpecifications(files.map(file => ".claude/worktrees/copy/" + file));
        console.log("DISCOVERY:" + JSON.stringify({
          files: specs.map(spec => [spec.project.name, path.relative(process.argv[1], spec.moduleId).replaceAll("\\\\", "/")]).sort(),
          nested: nested.map(spec => spec.moduleId),
        }));
      } finally {
        await ctx.close();
      }
    `,
        cwd,
        config,
      ],
      { cwd, encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const output = result.stdout.split("\n").find((line) => line.startsWith("DISCOVERY:"));
    expect(output, result.stdout).toBeDefined();
    expect(JSON.parse(output!.slice("DISCOVERY:".length))).toEqual({
      files: [
        ["root", "packages/shared/src/check-gates.test.ts"],
        ["root", "scripts/check-gates.test.ts"],
        ["t3", "apps/server/src/check-gates.test.ts"],
      ],
      nested: [],
    });
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});
