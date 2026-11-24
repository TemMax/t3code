import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

type MigrationRow = { readonly id: number; readonly name: string };

// Earlier fork builds recorded GroupBoard as 97, then as 103: ids upstream took later. Dropping
// those rows lets upstream's migrations run; GroupBoard is idempotent and reruns as 116.
const isForkGroupBoardRow = (row: MigrationRow) =>
  (row.id === 97 || row.id === 103) && row.name === "GroupBoard";

export function reconciledForkGroupBoardHistory(
  history: ReadonlyArray<MigrationRow>,
): ReadonlyArray<MigrationRow> {
  return history.filter((row) => !isForkGroupBoardRow(row));
}

export const reconcileForkGroupBoardMigration = Effect.fn("reconcileForkGroupBoardMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    if (tables.length === 0) return;
    yield* sql`
      DELETE FROM effect_sql_migrations WHERE migration_id IN (97, 103) AND name = 'GroupBoard'
    `;
  },
);
