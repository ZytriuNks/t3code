import { expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { makeRawThreadShell } from "../../test-fixtures";
import { buildArchivedThreadGroups } from "./archivedThreadList";

it("filters before archive grouping, search, sort and selection without changing raw snapshots", () => {
  const root = ThreadId.make("root");
  const child = ThreadId.make("child");
  const environmentId = EnvironmentId.make("local");
  const projectId = ProjectId.make("project-test");
  const timestamp = DateTime.makeUnsafe("2026-10-26T00:00:00.000Z");
  const threads = [
    makeRawThreadShell({ id: root, title: "Root", archivedAt: timestamp }),
    makeRawThreadShell({
      id: ThreadId.make("fork"),
      title: "Fork",
      archivedAt: timestamp,
      lineage: { rootThreadId: root, parentThreadId: child, relationshipToParent: "fork" },
    }),
    ...[child, ThreadId.make("grandchild")].map((id) =>
      makeRawThreadShell({
        id,
        title: "Child only",
        archivedAt: timestamp,
        lineage: {
          rootThreadId: root,
          parentThreadId: id === child ? root : child,
          relationshipToParent: "subagent",
        },
      }),
    ),
  ];
  const snapshot = {
    schemaVersion: 2,
    snapshotSequence: 4,
    threads,
    projects: [
      {
        id: projectId,
        title: "Project",
        workspaceRoot: "/work",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  const input = {
    snapshots: [{ environmentId, snapshot }],
    environmentLabels: {},
    environmentId: null,
    searchQuery: "",
    sortOrder: "newest" as const,
  };
  expect(
    buildArchivedThreadGroups(input)
      .flatMap((group) => group.threads.map((thread) => thread.id))
      .sort(),
  ).toEqual(["fork", "root"]);
  expect(buildArchivedThreadGroups({ ...input, searchQuery: "Child only" })).toEqual([]);
  expect(
    buildArchivedThreadGroups({
      ...input,
      snapshots: [{ environmentId, snapshot: { ...snapshot, threads: threads.slice(2) } }],
    }),
  ).toEqual([]);
  expect(snapshot.threads).toHaveLength(4);
  const remote = EnvironmentId.make("remote");
  const remoteRoot = makeRawThreadShell({ id: child, archivedAt: timestamp });
  expect(
    buildArchivedThreadGroups({
      ...input,
      snapshots: [
        ...input.snapshots,
        { environmentId: remote, snapshot: { ...snapshot, threads: [remoteRoot] } },
      ],
    }).flatMap((group) => group.threads.map((thread) => [thread.environmentId, thread.id])),
  ).toContainEqual([remote, child]);
});
