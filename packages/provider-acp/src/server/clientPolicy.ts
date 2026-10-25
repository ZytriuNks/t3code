// @effect-diagnostics nodeBuiltinImport:off
import type { ProviderRequestKind, RuntimeMode } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Runtime-policy decisions for ACP work that T3 mediates.
 *
 * ACP agents run their own tools under their own permission model and ask
 * through `session/request_permission`, which T3 answers by policy. Client
 * filesystem and terminal operations run with the server's privileges, so
 * their boundaries also enforce the current policy and recorded approvals.
 */

/** Structural subset of the adapter runtime policy that decisions read. */
export interface AcpRuntimePolicy {
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string | null;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
}

export type AcpPermissionDisposition = "allow" | "ask" | "deny";

export function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveAcpPermissionPath(path: string, cwd: string | null): string | undefined {
  const trimmed = path.trim();
  if (trimmed.length === 0) return undefined;
  if (NodePath.isAbsolute(trimmed)) return trimmed;
  if (cwd === null || cwd.trim().length === 0) return undefined;
  return `${cwd}${cwd.endsWith(NodePath.sep) ? "" : NodePath.sep}${trimmed}`;
}

function acpPathIsWithinRoot(path: string, root: string): boolean {
  const relative = NodePath.relative(root, path);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

/**
 * `realpath` cannot resolve a file that has not been created yet, so walk up to the deepest
 * existing ancestor and append the missing suffix to that ancestor's canonical path. If an
 * existing entry cannot be canonicalized (for example, a broken symlink), fail closed.
 */
function acpCanonicalPathForContainment(path: string): string | undefined {
  // Do not lexically normalize before realpath. For a path such as
  // `workspace/link/../file`, the kernel resolves `link` before `..`; an
  // eager NodePath.resolve would erase that symlink traversal and could turn
  // an outside target into an apparently in-workspace path.
  let candidate = path;
  const missingSuffix: Array<string> = [];

  while (true) {
    try {
      return NodePath.resolve(NodeFS.realpathSync.native(candidate), ...missingSuffix);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        return undefined;
      }
    }

    try {
      NodeFS.lstatSync(candidate);
      return undefined;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        return undefined;
      }
    }

    const parent = NodePath.dirname(candidate);
    if (parent === candidate) return undefined;
    missingSuffix.unshift(NodePath.basename(candidate));
    candidate = parent;
  }
}

interface AcpPolicyOperation {
  readonly kind: string | null | undefined;
  readonly locations: ReadonlyArray<{ readonly path: string }> | null | undefined;
}

function acpPolicyRequiresApproval(runtimePolicy: AcpRuntimePolicy): boolean {
  return runtimePolicy.approvalPolicy === undefined
    ? runtimePolicy.runtimeMode === "approval-required"
    : runtimePolicy.approvalPolicy !== "never";
}

function isAcpReadKind(toolKind: string): boolean {
  return toolKind === "read" || toolKind === "search" || toolKind === "think";
}

/**
 * Reads follow the sandbox alone and never ask. That includes no explicit sandbox, since the
 * strictest runtime mode (approval-required) implies a read-only one.
 */
function acpReadDisposition(runtimePolicy: AcpRuntimePolicy): "allow" | "deny" {
  switch (unknownRecord(runtimePolicy.sandboxPolicy)?.type) {
    case undefined:
    case "readOnly":
    case "workspaceWrite":
    case "dangerFullAccess":
    case "externalSandbox":
      return "allow";
    default:
      return "deny";
  }
}

