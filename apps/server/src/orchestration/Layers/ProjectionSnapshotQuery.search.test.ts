import { ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProjectEnrichment from "../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const metadataLayer = Layer.merge(
  Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: () => Effect.succeed(null),
  }),
  Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
    resolvePath: () => Effect.succeed(null),
  }),
);

const TestLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provideMerge(ThreadPlanProgress.layer),
  Layer.provideMerge(ProjectEnrichment.layer),
  Layer.provideMerge(metadataLayer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "projection-search-test-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("search uses v2 visibility while legacy transcripts are still lazy", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = yield* ProjectionSnapshotQuery;
    const now = "2026-08-29T00:00:00.000Z";
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json,
        scripts_json, created_at, updated_at, deleted_at
      ) VALUES (
        'project:search', 'Search', '/tmp/search', NULL,
        '[]', ${now}, ${now}, NULL
      )
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, branch, worktree_path, latest_turn_id, created_at,
        updated_at, archived_at, settled_override, settled_at, deleted_at
      ) VALUES
        ('thread:active', 'project:search', 'Active', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', NULL, NULL, NULL, ${now}, ${now}, NULL, NULL, NULL, NULL),
        ('thread:archived', 'project:search', 'Archived', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', NULL, NULL, NULL, ${now}, ${now}, NULL, NULL, NULL, NULL),
        ('thread:deleted', 'project:search', 'Deleted', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', NULL, NULL, NULL, ${now}, ${now}, NULL, NULL, NULL, NULL),
        ('thread:assistant', 'project:search', 'Assistant', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', NULL, NULL, 'turn:assistant', ${now}, ${now}, NULL, NULL, NULL, NULL)
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, attachments_json,
        is_streaming, created_at, updated_at
      ) VALUES
        ('message:active', 'thread:active', NULL, 'user', 'migration needle active', '[]', 0, ${now}, ${now}),
        ('message:archived', 'thread:archived', NULL, 'user', 'migration needle archived', '[]', 0, ${now}, ${now}),
        ('message:deleted', 'thread:deleted', NULL, 'user', 'migration needle deleted', '[]', 0, ${now}, ${now}),
        ('message:orphan-assistant', 'thread:assistant', NULL, 'assistant', 'migration needle orphan', '[]', 0, ${now}, ${now}),
        ('message:assistant', 'thread:assistant', 'turn:assistant', 'assistant', 'migration needle answer', '[]', 0, ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO projection_turns (
        turn_id, thread_id, state, requested_at, started_at, completed_at,
        assistant_message_id, checkpoint_files_json,
        source_proposed_plan_thread_id, source_proposed_plan_id
      ) VALUES (
        'turn:assistant', 'thread:assistant', 'completed', ${now}, ${now}, ${now},
        'message:assistant', '[]', NULL, NULL
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, provider_instance_id,
        runtime_mode, interaction_mode, active_provider_thread_id, created_at,
        updated_at, archived_at, deleted_at, payload_json
      ) VALUES
        ('thread:active', 'project:search', 'Active', 'codex', 'codex', 'full-access', 'default', NULL, ${now}, ${now}, NULL, NULL, '{}'),
        ('thread:archived', 'project:search', 'Archived', 'codex', 'codex', 'full-access', 'default', NULL, ${now}, ${now}, ${now}, NULL, '{}'),
        ('thread:deleted', 'project:search', 'Deleted', 'codex', 'codex', 'full-access', 'default', NULL, ${now}, ${now}, NULL, ${now}, '{}')
    `;

    const result = yield* query.searchThreads({ query: "migration needle", limit: 20 });
    assert.deepEqual(
      result.matches.map((match) => [match.threadId, match.source, match.snippet]),
      [
        ["thread:active", "user", "migration needle active"],
        ["thread:assistant", "assistant", "migration needle answer"],
      ],
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("reads active and archived pull request links from shell snapshots", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = yield* ProjectionSnapshotQuery;
    const now = "2026-09-01T00:00:00.000Z";
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project:pr', 'PR project', '/tmp/pr', '[]', ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at, archived_at
      ) VALUES
        ('thread:active', 'project:pr', 'Active', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', ${now}, ${now}, NULL),
        ('thread:archived', 'project:pr', 'Archived', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', ${now}, ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO projection_thread_pull_requests (thread_id, host, repository, number, url, source, linked_at)
      VALUES
        ('thread:active', 'github.com', 'acme/pr', 1, 'https://github.com/acme/pr/pull/1', 'manual', ${now}),
        ('thread:active', 'github.com', 'acme/pr', 2, 'https://github.com/acme/pr/pull/2', 'manual', ${now}),
        ('thread:archived', 'github.com', 'acme/pr', 3, 'https://github.com/acme/pr/pull/3', 'manual', ${now})
    `;
    yield* sql`
      UPDATE projection_threads
      SET linked_pull_request_json = '{"projectId":"project:pr","repository":"acme/pr","number":2,"url":"https://github.com/acme/pr/pull/2"}'
      WHERE thread_id = 'thread:active'
    `;

    const active = yield* query.getShellSnapshot();
    const archived = yield* query.getArchivedShellSnapshot();
    const linked = yield* query.listThreadsWithPullRequests();
    const full = yield* query.getSnapshot();
    const command = yield* query.getCommandReadModel();
    const individual = Option.getOrThrow(
      yield* query.getThreadShellById(ThreadId.make("thread:active")),
    );
    const detail = Option.getOrThrow(
      yield* query.getThreadDetailById(ThreadId.make("thread:active")),
    );
    assert.deepEqual(
      active.threads.map((thread) => thread.pullRequests.map((pr) => pr.number)),
      [[1, 2]],
    );
    assert.deepEqual(
      archived.threads.map((thread) => thread.pullRequests.map((pr) => pr.number)),
      [[3]],
    );
    assert.deepEqual(
      linked.map((thread) => thread.pullRequests.map((pr) => pr.number)),
      [[1, 2]],
    );
    assert.deepEqual(
      full.threads.map((thread) => thread.pullRequests.map((pr) => pr.number)),
      [[1, 2], [3]],
    );
    assert.deepEqual(
      command.threads.map((thread) => thread.pullRequests.map((pr) => pr.number)),
      [[1, 2], [3]],
    );
    assert.equal(active.threads[0]?.linkedPullRequest?.number, 2);
    assert.equal(command.threads[0]?.linkedPullRequest?.number, 2);
    assert.deepEqual(
      individual.pullRequests.map((pr) => pr.number),
      [1, 2],
    );
    assert.deepEqual(
      detail.pullRequests.map((pr) => pr.number),
      [1, 2],
    );

    yield* sql`DELETE FROM projection_thread_pull_requests WHERE thread_id = 'thread:active'`;
    const unlinked = yield* query.getShellSnapshot();
    const unlinkedCommand = yield* query.getCommandReadModel();
    const unlinkedIndividual = Option.getOrThrow(
      yield* query.getThreadShellById(ThreadId.make("thread:active")),
    );
    const unlinkedDetail = Option.getOrThrow(
      yield* query.getThreadDetailById(ThreadId.make("thread:active")),
    );
    assert.equal(unlinked.threads[0]?.linkedPullRequest ?? null, null);
    assert.deepEqual(unlinked.threads[0]?.pullRequests, []);
    assert.equal(unlinkedCommand.threads[0]?.linkedPullRequest ?? null, null);
    assert.equal(unlinkedIndividual.linkedPullRequest ?? null, null);
    assert.equal(unlinkedDetail.linkedPullRequest ?? null, null);
  }).pipe(Effect.provide(TestLayer)),
);
