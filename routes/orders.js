/**
 * Orders Routes
 * Handles all order-related API endpoints
 */

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { sendOrderConfirmation } = require('../services/notifications');
const { getNextPaymentEmail } = require('../services/rotation');

// ===================================
// HELPER FUNCTIONS
// ===================================

function generateReferenceNumber() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ORD-${timestamp}${random}`;
}

function formatAmount(cents) {
  return (cents / 100).toFixed(2);
}

// ===================================
// CREATE ORDER
// POST /api/orders
// ===================================

router.post('/', async (req, res) => {
  try {
    const {
      woo_order_id,
      customer_email,
      customer_name,
      customer_phone,
      amount, // Can be cents or dollars
      currency = 'CAD',
      payment_email,
      metadata
    } = req.body;

    // Validate required fields
    if (!customer_email || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: customer_email and amount are required'
      });
    }

    // Convert amount to cents if needed
    let amountCents = parseInt(amount);
    if (amountCents < 100) {
      // Assume it's in dollars, convert to cents
      amountCents = Math.round(parseFloat(amount) * 100);
    }

    // Generate reference number
    const referenceNumber = generateReferenceNumber();

    // Set expiration (15 minutes from now)
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Get payment email from rotation system (or use provided/default)
    let paymentEmailToUse = payment_email;
    let recipientName = process.env.RECIPIENT_NAME || 'DS Payment';
    let aliasId = null;
    let rotationInfo = null;

    if (!paymentEmailToUse) {
      // Use rotation system to get next email
      rotationInfo = await getNextPaymentEmail();
      paymentEmailToUse = rotationInfo.email;
      recipientName = rotationInfo.name || recipientName;
      aliasId = rotationInfo.alias_id;
    }

    // Create payment instructions
    const paymentInstructions = JSON.stringify({
      recipient_email: paymentEmailToUse,
      recipient_name: recipientName,
      amount: formatAmount(amountCents),
      reference: referenceNumber,
      message: `Please include ${referenceNumber} in your e-Transfer message`,
      alias_id: aliasId,
      orders_until_rotation: rotationInfo?.orders_until_rotation
    });

    // Insert order
    const sql = `
      INSERT INTO orders (
        reference_number, woo_order_id, customer_email, customer_name,
        customer_phone, amount_cents, currency, status, payment_email,
        payment_instructions, expires_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      referenceNumber,
      woo_order_id || null,
      customer_email,
      customer_name || null,
      customer_phone || null,
      amountCents,
      currency,
      'pending',
      paymentEmailToUse,
      paymentInstructions,
      expiresAt,
      JSON.stringify(metadata || {})
    ];

    const result = await db.query(sql, params);
    const orderId = result.insertId || result[0]?.id;

    // Log event
    await db.query(
      'INSERT INTO payment_events (order_id, event_type, event_data) VALUES (?, ?, ?)',
      [orderId, 'order_created', JSON.stringify({ source: 'api' })]
    );

    // Send confirmation email (async, don't wait)
    if (process.env.EMAIL_ENABLED === 'true') {
      sendOrderConfirmation({
        email: customer_email,
        name: customer_name,
        orderNumber: referenceNumber,
        amount: formatAmount(amountCents),
        paymentEmail: paymentEmailToUse
      }).catch(err => console.error('Email error:', err));
    }

    // Return success response
    res.status(201).json({
      success: true,
      order: {
        id: orderId,
        reference_number: referenceNumber,
        woo_order_id,
        customer_email,
        amount: formatAmount(amountCents),
        amount_cents: amountCents,
        currency,
        status: 'pending',
        payment_instructions: JSON.parse(paymentInstructions),
        expires_at: expiresAt,
        created_at: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===================================
// GET ORDER BY ID
// GET /api/orders/:id
// ===================================

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const order = await db.get(
      'SELECT * FROM orders WHERE id = ?',
      [id]
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    // Parse JSON fields
    if (order.payment_instructions) {
      order.payment_instructions = JSON.parse(order.payment_instructions);
    }
    if (order.metadata) {
      order.metadata = JSON.parse(order.metadata);
    }

    res.json({
      success: true,
      order
    });

  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===================================
// GET ORDER BY REFERENCE NUMBER
// GET /api/orders/reference/:ref
// ===================================

router.get('/reference/:ref', async (req, res) => {
  try {
    const { ref } = req.params;

    const order = await db.get(
      'SELECT * FROM orders WHERE reference_number = ?',
      [ref]
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    // Parse JSON fields
    if (order.payment_instructions) {
      order.payment_instructions = JSON.parse(order.payment_instructions);
    }
    if (order.metadata) {
      order.metadata = JSON.parse(order.metadata);
    }

    res.json({
      success: true,
      order
    });

  } catch (error) {
    console.error('Get order by reference error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===================================
// UPDATE ORDER STATUS
// PUT /api/orders/:id/status
// ===================================

router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    const validStatuses = ['pending', 'awaiting_payment', 'processing', 'paid', 'completed', 'cancelled', 'refunded'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    // Update order
    let sql = 'UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP';
    const params = [status];

    if (status === 'paid' || status === 'completed') {
      sql += ', paid_at = CURRENT_TIMESTAMP';
    }

    sql += ' WHERE id = ?';
    params.push(id);

    await db.query(sql, params);

    // Log event
    await db.query(
      'INSERT INTO payment_events (order_id, event_type, event_data) VALUES (?, ?, ?)',
      [id, 'status_changed', JSON.stringify({ new_status: status, notes })]
    );

    // Get updated order
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [id]);

    res.json({
      success: true,
      order
    });

  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===================================
// LIST ORDERS
// GET /api/orders
// ===================================

router.get('/', async (req, res) => {
  try {
    const {
      status,
      page = 1,
      limit = 20,
      sort = 'created_at',
      order = 'DESC'
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    let sql = 'SELECT * FROM orders';
    const params = [];

    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }

    // Validate sort column to prevent SQL injection
    const validSortColumns = ['created_at', 'updated_at', 'amount_cents', 'status'];
    const sortColumn = validSortColumns.includes(sort) ? sort : 'created_at';
    const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    sql += ` ORDER BY ${sortColumn} ${sortOrder}`;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);

    const orders = await db.query(sql, params);

    // Get total count
    let countSql = 'SELECT COUNT(*) as total FROM orders';
    if (status) {
      countSql += ' WHERE status = ?';
    }
    const countResult = await db.get(countSql, status ? [status] : []);
    const total = countResult?.total || 0;

    res.json({
      success: true,
      orders: orders.map(o => ({
        ...o,
        payment_instructions: o.payment_instructions ? JSON.parse(o.payment_instructions) : null,
        metadata: o.metadata ? JSON.parse(o.metadata) : null
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('List orders error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===================================
// DELETE ORDER
// DELETE /api/orders/:id
// ===================================

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if order exists
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    // Only allow deletion of pending orders
    if (order.status !== 'pending' && order.status !== 'cancelled') {
      return res.status(400).json({
        success: false,
        error: 'Can only delete pending or cancelled orders'
      });
    }

    await db.query('DELETE FROM orders WHERE id = ?', [id]);

    res.json({
      success: true,
      message: 'Order deleted successfully'
    });

  } catch (error) {
    console.error('Delete order error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
