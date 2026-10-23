const fs = require("node:fs");
const path = require("node:path");

const [manager, ...args] = process.argv.slice(2);
const env = process.env;
const writeCommand = (directory, name) => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.cmd`), "@exit /b 0\r\n");
};

if (manager === "npm") {
  fs.appendFileSync(env.FAKE_NPM_LOG, `${args.join(" ")}\n`);
  const prefix = env.npm_config_prefix || env.FAKE_NPM_PREFIX;
  const root = path.join(prefix, "lib", "node_modules");
  if (args[0] === "root" && args[1] === "--global") console.log(root);
  else if (args[0] === "prefix" && args[1] === "--global") console.log(prefix);
  else if (args[0] === "install" && args[1] === "--global") {
    const packageRoot = path.join(root, "@example", "acp");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), env.FAKE_NPM_MANIFEST);
    writeCommand(prefix, "example-agent");
  } else process.exitCode = 64;
} else if (manager === "uv") {
  const bin = env.UV_TOOL_BIN_DIR || env.FAKE_UV_BIN;
  fs.appendFileSync(
    env.FAKE_UV_LOG,
    `${args.join(" ")}\ntool-dir=${env.UV_TOOL_DIR || ""} bin-dir=${env.UV_TOOL_BIN_DIR || ""}\n`,
  );
  if (args[0] === "tool" && args[1] === "dir" && args[2] === "--bin") console.log(bin);
  else if (args[0] === "tool" && args[1] === "list") {
    if (fs.existsSync(path.join(bin, "fast-agent.cmd")))
      console.log("fast-agent-acp v0.10.1\n- fast-agent");
  } else if (args[0] === "tool" && args[1] === "install" && args[2] === "--force")
    writeCommand(bin, "fast-agent");
  else process.exitCode = 64;
} else process.exitCode = 64;