function acpWorkspaceWriteAllowsMutation(
  runtimePolicy: AcpRuntimePolicy,
  sandboxPolicy: Record<string, unknown>,
  locations: AcpPolicyOperation["locations"],
): boolean {
  const cwd =
    typeof runtimePolicy.cwd === "string" && runtimePolicy.cwd.trim().length > 0
      ? (resolveAcpPermissionPath(runtimePolicy.cwd, process.cwd()) ?? null)
      : null;
  const roots: Array<string> = [];
  if (cwd !== null) {
    const canonicalCwd = acpCanonicalPathForContainment(cwd);
    if (canonicalCwd !== undefined) roots.push(canonicalCwd);
  }
  const writableRoots = sandboxPolicy.writableRoots;
  if (Array.isArray(writableRoots)) {
    for (const writableRoot of writableRoots) {
      if (typeof writableRoot !== "string") continue;
      const resolved = resolveAcpPermissionPath(writableRoot, cwd);
      if (resolved === undefined) continue;
      const canonicalRoot = acpCanonicalPathForContainment(resolved);
      if (canonicalRoot !== undefined) roots.push(canonicalRoot);
    }
  }
  if (roots.length === 0) return false;

  if (locations === undefined || locations === null || locations.length === 0) {
    return false;
  }
  for (const location of locations) {
    const resolved = resolveAcpPermissionPath(location.path, cwd);
    const canonicalPath =
      resolved === undefined ? undefined : acpCanonicalPathForContainment(resolved);
    if (
      canonicalPath === undefined ||
      !roots.some((root) => acpPathIsWithinRoot(canonicalPath, root))
    ) {
      return false;
    }
  }
  return true;
}

function acpOperationDisposition(
  runtimePolicy: AcpRuntimePolicy,
  operation: AcpPolicyOperation,
): AcpPermissionDisposition {
  const toolKind = operation.kind ?? "other";
  if (isAcpReadKind(toolKind)) {
    return acpReadDisposition(runtimePolicy);
  }
  if (acpPolicyRequiresApproval(runtimePolicy)) {
    return "ask";
  }

  const sandboxPolicy = unknownRecord(runtimePolicy.sandboxPolicy);
  switch (sandboxPolicy?.type) {
    case "readOnly":
      return "deny";
    case "workspaceWrite":
      if (isAcpMutationKind(toolKind)) {
        return acpWorkspaceWriteAllowsMutation(
          runtimePolicy,
          sandboxPolicy ?? {},
          operation.locations,
        )
          ? "allow"
          : "deny";
      }
      return "deny";
    case "dangerFullAccess":
    case "externalSandbox":
      return "allow";
    case undefined:
      if (runtimePolicy.runtimeMode === "approval-required") return "deny";
      if (
        runtimePolicy.runtimeMode === "auto-accept-edits" &&
        runtimePolicy.approvalPolicy === undefined &&
        !isAcpMutationKind(toolKind)
      ) {
        return "ask";
      }
      return "allow";
    default:
      return "deny";
  }
}

function isAcpMutationKind(toolKind: string): boolean {
  return toolKind === "edit" || toolKind === "delete" || toolKind === "move";
}

export function acpPermissionDisposition(
  runtimePolicy: AcpRuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  return acpOperationDisposition(runtimePolicy, {
    kind: request.toolCall.kind,
    locations: request.toolCall.locations,
  });
}

export function acpMcpToolApprovalElicitationDisposition(
  runtimePolicy: AcpRuntimePolicy,
  request: EffectAcpSchema.CreateElicitationRequest,
  nativeRequestId?: string,
): AcpPermissionDisposition | undefined {
  if (
    request.mode !== "form" ||
    (unknownRecord(request._meta)?.codex_approval_kind !== "mcp_tool_call" &&
      nativeRequestId?.startsWith("mcp_tool_call_approval_") !== true)
  ) {
    return undefined;
  }
  // This request comes from T3's authenticated, scope-checked MCP endpoint,
  // not an arbitrary provider command. Let explicit approval mode surface it
  // to the user and otherwise allow the endpoint to enforce its own policy.
  return acpPolicyRequiresApproval(runtimePolicy) ? "ask" : "allow";
}

/** Client-mediated reads require an approved request in explicit approval mode. */
export function acpClientReadDisposition(
  runtimePolicy: AcpRuntimePolicy,
  path: string,
): AcpPermissionDisposition {
  return acpPolicyRequiresApproval(runtimePolicy)
    ? "ask"
    : acpOperationDisposition(runtimePolicy, { kind: "read", locations: [{ path }] });
}

export function acpClientWriteDisposition(
  runtimePolicy: AcpRuntimePolicy,
  path: string,
): AcpPermissionDisposition {
  return acpOperationDisposition(runtimePolicy, { kind: "edit", locations: [{ path }] });
}

