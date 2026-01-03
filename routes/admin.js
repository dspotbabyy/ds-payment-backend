/**
 * Admin Routes
 * Manage email aliases, view unmatched payments, and system settings
 */

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { getRotationStatus, forceRotate, resetRotation } = require('../services/rotation');

// Simple admin auth middleware (use a secret key)
function adminAuth(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  
  if (!process.env.ADMIN_API_KEY) {
    // If no admin key is set, allow access (development mode)
    console.warn('⚠️ ADMIN_API_KEY not set - admin routes are unprotected!');
    return next();
  }
  
  if (adminKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized - Invalid admin key' });
  }
  
  next();
}

router.use(adminAuth);

// ===================================
// EMAIL ALIASES (Rotation System)
// ===================================

/**
 * GET /api/admin/aliases
 * List all email aliases
 */
router.get('/aliases', async (req, res) => {
  try {
    const aliases = await db.query(`
      SELECT 
        id, alias_email, bank_name, bank_slug, active,
        daily_cap_cents, daily_total_cents, weight,
        last_used_at, created_at,
        ROUND((daily_total_cents * 100.0 / daily_cap_cents), 1) as usage_percent
      FROM email_aliases 
      ORDER BY weight DESC, created_at ASC
    `);

    res.json({
      success: true,
      aliases: aliases.map(a => ({
        ...a,
        daily_cap: (a.daily_cap_cents / 100).toFixed(2),
        daily_total: (a.daily_total_cents / 100).toFixed(2),
        active: a.active === 1 || a.active === true
      })),
      count: aliases.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/aliases
 * Add a new email alias
 */
router.post('/aliases', async (req, res) => {
  try {
    const {
      alias_email,
      bank_name,
      bank_slug,
      daily_cap = 5000, // Default $5000/day
      weight = 1,
      active = true
    } = req.body;

    if (!alias_email) {
      return res.status(400).json({ 
        success: false, 
        error: 'alias_email is required' 
      });
    }

    // Convert daily cap to cents
    const daily_cap_cents = Math.round(parseFloat(daily_cap) * 100);

    const sql = `
      INSERT INTO email_aliases 
        (alias_email, bank_name, bank_slug, daily_cap_cents, weight, active)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    const result = await db.query(sql, [
      alias_email.toLowerCase().trim(),
      bank_name || null,
      bank_slug || null,
      daily_cap_cents,
      weight,
      active ? 1 : 0
    ]);

    res.status(201).json({
      success: true,
      message: 'Email alias created',
      alias: {
        id: result.insertId,
        alias_email,
        bank_name,
        bank_slug,
        daily_cap,
        weight,
        active
      }
    });
  } catch (error) {
    if (error.message.includes('UNIQUE') || error.message.includes('duplicate')) {
      return res.status(400).json({ 
        success: false, 
        error: 'This email alias already exists' 
      });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/admin/aliases/:id
 * Update an email alias
 */
router.put('/aliases/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      alias_email,
      bank_name,
      bank_slug,
      daily_cap,
      weight,
      active
    } = req.body;

    // Build dynamic update query
    const updates = [];
    const params = [];

    if (alias_email !== undefined) {
      updates.push('alias_email = ?');
      params.push(alias_email.toLowerCase().trim());
    }
    if (bank_name !== undefined) {
      updates.push('bank_name = ?');
      params.push(bank_name);
    }
    if (bank_slug !== undefined) {
      updates.push('bank_slug = ?');
      params.push(bank_slug);
    }
    if (daily_cap !== undefined) {
      updates.push('daily_cap_cents = ?');
      params.push(Math.round(parseFloat(daily_cap) * 100));
    }
    if (weight !== undefined) {
      updates.push('weight = ?');
      params.push(weight);
    }
    if (active !== undefined) {
      updates.push('active = ?');
      params.push(active ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No fields to update' 
      });
    }

    params.push(id);
    const sql = `UPDATE email_aliases SET ${updates.join(', ')} WHERE id = ?`;
    
    await db.query(sql, params);

    // Get updated alias
    const alias = await db.get('SELECT * FROM email_aliases WHERE id = ?', [id]);

    res.json({
      success: true,
      message: 'Email alias updated',
      alias
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/admin/aliases/:id
 * Delete an email alias
 */
router.delete('/aliases/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    await db.query('DELETE FROM email_aliases WHERE id = ?', [id]);

    res.json({
      success: true,
      message: 'Email alias deleted'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/aliases/:id/reset
 * Reset daily total for an alias (manual reset)
 */
router.post('/aliases/:id/reset', async (req, res) => {
  try {
    const { id } = req.params;
    
    await db.query(
      'UPDATE email_aliases SET daily_total_cents = 0 WHERE id = ?',
      [id]
    );

    res.json({
      success: true,
      message: 'Daily total reset to 0'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/aliases/reset-all
 * Reset all daily totals (usually done automatically at midnight)
 */
router.post('/aliases/reset-all', async (req, res) => {
  try {
    await db.query('UPDATE email_aliases SET daily_total_cents = 0');

    res.json({
      success: true,
      message: 'All daily totals reset'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===================================
// ROTATION STATUS
// ===================================

/**
 * GET /api/admin/rotation/status
 * Get current rotation status and next alias to be used
 */
router.get('/rotation/status', async (req, res) => {
  try {
    // Get all active aliases ordered by selection priority
    const aliases = await db.query(`
      SELECT 
        id, alias_email, bank_name, 
        daily_cap_cents, daily_total_cents,
        (daily_cap_cents - daily_total_cents) as remaining_cents,
        weight, last_used_at
      FROM email_aliases 
      WHERE active = 1 
        AND daily_total_cents < daily_cap_cents
      ORDER BY weight DESC, last_used_at ASC
    `);

    const totalCapacity = aliases.reduce((sum, a) => sum + a.daily_cap_cents, 0);
    const totalUsed = aliases.reduce((sum, a) => sum + a.daily_total_cents, 0);

    res.json({
      success: true,
      rotation: {
        active_aliases: aliases.length,
        next_alias: aliases[0] ? {
          email: aliases[0].alias_email,
          bank: aliases[0].bank_name,
          remaining: ((aliases[0].daily_cap_cents - aliases[0].daily_total_cents) / 100).toFixed(2)
        } : null,
        total_daily_capacity: (totalCapacity / 100).toFixed(2),
        total_used_today: (totalUsed / 100).toFixed(2),
        remaining_capacity: ((totalCapacity - totalUsed) / 100).toFixed(2),
        usage_percent: totalCapacity > 0 ? ((totalUsed / totalCapacity) * 100).toFixed(1) : 0
      },
      aliases: aliases.map(a => ({
        email: a.alias_email,
        bank: a.bank_name,
        daily_cap: (a.daily_cap_cents / 100).toFixed(2),
        used_today: (a.daily_total_cents / 100).toFixed(2),
        remaining: ((a.daily_cap_cents - a.daily_total_cents) / 100).toFixed(2),
        weight: a.weight,
        last_used: a.last_used_at
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===================================
// UNMATCHED PAYMENTS
// ===================================

/**
 * GET /api/admin/unmatched
 * List unmatched payments for manual review
 */
router.get('/unmatched', async (req, res) => {
  try {
    const { resolved = 'false' } = req.query;
    
    const payments = await db.query(`
      SELECT * FROM unmatched_payments 
      WHERE resolved = ?
      ORDER BY created_at DESC
      LIMIT 100
    `, [resolved === 'true' ? 1 : 0]);

    res.json({
      success: true,
      payments: payments.map(p => ({
        ...p,
        amount: p.amount_cents ? (p.amount_cents / 100).toFixed(2) : null
      })),
      count: payments.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/unmatched/:id/resolve
 * Mark an unmatched payment as resolved
 */
router.post('/unmatched/:id/resolve', async (req, res) => {
  try {
    const { id } = req.params;
    const { notes, resolved_by } = req.body;

    await db.query(`
      UPDATE unmatched_payments 
      SET resolved = 1, resolved_at = CURRENT_TIMESTAMP, 
          resolved_by = ?, notes = ?
      WHERE id = ?
    `, [resolved_by || 'admin', notes || null, id]);

    res.json({
      success: true,
      message: 'Payment marked as resolved'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/unmatched/:id/match
 * Manually match an unmatched payment to an order
 */
router.post('/unmatched/:id/match', async (req, res) => {
  try {
    const { id } = req.params;
    const { order_id, notes } = req.body;

    if (!order_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'order_id is required' 
      });
    }

    // Get the unmatched payment
    const payment = await db.get(
      'SELECT * FROM unmatched_payments WHERE id = ?', 
      [id]
    );

    if (!payment) {
      return res.status(404).json({ 
        success: false, 
        error: 'Unmatched payment not found' 
      });
    }

    // Update the order
    await db.query(`
      UPDATE orders 
      SET status = 'paid', paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [order_id]);

    // Log event
    await db.query(
      'INSERT INTO payment_events (order_id, event_type, event_data) VALUES (?, ?, ?)',
      [order_id, 'manual_match', JSON.stringify({ 
        unmatched_payment_id: id, 
        amount_cents: payment.amount_cents,
        matched_by: 'admin',
        notes
      })]
    );

    // Mark unmatched payment as resolved
    await db.query(`
      UPDATE unmatched_payments 
      SET resolved = 1, resolved_at = CURRENT_TIMESTAMP, 
          resolved_by = 'admin', notes = ?
      WHERE id = ?
    `, [`Matched to order ${order_id}. ${notes || ''}`, id]);

    res.json({
      success: true,
      message: `Payment matched to order ${order_id}`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===================================
// BLACKLIST
// ===================================

/**
 * GET /api/admin/blacklist
 * List all blacklisted items
 */
router.get('/blacklist', async (req, res) => {
  try {
    const items = await db.query(`
      SELECT * FROM blacklist ORDER BY created_at DESC
    `);

    res.json({
      success: true,
      blacklist: items,
      count: items.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/blacklist
 * Add item to blacklist
 */
router.post('/blacklist', async (req, res) => {
  try {
    const { type, value, reason } = req.body;

    if (!type || !value) {
      return res.status(400).json({ 
        success: false, 
        error: 'type and value are required' 
      });
    }

    const validTypes = ['email', 'phone', 'ip', 'name'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: `type must be one of: ${validTypes.join(', ')}` 
      });
    }

    await db.query(
      'INSERT INTO blacklist (type, value, reason) VALUES (?, ?, ?)',
      [type, value.toLowerCase().trim(), reason || null]
    );

    res.status(201).json({
      success: true,
      message: `${type} added to blacklist`
    });
  } catch (error) {
    if (error.message.includes('UNIQUE') || error.message.includes('duplicate')) {
      return res.status(400).json({ 
        success: false, 
        error: 'This item is already blacklisted' 
      });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/admin/blacklist/:id
 * Remove item from blacklist
 */
router.delete('/blacklist/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    await db.query('DELETE FROM blacklist WHERE id = ?', [id]);

    res.json({
      success: true,
      message: 'Item removed from blacklist'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===================================
// SYSTEM SETTINGS
// ===================================

/**
 * GET /api/admin/settings
 * Get current system settings
 */
router.get('/settings', async (req, res) => {
  res.json({
    success: true,
    settings: {
      payment_email: process.env.DEFAULT_PAYMENT_EMAIL || 'not set',
      recipient_name: process.env.RECIPIENT_NAME || 'not set',
      email_enabled: process.env.EMAIL_ENABLED === 'true',
      imap_enabled: process.env.IMAP_ENABLED === 'true',
      environment: process.env.NODE_ENV || 'development'
    }
  });
});

// ===================================
// ROTATION MANAGEMENT
// ===================================

/**
 * GET /api/admin/rotation
 * Get current rotation status
 */
router.get('/rotation', async (req, res) => {
  try {
    const status = await getRotationStatus();
    res.json({
      success: true,
      rotation: status
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/rotation/next
 * Force rotate to next email alias
 */
router.post('/rotation/next', async (req, res) => {
  try {
    const result = await forceRotate();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/admin/rotation/reset
 * Reset rotation to first alias
 */
router.post('/rotation/reset', async (req, res) => {
  try {
    const result = await resetRotation();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
