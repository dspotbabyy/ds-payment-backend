/**
 * Health Check Routes
 * For monitoring and load balancer health checks
 */

const express = require('express');
const router = express.Router();
const db = require('../config/database');

// ===================================
// BASIC HEALTH CHECK
// GET /api/health
// ===================================

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'DS Payment Gateway',
    version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

// ===================================
// DETAILED HEALTH CHECK
// GET /api/health/detailed
// ===================================

router.get('/health/detailed', async (req, res) => {
  const health = {
    status: 'ok',
    service: 'DS Payment Gateway',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    checks: {}
  };

  // Database check
  try {
    const start = Date.now();
    await db.get('SELECT 1');
    health.checks.database = {
      status: 'ok',
      responseTime: Date.now() - start + 'ms'
    };
  } catch (error) {
    health.status = 'degraded';
    health.checks.database = {
      status: 'error',
      error: error.message
    };
  }

  // Check pending orders count
  try {
    const result = await db.get('SELECT COUNT(*) as count FROM orders WHERE status = ?', ['pending']);
    health.checks.pendingOrders = {
      count: result?.count || 0
    };
  } catch (error) {
    health.checks.pendingOrders = {
      status: 'error',
      error: error.message
    };
  }

  // Check unmatched payments
  try {
    const result = await db.get('SELECT COUNT(*) as count FROM unmatched_payments WHERE resolved = 0');
    health.checks.unmatchedPayments = {
      count: result?.count || 0
    };
  } catch (error) {
    health.checks.unmatchedPayments = {
      status: 'error',
      error: error.message
    };
  }

  // IMAP status
  health.checks.imap = {
    enabled: process.env.IMAP_ENABLED === 'true',
    configured: !!(process.env.IMAP_HOST && process.env.IMAP_USER)
  };

  // Email status
  health.checks.email = {
    enabled: process.env.EMAIL_ENABLED === 'true',
    configured: !!(process.env.SMTP_HOST && process.env.SMTP_USER)
  };

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// ===================================
// STATS ENDPOINT
// GET /api/stats
// ===================================

router.get('/stats', async (req, res) => {
  try {
    const stats = {};

    // Orders by status
    const ordersByStatus = await db.query(`
      SELECT status, COUNT(*) as count 
      FROM orders 
      GROUP BY status
    `);
    stats.ordersByStatus = ordersByStatus.reduce((acc, row) => {
      acc[row.status] = row.count;
      return acc;
    }, {});

    // Today's orders
    const today = new Date().toISOString().split('T')[0];
    const todayOrders = await db.get(`
      SELECT COUNT(*) as count, SUM(amount_cents) as total
      FROM orders 
      WHERE DATE(created_at) = ?
    `, [today]);
    stats.today = {
      orders: todayOrders?.count || 0,
      total: todayOrders?.total ? (todayOrders.total / 100).toFixed(2) : '0.00'
    };

    // This week's orders
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const weekOrders = await db.get(`
      SELECT COUNT(*) as count, SUM(amount_cents) as total
      FROM orders 
      WHERE created_at >= ?
    `, [weekAgo]);
    stats.thisWeek = {
      orders: weekOrders?.count || 0,
      total: weekOrders?.total ? (weekOrders.total / 100).toFixed(2) : '0.00'
    };

    // Unmatched payments
    const unmatched = await db.get(`
      SELECT COUNT(*) as count 
      FROM unmatched_payments 
      WHERE resolved = 0
    `);
    stats.unmatchedPayments = unmatched?.count || 0;

    // Webhook failures
    const failures = await db.get(`
      SELECT COUNT(*) as count 
      FROM webhook_failures 
      WHERE resolved = 0
    `);
    stats.webhookFailures = failures?.count || 0;

    res.json({
      success: true,
      stats,
      generatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
