const crypto = require("crypto");
const { getPool, isPostgresEnabled } = require("./db");

let schemaReady = false;
let initPromise = null;

function commandId() {
  return `svc-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

async function ensureMaintenanceSchema(config) {
  if (!isPostgresEnabled(config)) {
    return false;
  }

  if (schemaReady) {
    return true;
  }

  if (!initPromise) {
    initPromise = (async () => {
      const db = getPool(config);
      await db.query(`
        CREATE TABLE IF NOT EXISTS maintenance_states (
          node_id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          command_id TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      schemaReady = true;
      console.log("[pg] maintenance store ready");
      return true;
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }

  return initPromise;
}

async function saveMaintenanceState(config, record) {
  if (!isPostgresEnabled(config)) {
    return false;
  }

  await ensureMaintenanceSchema(config);
  const db = getPool(config);
  await db.query(
    `
      INSERT INTO maintenance_states (node_id, state, command_id, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (node_id)
      DO UPDATE SET state = EXCLUDED.state,
                    command_id = EXCLUDED.command_id,
                    updated_at = NOW()
    `,
    [
      String(record.nodeId || "unknown").toLowerCase(),
      String(record.state || "NONE").toUpperCase(),
      String(record.commandId || "")
    ]
  );
  return true;
}

async function loadMaintenanceStates(config) {
  if (!isPostgresEnabled(config)) {
    return [];
  }

  await ensureMaintenanceSchema(config);
  const db = getPool(config);
  const result = await db.query(`
    SELECT node_id, state, command_id, updated_at
    FROM maintenance_states
    ORDER BY updated_at DESC
  `);

  return result.rows.map((row) => ({
    nodeId: String(row.node_id || "unknown").toLowerCase(),
    state: String(row.state || "NONE").toUpperCase(),
    commandId: String(row.command_id || ""),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.getTime()
        : Date.parse(row.updated_at) || Date.now()
  }));
}

async function persistNodeMaintenance(config, node) {
  const state = String(node?.serviceState || "").toUpperCase();
  if (!node || (state !== "REQUIRED" && state !== "DONE")) {
    return false;
  }

  return saveMaintenanceState(config, {
    nodeId: node.nodeId,
    state,
    commandId: node.serviceCommandId || ""
  });
}

module.exports = {
  commandId,
  ensureMaintenanceSchema,
  saveMaintenanceState,
  loadMaintenanceStates,
  persistNodeMaintenance
};
