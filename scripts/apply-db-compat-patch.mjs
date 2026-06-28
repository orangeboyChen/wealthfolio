#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = process.cwd();

function filePath(relativePath) {
  return resolve(rootDir, relativePath);
}

function readText(relativePath) {
  return readFileSync(filePath(relativePath), "utf8");
}

function writeText(relativePath, content) {
  writeFileSync(filePath(relativePath), content);
}

function replaceOnce(content, from, to, label) {
  if (content.includes(to)) {
    return content;
  }

  const next = content.replace(from, to);
  if (next === content) {
    throw new Error(`Unable to update ${label}`);
  }

  return next;
}

function insertBefore(content, anchor, insert, label) {
  if (content.includes(insert)) {
    return content;
  }

  const index = content.indexOf(anchor);
  if (index === -1) {
    throw new Error(`Unable to find anchor for ${label}`);
  }

  return content.slice(0, index) + insert + content.slice(index);
}

function updateDatabaseModule() {
  let content = readText("crates/storage-sqlite/src/db/mod.rs");

  content = replaceOnce(
    content,
    `    let migration_result: Result<Vec<String>> = connection
        .run_pending_migrations(MIGRATIONS)
        .map(|versions| {
            versions
                .into_iter()
                .map(|version| version.to_string())
                .collect()
        })
        .map_err(|e| {
            error!("Database migration failed: {}", e);
            Error::Database(DatabaseError::MigrationFailed(e.to_string()))
        });
`,
    `    let migration_result: Result<Vec<String>> = match connection.run_pending_migrations(MIGRATIONS)
    {
        Ok(versions) => Ok(
            versions
                .into_iter()
                .map(|version| version.to_string())
                .collect(),
        ),
        Err(e) => {
            let message = e.to_string();
            if is_missing_allocation_targets_error(&message) {
                warn!(
                    "Detected missing allocation_targets schema; repairing legacy database and retrying migrations."
                );
                repair_allocation_targets_schema(db_path)?;

                connection
                    .run_pending_migrations(MIGRATIONS)
                    .map(|versions| {
                        versions
                            .into_iter()
                            .map(|version| version.to_string())
                            .collect()
                    })
                    .map_err(|retry_error| {
                        error!(
                            "Database migration failed after legacy schema repair: {}",
                            retry_error
                        );
                        Error::Database(DatabaseError::MigrationFailed(retry_error.to_string()))
                    })
            } else {
                error!("Database migration failed: {}", e);
                Err(Error::Database(DatabaseError::MigrationFailed(e.to_string())))
            }
        }
    };
`,
    "migration retry block",
  );

  content = insertBefore(
    content,
    "pub fn run_migrations(db_path: &str) -> Result<()> {\n",
    `fn sqlite_master_exists(
    conn: &RusqliteConnection,
    object_type: &str,
    name: &str,
) -> Result<bool> {
    let exists = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2)",
            [object_type, name],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| {
            error!("Failed to inspect database schema during migration repair: {}", e);
            Error::Database(DatabaseError::MigrationFailed(e.to_string()))
        })?;

    Ok(exists != 0)
}

fn repair_allocation_targets_schema(db_path: &str) -> Result<()> {
    let conn = RusqliteConnection::open(db_path).map_err(|e| {
        error!("Failed to open database for migration repair: {}", e);
        Error::Database(DatabaseError::MigrationFailed(e.to_string()))
    })?;

    conn.busy_timeout(Duration::from_secs(30)).map_err(|e| {
        error!("Failed to set busy timeout for migration repair: {}", e);
        Error::Database(DatabaseError::MigrationFailed(e.to_string()))
    })?;

    let mut repaired = false;

    if !sqlite_master_exists(&conn, "table", "allocation_targets")? {
        conn.execute_batch(
            r#"
            CREATE TABLE allocation_targets (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL CHECK (length(trim(name)) > 0),
                scope_type TEXT NOT NULL CHECK (scope_type IN ('all', 'portfolio', 'account')),
                scope_id TEXT,
                taxonomy_id TEXT NOT NULL DEFAULT 'asset_classes',

                trigger_type TEXT NOT NULL DEFAULT 'threshold' CHECK (trigger_type IN ('manual', 'threshold')),
                drift_band_bps INTEGER NOT NULL DEFAULT 500 CHECK (drift_band_bps >= 0 AND drift_band_bps <= 10000),
                rebalance_goal TEXT NOT NULL DEFAULT 'nearest_band'
                    CHECK (rebalance_goal IN ('nearest_band', 'exact_target')),
                min_trade_amount TEXT NOT NULL DEFAULT '0',
                whole_shares_only INTEGER NOT NULL DEFAULT 0,
                allow_sells INTEGER NOT NULL DEFAULT 0,

                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                archived_at TEXT,

                CHECK (
                    (scope_type = 'all' AND scope_id IS NULL) OR
                    (scope_type IN ('account', 'portfolio') AND scope_id IS NOT NULL)
                )
            );
            "#,
        )
        .map_err(|e| {
            error!(
                "Failed to recreate missing allocation_targets table during migration repair: {}",
                e
            );
            Error::Database(DatabaseError::MigrationFailed(e.to_string()))
        })?;
        repaired = true;
    }

    if !sqlite_master_exists(&conn, "index", "idx_allocation_targets_scope")? {
        conn.execute_batch(
            "CREATE INDEX idx_allocation_targets_scope ON allocation_targets(scope_type, scope_id, archived_at);",
        )
        .map_err(|e| {
            error!(
                "Failed to recreate missing allocation_targets index during migration repair: {}",
                e
            );
            Error::Database(DatabaseError::MigrationFailed(e.to_string()))
        })?;
        repaired = true;
    }

    if !sqlite_master_exists(&conn, "table", "allocation_target_weights")? {
        conn.execute_batch(
            r#"
            CREATE TABLE allocation_target_weights (
                id TEXT PRIMARY KEY NOT NULL,
                target_id TEXT NOT NULL,
                taxonomy_id TEXT NOT NULL,
                category_id TEXT NOT NULL,
                target_bps INTEGER NOT NULL CHECK (target_bps >= 0 AND target_bps <= 10000),
                is_locked INTEGER NOT NULL DEFAULT 0,
                is_required INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                FOREIGN KEY (target_id) REFERENCES allocation_targets(id) ON DELETE CASCADE,
                FOREIGN KEY (category_id, taxonomy_id) REFERENCES taxonomy_categories(id, taxonomy_id) ON DELETE RESTRICT,
                UNIQUE(target_id, taxonomy_id, category_id)
            );
            "#,
        )
        .map_err(|e| {
            error!(
                "Failed to recreate missing allocation_target_weights table during migration repair: {}",
                e
            );
            Error::Database(DatabaseError::MigrationFailed(e.to_string()))
        })?;
        repaired = true;
    }

    if !sqlite_master_exists(&conn, "index", "idx_allocation_target_weights_target")? {
        conn.execute_batch(
            "CREATE INDEX idx_allocation_target_weights_target ON allocation_target_weights(target_id);",
        )
        .map_err(|e| {
            error!(
                "Failed to recreate missing allocation_target_weights index during migration repair: {}",
                e
            );
            Error::Database(DatabaseError::MigrationFailed(e.to_string()))
        })?;
        repaired = true;
    }

    if !sqlite_master_exists(&conn, "trigger", "allocation_targets_taxonomy_update")? {
        conn.execute_batch(
            r#"
            CREATE TRIGGER allocation_targets_taxonomy_update
            BEFORE UPDATE OF taxonomy_id ON allocation_targets
            FOR EACH ROW
            WHEN OLD.taxonomy_id <> NEW.taxonomy_id
                AND EXISTS (
                    SELECT 1 FROM allocation_target_weights
                    WHERE target_id = OLD.id
                )
            BEGIN
                SELECT RAISE(ABORT, 'allocation_targets.taxonomy_id cannot change while weights exist');
            END;
            "#,
        )
        .map_err(|e| {
            error!(
                "Failed to recreate missing allocation_targets trigger during migration repair: {}",
                e
            );
            Error::Database(DatabaseError::MigrationFailed(e.to_string()))
        })?;
        repaired = true;
    }

    if !sqlite_master_exists(&conn, "trigger", "allocation_target_weights_taxonomy_insert")? {
        conn.execute_batch(
            r#"
            CREATE TRIGGER allocation_target_weights_taxonomy_insert
            BEFORE INSERT ON allocation_target_weights
            FOR EACH ROW
            WHEN (SELECT taxonomy_id FROM allocation_targets WHERE id = NEW.target_id) <> NEW.taxonomy_id
            BEGIN
                SELECT RAISE(ABORT, 'allocation_target_weights.taxonomy_id must match allocation_targets.taxonomy_id');
            END;
            "#,
        )
        .map_err(|e| {
            error!(
                "Failed to recreate missing allocation_target_weights insert trigger during migration repair: {}",
                e
            );
            Error::Database(DatabaseError::MigrationFailed(e.to_string()))
        })?;
        repaired = true;
    }

    if !sqlite_master_exists(&conn, "trigger", "allocation_target_weights_taxonomy_update")? {
        conn.execute_batch(
            r#"
            CREATE TRIGGER allocation_target_weights_taxonomy_update
            BEFORE UPDATE OF target_id, taxonomy_id ON allocation_target_weights
            FOR EACH ROW
            WHEN (SELECT taxonomy_id FROM allocation_targets WHERE id = NEW.target_id) <> NEW.taxonomy_id
            BEGIN
                SELECT RAISE(ABORT, 'allocation_target_weights.taxonomy_id must match allocation_targets.taxonomy_id');
            END;
            "#,
        )
        .map_err(|e| {
            error!(
                "Failed to recreate missing allocation_target_weights update trigger during migration repair: {}",
                e
            );
            Error::Database(DatabaseError::MigrationFailed(e.to_string()))
        })?;
        repaired = true;
    }

    if repaired {
        info!("Repaired missing allocation_targets schema before retrying migrations.");
    }

    Ok(())
}

fn is_missing_allocation_targets_error(error: &str) -> bool {
    error.contains("no such table: allocation_targets")
        || error.contains("no such table: allocation_target_weights")
}

`,
    "allocation_targets migration repair helpers",
  );

  writeText("crates/storage-sqlite/src/db/mod.rs", content);
}

function main() {
  updateDatabaseModule();
  console.log("Applied database compatibility transformation.");
}

main();
