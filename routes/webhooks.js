/**
 * Webhook Routes
 * Handles incoming webhooks from WooCommerce and payment confirmations
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../config/database');
const { sendPaymentConfirmation } = require('../services/notifications');

// ===================================
// WEBHOOK SIGNATURE VERIFICATION
// ===================================

function verifyWooCommerceSignature(req) {
  const signature = req.headers['x-wc-webhook-signature'];
  const secret = process.env.WOOCOMMERCE_WEBHOOK_SECRET;

  if (!signature || !secret) {
    return false;
  }

  const payload = JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

function verifyWebhookSecret(req) {
  const secret = req.headers['x-webhook-secret'];
  return secret === process.env.WEBHOOK_SECRET;
}

// ===================================
// WOOCOMMERCE ORDER WEBHOOK
// POST /api/webhooks/woocommerce
// ===================================

router.post('/woocommerce', async (req, res) => {
  try {
    // Verify signature if secret is configured
    if (process.env.WOOCOMMERCE_WEBHOOK_SECRET) {
      if (!verifyWooCommerceSignature(req)) {
        console.warn('Invalid WooCommerce webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const { 
      id: woo_order_id,
      order_key,
      status,
      total,
      currency,
      billing,
      line_items,
      meta_data
    } = req.body;

    console.log(`📦 WooCommerce webhook received: Order #${woo_order_id} - ${status}`);

    // Only process new orders or status changes
    if (status === 'pending' || status === 'on-hold') {
      // Check if order already exists
      let existingOrder = await db.get(
        'SELECT * FROM orders WHERE woo_order_id = ?',
        [woo_order_id.toString()]
      );

      if (!existingOrder) {
        // Create new order
        const referenceNumber = `ORD-${woo_order_id}-${Date.now().toString(36).toUpperCase()}`;
        const amountCents = Math.round(parseFloat(total) * 100);
        const paymentEmail = process.env.DEFAULT_PAYMENT_EMAIL;
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

        const paymentInstructions = JSON.stringify({
          recipient_email: paymentEmail,
          recipient_name: process.env.RECIPIENT_NAME || 'DS Payment',
          amount: total,
          reference: referenceNumber,
          message: `Please include ${referenceNumber} in your e-Transfer message`
        });

        const sql = `
          INSERT INTO orders (
            reference_number, woo_order_id, customer_email, customer_name,
            customer_phone, amount_cents, currency, status, payment_email,
            payment_instructions, expires_at, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const params = [
          referenceNumber,
          woo_order_id.toString(),
          billing?.email || '',
          `${billing?.first_name || ''} ${billing?.last_name || ''}`.trim(),
          billing?.phone || null,
          amountCents,
          currency || 'CAD',
          'pending',
          paymentEmail,
          paymentInstructions,
          expiresAt,
          JSON.stringify({ woo_status: status, order_key, line_items_count: line_items?.length || 0 })
        ];

        await db.query(sql, params);

        console.log(`✅ Order created: ${referenceNumber} for WooCommerce #${woo_order_id}`);

        // Log event
        await db.query(
          'INSERT INTO payment_events (order_id, event_type, event_data) VALUES ((SELECT id FROM orders WHERE reference_number = ?), ?, ?)',
          [referenceNumber, 'order_created', JSON.stringify({ source: 'woocommerce_webhook', woo_order_id })]
        );
      }
    }

    // Handle payment completion from WooCommerce side
    if (status === 'processing' || status === 'completed') {
      await db.query(
        'UPDATE orders SET status = ?, paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE woo_order_id = ?',
        [status === 'completed' ? 'completed' : 'paid', woo_order_id.toString()]
      );
      console.log(`✅ Order ${woo_order_id} marked as ${status}`);
    }

    res.json({ success: true, message: 'Webhook processed' });

  } catch (error) {
    console.error('WooCommerce webhook error:', error);
    
    // Log failure for retry
    await db.query(
      'INSERT INTO webhook_failures (webhook_url, payload, error_message) VALUES (?, ?, ?)',
      ['woocommerce', JSON.stringify(req.body), error.message]
    ).catch(e => console.error('Failed to log webhook failure:', e));

    res.status(500).json({ success: false, error: error.message });
  }
});

// ===================================
// PAYMENT CONFIRMED WEBHOOK
// POST /api/webhooks/payment-confirmed
// ===================================

router.post('/payment-confirmed', async (req, res) => {
  try {
    // Verify webhook secret
    if (process.env.WEBHOOK_SECRET && !verifyWebhookSecret(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      reference_number,
      order_id,
      amount,
      sender_email,
      sender_name,
      transaction_id,
      confirmed_at
    } = req.body;

    // Find order by reference or ID
    let order;
    if (reference_number) {
      order = await db.get('SELECT * FROM orders WHERE reference_number = ?', [reference_number]);
    } else if (order_id) {
      order = await db.get('SELECT * FROM orders WHERE id = ?', [order_id]);
    }

    if (!order) {
      // Log as unmatched payment
      await db.query(
        'INSERT INTO unmatched_payments (amount_cents, sender_email, sender_name, reference_code, reason, raw_text) VALUES (?, ?, ?, ?, ?, ?)',
        [
          amount ? Math.round(parseFloat(amount) * 100) : 0,
          sender_email || null,
          sender_name || null,
          reference_number || null,
          'Order not found',
          JSON.stringify(req.body)
        ]
      );

      return res.status(404).json({
        success: false,
        error: 'Order not found',
        logged: true
      });
    }

    // Update order status
    await db.query(
      `UPDATE orders SET 
        status = 'paid', 
        paid_at = ?, 
        updated_at = CURRENT_TIMESTAMP,
        metadata = ?
      WHERE id = ?`,
      [
        confirmed_at || new Date().toISOString(),
        JSON.stringify({
          ...JSON.parse(order.metadata || '{}'),
          payment_confirmed: {
            sender_email,
            sender_name,
            transaction_id,
            confirmed_at: confirmed_at || new Date().toISOString()
          }
        }),
        order.id
      ]
    );

    // Log event
    await db.query(
      'INSERT INTO payment_events (order_id, event_type, event_data) VALUES (?, ?, ?)',
      [order.id, 'payment_confirmed', JSON.stringify({ sender_email, sender_name, transaction_id })]
    );

    console.log(`✅ Payment confirmed for order ${order.reference_number}`);

    // Send confirmation email
    if (process.env.EMAIL_ENABLED === 'true' && order.customer_email) {
      sendPaymentConfirmation({
        email: order.customer_email,
        name: order.customer_name,
        orderNumber: order.reference_number,
        amount: (order.amount_cents / 100).toFixed(2)
      }).catch(err => console.error('Confirmation email error:', err));
    }

    // Update WooCommerce if configured
    if (order.woo_order_id && process.env.WOOCOMMERCE_API_URL) {
      updateWooCommerceOrder(order.woo_order_id, 'processing')
        .catch(err => console.error('WooCommerce update error:', err));
    }

    res.json({
      success: true,
      message: 'Payment confirmed',
      order: {
        id: order.id,
        reference_number: order.reference_number,
        status: 'paid'
      }
    });

  } catch (error) {
    console.error('Payment confirmation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===================================
// CUSTOMER PAYMENT INTENT
// POST /api/webhooks/payment-sent
// Called when customer clicks "I've sent the payment"
// ===================================

router.post('/payment-sent', async (req, res) => {
  try {
    const { reference_number, order_id } = req.body;

    let order;
    if (reference_number) {
      order = await db.get('SELECT * FROM orders WHERE reference_number = ?', [reference_number]);
    } else if (order_id) {
      order = await db.get('SELECT * FROM orders WHERE id = ?', [order_id]);
    }

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    // Update status to awaiting confirmation
    await db.query(
      'UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['awaiting_payment', order.id]
    );

    // Log event
    await db.query(
      'INSERT INTO payment_events (order_id, event_type, event_data) VALUES (?, ?, ?)',
      [order.id, 'payment_sent_by_customer', JSON.stringify({ timestamp: new Date().toISOString() })]
    );

    console.log(`⏳ Customer indicated payment sent for ${order.reference_number}`);

    res.json({
      success: true,
      message: 'Payment status updated. We are checking for your payment.',
      order: {
        id: order.id,
        reference_number: order.reference_number,
        status: 'awaiting_payment'
      }
    });

  } catch (error) {
    console.error('Payment sent webhook error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===================================
// HELPER: UPDATE WOOCOMMERCE ORDER
// ===================================

async function updateWooCommerceOrder(wooOrderId, status) {
  const apiUrl = process.env.WOOCOMMERCE_API_URL;
  const consumerKey = process.env.WOOCOMMERCE_CONSUMER_KEY;
  const consumerSecret = process.env.WOOCOMMERCE_CONSUMER_SECRET;

  if (!apiUrl || !consumerKey || !consumerSecret) {
    console.warn('WooCommerce API not configured');
    return;
  }

  const url = `${apiUrl}/wp-json/wc/v3/orders/${wooOrderId}`;
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${auth}`
    },
    body: JSON.stringify({ status })
  });

  if (!response.ok) {
    throw new Error(`WooCommerce API error: ${response.status}`);
  }

  console.log(`✅ WooCommerce order ${wooOrderId} updated to ${status}`);
}

module.exports = router;
