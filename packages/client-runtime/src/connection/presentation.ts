import type { ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { ConnectionTarget, SupervisorConnectionState } from "./model.ts";
import { connectionRouteId, connectionRoutes, routeHttpBaseUrl } from "./routes.ts";

export type EnvironmentConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error"
  | "unsupported";

export interface EnvironmentConnectionPresentation {
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
  readonly traceId: string | null;
}

/**
 * Provider statuses are pushed every few minutes with fresh `checkedAt` stamps, and every root
 * coordinator reads environment presentations. Leaving them out keeps a presentation stable
 * across those pushes; provider readers subscribe to the server's providers atom instead.
 */
export type EnvironmentServerConfig = Omit<ServerConfig, "providers">;

export interface EnvironmentPresentation {
  readonly entry: ConnectionCatalogEntry;
  readonly connection: EnvironmentConnectionPresentation;
  readonly serverConfig: EnvironmentServerConfig | null;
}

export function presentConnectionState(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  switch (state.phase) {
    case "available":
      return { phase: "available", error: null, traceId: null };
    case "offline":
      return { phase: "offline", error: null, traceId: null };
    case "connecting":
      return {
        phase: state.attempt <= 1 && state.lastFailure === null ? "connecting" : "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "connected":
      return { phase: "connected", error: null, traceId: null };
    case "backoff":
      return {
        phase: "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "blocked":
      return {
        phase: state.lastFailure?.reason === "unsupported" ? "unsupported" : "error",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
  }
}

export interface ConnectionStatusCopy {
  readonly available: string;
  readonly offline: string;
  readonly connecting: string;
  readonly reconnecting: string;
  readonly reconnectingWithReason: (reason: string) => string;
  readonly connected: string;
  readonly connectionFailed: string;
  readonly connectionFailedWithReason: (reason: string) => string;
  readonly reconnectingTitle: string;
}

export const DEFAULT_CONNECTION_STATUS_COPY: ConnectionStatusCopy = {
  available: "Available",
  offline: "Offline",
  connecting: "Connecting...",
  reconnecting: "Reconnecting...",
  reconnectingWithReason: (reason) => `Failed to connect. Reconnecting... Reason: ${reason}`,
  connected: "Connected",
  connectionFailed: "Connection failed",
  connectionFailedWithReason: (reason) => `Connection failed. Reason: ${reason}`,
  reconnectingTitle: "Failed to connect. Reconnecting...",
};

export function connectionStatusText(
  connection: EnvironmentConnectionPresentation,
  copy: ConnectionStatusCopy = DEFAULT_CONNECTION_STATUS_COPY,
): string {
  switch (connection.phase) {
    case "available":
      return copy.available;
    case "offline":
      return copy.offline;
    case "connecting":
      return copy.connecting;
    case "reconnecting":
      return connection.error ? copy.reconnectingWithReason(connection.error) : copy.reconnecting;
    case "connected":
      return copy.connected;
    case "unsupported":
      return "Client not supported";
    case "error":
      return connection.error
        ? copy.connectionFailedWithReason(connection.error)
        : copy.connectionFailed;
  }
}

export function connectionStatusTitle(
  connection: EnvironmentConnectionPresentation,
  copy: ConnectionStatusCopy = DEFAULT_CONNECTION_STATUS_COPY,
): string {
  if (connection.phase === "reconnecting" && connection.error) {
    return copy.reconnectingTitle;
  }
  return connectionStatusText({ ...connection, error: null }, copy);
}

export function presentEnvironmentConnection(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  return presentConnectionState(state);
}

/**
 * SSH connections ride a local forward that disappears with the client, so they have no stable
 * address.
 */
export function environmentMcpUrl(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly relayHttpBaseUrl?: string | undefined;
  readonly connectedTarget?: ConnectionTarget | null | undefined;
}): string | null {
  const connectedRouteId = input.connectedTarget ? connectionRouteId(input.connectedTarget) : null;
  const routes = connectionRoutes(input.entry);
  const connectedRoute = routes.find(
    (route) => connectionRouteId(route.target) === connectedRouteId,
  );
  for (const route of connectedRoute ? [connectedRoute, ...routes] : routes) {
    const httpBaseUrl =
      route.target._tag === "RelayConnectionTarget"
        ? (input.relayHttpBaseUrl ?? null)
        : routeHttpBaseUrl(route);
    const mcpUrl = httpBaseUrl === null ? null : mcpUrlFromBase(httpBaseUrl);
    if (mcpUrl !== null) return mcpUrl;
  }
  return null;
}

function mcpUrlFromBase(httpBaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(httpBaseUrl);
  } catch {
    return null;
  }
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function connectionCatalogDisplayUrl(entry: ConnectionCatalogEntry): string | null {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return entry.target.httpBaseUrl;
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile"
        ? entry.profile.value.httpBaseUrl
        : null;
    case "SshConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "SshConnectionProfile"
        ? `${entry.profile.value.target.username}@${entry.profile.value.target.hostname}`
        : null;
  }
}
