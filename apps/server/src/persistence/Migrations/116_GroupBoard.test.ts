import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import GroupBoard from "./116_GroupBoard.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const updatedAt = "2026-11-18T10:00:00.000Z";

layer("116_GroupBoard", (it) => {
  it.effect("creates the board table with one topic per title on each lead's board", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 115 });
      const tables = sql`
        SELECT name FROM sqlite_master
        WHERE tbl_name = 'orchestration_v2_projection_board_topics'
        ORDER BY name
      `;
      assert.deepStrictEqual(yield* tables, []);

      yield* runMigrations({ toMigrationInclusive: 116 });
      assert.deepStrictEqual(
        (yield* tables).map((row) => row.name),
        [
          "orchestration_v2_projection_board_topics",
          "orchestration_v2_projection_board_topics_lead_idx",
          "orchestration_v2_projection_board_topics_title_idx",
          "sqlite_autoindex_orchestration_v2_projection_board_topics_1",
        ],
      );

      const insertTopic = (topicId: string, leadThreadId: string, titleKey: string) =>
        sql`
          INSERT INTO orchestration_v2_projection_board_topics (
            topic_id, lead_thread_id, title_key, order_key, updated_at, payload_json
          ) VALUES (${topicId}, ${leadThreadId}, ${titleKey}, ${updatedAt}, ${updatedAt}, '{}')
        `;
      yield* insertTopic("topic-1", "lead-1", "api shape");
      yield* insertTopic("topic-2", "lead-2", "api shape");
      yield* insertTopic("topic-3", "lead-1", "schema");
      assert.ok(Exit.isFailure(yield* Effect.exit(insertTopic("topic-4", "lead-1", "api shape"))));
    }),
  );
});

it.effect.each([
  { recordedId: 97, firstUpstream: "97_IssueTrackerBindings" },
  { recordedId: 103, firstUpstream: "103_IssueTrackerAdditionalScopes" },
])(
  "upgrades a fork database that recorded GroupBoard as migration $recordedId",
  ({ recordedId, firstUpstream }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: recordedId - 1 });
      yield* GroupBoard;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${recordedId}, 'GroupBoard')
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_board_topics (
          topic_id, lead_thread_id, title_key, order_key, updated_at, payload_json
        ) VALUES ('topic-1', 'lead-1', 'schema', ${updatedAt}, ${updatedAt}, '{}')
      `;

      const executed = (yield* runMigrations()).map(([id, name]) => `${id}_${name}`);
      assert.equal(executed[0], firstUpstream);
      assert.equal(executed.at(-1), "116_GroupBoard");
      assert.equal(executed.length, 116 - recordedId + 1);
      assert.deepStrictEqual(
        yield* sql`SELECT topic_id FROM orchestration_v2_projection_board_topics`,
        [{ topic_id: "topic-1" }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
