let pool = null;
let poolConstructorOverride = null;

function isPostgresEnabled(config) {
  return Boolean(
    config.PG_ENABLED &&
      config.PG_HOST &&
      config.PG_DATABASE &&
      config.PG_USER &&
      config.PG_PASSWORD
  );
}

function createSslOptions(config) {
  if (!config.PG_SSL) {
    return false;
  }

  return {
    rejectUnauthorized: config.PG_SSL_REJECT_UNAUTHORIZED !== false
  };
}

function getPool(config) {
  if (!isPostgresEnabled(config)) {
    return null;
  }

  if (!pool) {
    const Pool = poolConstructorOverride || require("pg").Pool;
    pool = new Pool({
      host: config.PG_HOST,
      port: Number(config.PG_PORT || 5432),
      database: config.PG_DATABASE,
      user: config.PG_USER,
      password: config.PG_PASSWORD,
      ssl: createSslOptions(config),
      connectionTimeoutMillis: Number(config.PG_CONNECT_TIMEOUT_MS || 3000),
      query_timeout: Number(config.PG_QUERY_TIMEOUT_MS || 4000)
    });
  }

  return pool;
}

function setPoolConstructorForTests(poolConstructor) {
  pool = null;
  poolConstructorOverride = poolConstructor || null;
}

async function resetPool() {
  const current = pool;
  pool = null;
  if (current && typeof current.end === "function") {
    await current.end();
  }
}

module.exports = {
  getPool,
  isPostgresEnabled,
  setPoolConstructorForTests,
  resetPool
};
