/**
 * Database Configuration
 * Supports SQLite (development) and PostgreSQL (production)
 */

const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const path = require('path');

// Determine if we're in production (PostgreSQL) or development (SQLite)
const isProduction = process.env.NODE_ENV === 'production' || process.env.DATABASE_URL;

let db = null;
let pool = null;

// ===================================
// DATABASE INITIALIZATION
// ===================================

async function initialize() {
  if (isProduction) {
    await initializePostgres();
  } else {
    await initializeSQLite();
  }
  await runMigrations();
}

async function initializeSQLite() {
  const dbPath = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'orders.db');
  
  // Ensure data directory exists
  const fs = require('fs');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('SQLite connection error:', err);
        reject(err);
      } else {
        console.log(`📁 SQLite database: ${dbPath}`);
        resolve();
      }
    });
  });
}

async function initializePostgres() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
  });

  // Test connection
  const client = await pool.connect();
  console.log('🐘 PostgreSQL connected');
  client.release();
}

// ===================================
// MIGRATIONS
// ===================================

async function runMigrations() {
  const migrations = [
    // Orders table
    `CREATE TABLE IF NOT EXISTS orders (
      id ${isProduction ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isProduction ? '' : 'AUTOINCREMENT'},
      reference_number VARCHAR(50) UNIQUE NOT NULL,
      woo_order_id VARCHAR(50),
      customer_email VARCHAR(255),
      customer_name VARCHAR(255),
      customer_phone VARCHAR(50),
      amount_cents INTEGER NOT NULL,
      currency VARCHAR(3) DEFAULT 'CAD',
      status VARCHAR(50) DEFAULT 'pending',
      payment_email VARCHAR(255),
      payment_instructions TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      paid_at TIMESTAMP,
      expires_at TIMESTAMP,
      metadata ${isProduction ? 'JSONB' : 'TEXT'}
    )`,

    // Payment events table (audit log)
    `CREATE TABLE IF NOT EXISTS payment_events (
      id ${isProduction ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isProduction ? '' : 'AUTOINCREMENT'},
      order_id INTEGER REFERENCES orders(id),
      event_type VARCHAR(50) NOT NULL,
      event_data ${isProduction ? 'JSONB' : 'TEXT'},
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    // Email aliases for rotation
    `CREATE TABLE IF NOT EXISTS email_aliases (
      id ${isProduction ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isProduction ? '' : 'AUTOINCREMENT'},
      alias_email VARCHAR(255) UNIQUE NOT NULL,
      bank_name VARCHAR(100),
      bank_slug VARCHAR(50),
      active ${isProduction ? 'BOOLEAN' : 'INTEGER'} DEFAULT ${isProduction ? 'true' : '1'},
      daily_cap_cents INTEGER DEFAULT 500000,
      daily_total_cents INTEGER DEFAULT 0,
      weight INTEGER DEFAULT 1,
      last_used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    // Unmatched payments (for manual review)
    `CREATE TABLE IF NOT EXISTS unmatched_payments (
      id ${isProduction ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isProduction ? '' : 'AUTOINCREMENT'},
      amount_cents INTEGER NOT NULL,
      sender_email VARCHAR(255),
      sender_name VARCHAR(255),
      reference_code VARCHAR(100),
      reason VARCHAR(255) NOT NULL,
      raw_text TEXT,
      resolved ${isProduction ? 'BOOLEAN' : 'INTEGER'} DEFAULT ${isProduction ? 'false' : '0'},
      resolved_by VARCHAR(255),
      resolved_at TIMESTAMP,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    // Blacklist for fraud prevention
    `CREATE TABLE IF NOT EXISTS blacklist (
      id ${isProduction ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isProduction ? '' : 'AUTOINCREMENT'},
      type VARCHAR(50) NOT NULL,
      value VARCHAR(255) NOT NULL,
      reason VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(type, value)
    )`,

    // Webhook failures for retry
    `CREATE TABLE IF NOT EXISTS webhook_failures (
      id ${isProduction ? 'SERIAL' : 'INTEGER'} PRIMARY KEY ${isProduction ? '' : 'AUTOINCREMENT'},
      webhook_url VARCHAR(500) NOT NULL,
      payload TEXT NOT NULL,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      last_retry_at TIMESTAMP,
      resolved ${isProduction ? 'BOOLEAN' : 'INTEGER'} DEFAULT ${isProduction ? 'false' : '0'},
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    // Rotation state for email alias rotation (every 20 orders)
    `CREATE TABLE IF NOT EXISTS rotation_state (
      id INTEGER PRIMARY KEY,
      current_alias_id INTEGER REFERENCES email_aliases(id),
      order_count INTEGER DEFAULT 0,
      total_orders INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,

    // Indexes for performance
    isProduction ? 
      `CREATE INDEX IF NOT EXISTS idx_orders_reference ON orders(reference_number)` :
      `CREATE INDEX IF NOT EXISTS idx_orders_reference ON orders(reference_number)`,
    isProduction ?
      `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)` :
      `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`,
    isProduction ?
      `CREATE INDEX IF NOT EXISTS idx_orders_woo_id ON orders(woo_order_id)` :
      `CREATE INDEX IF NOT EXISTS idx_orders_woo_id ON orders(woo_order_id)`
  ];

  for (const migration of migrations) {
    try {
      await query(migration);
    } catch (error) {
      // Ignore "already exists" errors
      if (!error.message.includes('already exists') && !error.message.includes('duplicate')) {
        console.error('Migration error:', error.message);
      }
    }
  }

  console.log('✅ Database migrations complete');
}

// ===================================
// QUERY HELPERS
// ===================================

async function query(sql, params = []) {
  if (isProduction) {
    // Convert ? placeholders to $1, $2, etc. for PostgreSQL
    let pgSql = sql;
    let paramIndex = 1;
    while (pgSql.includes('?')) {
      pgSql = pgSql.replace('?', '$' + paramIndex);
      paramIndex++;
    }
    const result = await pool.query(pgSql, params);
    return result.rows;
  } else {
    return new Promise((resolve, reject) => {
      if (sql.trim().toUpperCase().startsWith('SELECT')) {
        db.all(sql, params, (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      } else if (sql.trim().toUpperCase().startsWith('INSERT')) {
        db.run(sql, params, function(err) {
          if (err) reject(err);
          else resolve({ insertId: this.lastID, changes: this.changes });
        });
      } else {
        db.run(sql, params, function(err) {
          if (err) reject(err);
          else resolve({ changes: this.changes });
        });
      }
    });
  }
}

async function get(sql, params = []) {
  if (isProduction) {
    let pgSql = sql;
    let idx = 1;
    while (pgSql.includes('?')) {
      pgSql = pgSql.replace('?', '$' + idx);
      idx++;
    }
    const result = await pool.query(pgSql, params);    return result.rows[0] || null;
  } else {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      });
    });
  }
}

async function close() {
  if (isProduction && pool) {
    await pool.end();
  } else if (db) {
    return new Promise((resolve) => {
      db.close(() => resolve());
    });
  }
}

// ===================================
// EXPORTS
// ===================================

module.exports = {
  initialize,
  query,
  get,
  close,
  isProduction
};