/** Disposition of a client-mediated `terminal/create` (Devin's client terminals). */
export function acpClientExecuteDisposition(
  runtimePolicy: AcpRuntimePolicy,
): AcpPermissionDisposition {
  return acpOperationDisposition(runtimePolicy, { kind: "execute", locations: undefined });
}

export interface AcpApprovalGrantInput {
  readonly kind: ProviderRequestKind;
  readonly locations?: ReadonlyArray<string>;
  readonly cwd?: string | null;
  readonly scope: "session" | "turn";
  readonly turnKey: string;
}

interface AcpPathGrantInput {
  readonly path: string;
  readonly cwd: string | null;
  readonly turnKey: string | null;
}

export interface AcpClientPolicyGrants {
  readonly recordApproval: (input: AcpApprovalGrantInput) => void;
  readonly allowsRead: (input: AcpPathGrantInput) => boolean;
  readonly allowsWrite: (input: AcpPathGrantInput) => boolean;
  readonly allowsExecute: (turnKey: string | null) => boolean;
}

export interface AcpClientPolicyContext {
  readonly policy: AcpRuntimePolicy;
  readonly turnKey: string | null;
  readonly grants: AcpClientPolicyGrants;
}

/** ACP has no operation linkage, so grants are limited to canonical paths and the approving scope. */
export function makeAcpClientPolicyGrants(): AcpClientPolicyGrants {
  interface ScopeGrants {
    execute: boolean;
    unscopedRead: boolean;
    unscopedWrite: boolean;
    readRoots: string[];
    writeRoots: string[];
  }
  const emptyScope = (): ScopeGrants => ({
    execute: false,
    unscopedRead: false,
    unscopedWrite: false,
    readRoots: [],
    writeRoots: [],
  });
  const session = emptyScope();
  let turn: { readonly key: string; readonly grants: ScopeGrants } | null = null;
  const scopeFor = (input: AcpApprovalGrantInput): ScopeGrants => {
    if (input.scope === "session") return session;
    if (turn === null || turn.key !== input.turnKey)
      turn = { key: input.turnKey, grants: emptyScope() };
    return turn.grants;
  };
  const activeScopes = (turnKey: string | null) =>
    turn !== null && turnKey !== null && turn.key === turnKey ? [session, turn.grants] : [session];
  const recordPaths = (roots: string[], input: AcpApprovalGrantInput) => {
    for (const location of input.locations ?? []) {
      const resolved = resolveAcpPermissionPath(location, input.cwd ?? null);
      const canonical =
        resolved === undefined ? undefined : acpCanonicalPathForContainment(resolved);
      if (canonical === undefined) continue;
      roots.push(canonical);
      if (roots.length > 128) roots.shift();
    }
  };
  const allowsPath = (input: AcpPathGrantInput, mode: "Read" | "Write") => {
    const scopes = activeScopes(input.turnKey);
    if (scopes.some((scope) => scope[mode === "Read" ? "unscopedRead" : "unscopedWrite"]))
      return true;
    const resolved = resolveAcpPermissionPath(input.path, input.cwd);
    const canonical = resolved === undefined ? undefined : acpCanonicalPathForContainment(resolved);
    return (
      canonical !== undefined &&
      scopes.some((scope) =>
        scope[mode === "Read" ? "readRoots" : "writeRoots"].some((root) =>
          acpPathIsWithinRoot(canonical, root),
        ),
      )
    );
  };
  return {
    recordApproval: (input) => {
      const grants = scopeFor(input);
      if (input.kind === "command") {
        grants.execute = true;
        return;
      }
      if (input.kind !== "file-read" && input.kind !== "file-change") return;
      const read = input.kind === "file-read";
      if ((input.locations ?? []).length === 0) {
        grants[read ? "unscopedRead" : "unscopedWrite"] = true;
        return;
      }
      recordPaths(grants[read ? "readRoots" : "writeRoots"], input);
    },
    allowsRead: (input) => allowsPath(input, "Read"),
    allowsWrite: (input) => allowsPath(input, "Write"),
    allowsExecute: (turnKey) => activeScopes(turnKey).some((scope) => scope.execute),
  };
}
