// @effect-diagnostics nodeBuiltinImport:off
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as NodePath from "node:path";
import {
  acpClientReadDisposition,
  acpClientWriteDisposition,
  type AcpClientPolicyContext,
} from "./clientPolicy.ts";

/**
 * Client-side handlers for the ACP `fs` capability (`fs/read_text_file`,
 * `fs/write_text_file`). They run with the server's privileges, so the flavor
 * wrapper below checks runtime policy and approvals before any access.
 */

export function makeAcpClientFileSystem(fileSystem: FileSystem.FileSystem) {
  const authorize = (path: string, write: boolean, context: AcpClientPolicyContext) => {
    const disposition = write
      ? acpClientWriteDisposition(context.policy, path)
      : acpClientReadDisposition(context.policy, path);
    const grant = { path, cwd: context.policy.cwd, turnKey: context.turnKey };
    if (
      disposition === "allow" ||
      (disposition === "ask" &&
        (write ? context.grants.allowsWrite(grant) : context.grants.allowsRead(grant)))
    )
      return Effect.void;
    return Effect.fail(
      fsRequestError(
        disposition === "ask"
          ? "The active T3 runtime policy requires approval. Request permission with session/request_permission before retrying."
          : "The active T3 runtime policy does not allow this filesystem operation.",
      ),
    );
  };
  return {
    readTextFile: (
      request: EffectAcpSchema.ReadTextFileRequest,
      _cwd: string | null,
      context: AcpClientPolicyContext,
    ) =>
      authorize(request.path, false, context).pipe(
        Effect.andThen(acpReadTextFile(fileSystem, request)),
      ),
    writeTextFile: (
      request: EffectAcpSchema.WriteTextFileRequest,
      _cwd: string | null,
      context: AcpClientPolicyContext,
    ) =>
      authorize(request.path, true, context).pipe(
        Effect.andThen(acpWriteTextFile(fileSystem, request)),
      ),
  };
}

const fsRequestError = (message: string, cause?: unknown) =>
  EffectAcpErrors.AcpRequestError.internalError(
    message,
    undefined,
    cause === undefined ? {} : { cause },
  );

function assertAbsolutePath(path: string) {
  return NodePath.isAbsolute(path)
    ? Effect.void
    : Effect.fail(fsRequestError(`ACP fs requests require an absolute path, received '${path}'.`));
}

/** Handles `fs/read_text_file`, applying the optional 1-based line window. */
export const acpReadTextFile = Effect.fn("AcpClientFs.readTextFile")(function* (
  fileSystem: FileSystem.FileSystem,
  request: EffectAcpSchema.ReadTextFileRequest,
): Effect.fn.Return<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpRequestError> {
  yield* assertAbsolutePath(request.path);
  const content = yield* fileSystem
    .readFileString(request.path)
    .pipe(
      Effect.mapError((cause) =>
        fsRequestError(`Could not read text file '${request.path}'.`, cause),
      ),
    );
  const line = request.line ?? undefined;
  const limit = request.limit ?? undefined;
  if (line === undefined && limit === undefined) {
    return { content };
  }
  const lines = content.split(/\r?\n/u);
  const startIndex = Math.max(0, (line ?? 1) - 1);
  const selected =
    limit === undefined ? lines.slice(startIndex) : lines.slice(startIndex, startIndex + limit);
  return { content: selected.join("\n") };
});

/** Handles `fs/write_text_file`, creating parent directories when needed. */
export const acpWriteTextFile = Effect.fn("AcpClientFs.writeTextFile")(function* (
  fileSystem: FileSystem.FileSystem,
  request: EffectAcpSchema.WriteTextFileRequest,
): Effect.fn.Return<EffectAcpSchema.WriteTextFileResponse, EffectAcpErrors.AcpRequestError> {
  yield* assertAbsolutePath(request.path);
  yield* fileSystem.makeDirectory(NodePath.dirname(request.path), { recursive: true }).pipe(
    Effect.andThen(fileSystem.writeFileString(request.path, request.content)),
    Effect.mapError((cause) =>
      fsRequestError(`Could not write text file '${request.path}'.`, cause),
    ),
  );
  return {};
});
