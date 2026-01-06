/**
 * Payment Checker Service
 * Monitors IMAP inbox for Interac e-Transfer notifications
 * and automatically matches payments to orders
 */

const Imap = require('imap');
const { simpleParser } = require('mailparser');
const db = require('../config/database');
const { sendPaymentConfirmation, sendAdminAlert } = require('./notifications');

let imapConnection = null;
let checkInterval = null;

// ===================================
// IMAP CONNECTION
// ===================================

function createImapConnection() {
  return new Imap({
    user: process.env.IMAP_USER,
    password: process.env.IMAP_PASS,
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT) || 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  });
}

// ===================================
// EMAIL PARSING
// ===================================

function parseInteracEmail(emailBody) {
  const result = {
    amount: null,
    amountCents: null,
    senderEmail: null,
    senderName: null,
    referenceCode: null,
    transactionId: null,
    isInterac: false
  };

  // Check if this is an Interac e-Transfer notification
  const interacPatterns = [
    /interac.*e-transfer/i,
    /INTERAC.*deposit/i,
    /e-transfer.*deposit/i,
    /sent.*money.*interac/i,
    /auto.*deposit.*complete/i
  ];

  const bodyText = typeof emailBody === 'string' ? emailBody : emailBody.toString();
  
  result.isInterac = interacPatterns.some(pattern => pattern.test(bodyText));
  
  if (!result.isInterac) {
    return result;
  }

  // Extract amount - multiple patterns for different bank formats
  const amountPatterns = [
    /\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*(?:CAD|CDN)?/i,
    /(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*(?:CAD|CDN|dollars?)/i,
    /amount[:\s]+\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i,
    /deposited[:\s]+\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i
  ];

  for (const pattern of amountPatterns) {
    const match = bodyText.match(pattern);
    if (match) {
      result.amount = parseFloat(match[1].replace(/,/g, ''));
      result.amountCents = Math.round(result.amount * 100);
      break;
    }
  }

  // Extract sender email
  const emailPattern = /(?:from|sender)[:\s]+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
  const emailMatch = bodyText.match(emailPattern);
  if (emailMatch) {
    result.senderEmail = emailMatch[1].toLowerCase();
  }

  // Extract sender name
  const namePatterns = [
    /(?:from|sent by)[:\s]+([A-Za-z]+ [A-Za-z]+)/i,
    /([A-Za-z]+ [A-Za-z]+)\s+(?:has sent|sent you)/i
  ];
  for (const pattern of namePatterns) {
    const match = bodyText.match(pattern);
    if (match && match[1].length < 50) {
      result.senderName = match[1].trim();
      break;
    }
  }

  // Extract reference/order code from message
  const refPatterns = [
    /ORD-[A-Z0-9]+/gi,
    /order[:\s#]+([A-Z0-9-]+)/i,
    /reference[:\s#]+([A-Z0-9-]+)/i,
    /message[:\s]+.*?(ORD-[A-Z0-9]+)/i
  ];

  for (const pattern of refPatterns) {
    const match = bodyText.match(pattern);
    if (match) {
      result.referenceCode = match[1] || match[0];
      break;
    }
  }

  // Extract Interac transaction ID if present
  const txIdPattern = /(?:reference|confirmation|transaction)[:\s#]+([A-Z0-9]{10,})/i;
  const txMatch = bodyText.match(txIdPattern);
  if (txMatch) {
    result.transactionId = txMatch[1];
  }

  return result;
}

// ===================================
// PAYMENT MATCHING
// ===================================

async function matchPaymentToOrder(paymentData) {
  const { amountCents, senderEmail, referenceCode } = paymentData;

  // Priority 1: Match by reference code + amount (100% confidence)
  if (referenceCode) {
    const orderByRef = await db.get(
      'SELECT * FROM orders WHERE reference_number = $1 AND status IN ($2, $3)',
      [referenceCode, 'pending', 'awaiting_payment']
    );
    
    if (orderByRef) {
      // Verify amount matches (allow 1% tolerance for rounding)
      const tolerance = orderByRef.amount_cents * 0.01;
      if (Math.abs(orderByRef.amount_cents - amountCents) <= tolerance) {
        return { order: orderByRef, confidence: 100, matchType: 'reference_and_amount' };
      }
    }
  }

  // Priority 2: Match by amount + sender email (90% confidence)
  if (senderEmail && amountCents) {
    const orderByEmailAmount = await db.get(
      `SELECT * FROM orders 
       WHERE amount_cents = $1 
         AND customer_email = $2
         AND status IN ($3, $4)
       ORDER BY created_at DESC
       LIMIT 1`,
      [amountCents, senderEmail, 'pending', 'awaiting_payment']
    );

    if (orderByEmailAmount) {
      return { order: orderByEmailAmount, confidence: 90, matchType: 'email_and_amount' };
    }
  }

  // Priority 3: Match by amount + recent time (70% confidence)
  if (amountCents) {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const orderByAmountRecent = await db.get(
      `SELECT * FROM orders 
       WHERE amount_cents = $1
         AND status IN ($2, $3)
         AND created_at >= $4
       ORDER BY created_at DESC
       LIMIT 1`,
      [amountCents, 'pending', 'awaiting_payment', thirtyMinutesAgo]
    );

    if (orderByAmountRecent) {
      // Check if there are multiple orders with same amount
      const count = await db.get(
        `SELECT COUNT(*) as count FROM orders 
         WHERE amount_cents = $1 
           AND status IN ($2, $3)
           AND created_at >= $4`,
        [amountCents, 'pending', 'awaiting_payment', thirtyMinutesAgo]
      );

      if (count && count.count === 1) {
        return { order: orderByAmountRecent, confidence: 70, matchType: 'amount_and_time' };
      } else {
        // Multiple matches - return for manual review
        return { order: null, confidence: 50, matchType: 'multiple_matches', count: count?.count };
      }
    }
  }

  // Priority 4: Amount only match (50% confidence - needs review)
  if (amountCents) {
    const orderByAmountOnly = await db.get(
      `SELECT * FROM orders 
       WHERE amount_cents = $1 
         AND status IN ($2, $3)
       ORDER BY created_at DESC
       LIMIT 1`,
      [amountCents, 'pending', 'awaiting_payment']
    );

    if (orderByAmountOnly) {
      return { order: orderByAmountOnly, confidence: 50, matchType: 'amount_only' };
    }
  }

  // No match found
  return { order: null, confidence: 0, matchType: 'no_match' };
}

// ===================================
// PROCESS PAYMENT
// ===================================

async function processPayment(paymentData) {
  console.log('💰 Processing payment:', {
    amount: paymentData.amount,
    sender: paymentData.senderName || paymentData.senderEmail,
    reference: paymentData.referenceCode
  });

  const matchResult = await matchPaymentToOrder(paymentData);

  if (matchResult.order && matchResult.confidence >= 70) {
    // High confidence match - auto-confirm
    const order = matchResult.order;

    await db.query(
      `UPDATE orders SET 
        status = 'paid', 
        paid_at = CURRENT_TIMESTAMP, 
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
      [order.id]
    );

    // Log event
    await db.query(
      'INSERT INTO payment_events (order_id, event_type, event_data) VALUES (?, ?, ?)',
      [order.id, 'payment_auto_matched', JSON.stringify({
        confidence: matchResult.confidence,
        matchType: matchResult.matchType,
        paymentData
      })]
    );

    console.log(`✅ Payment matched to order ${order.reference_number} (${matchResult.confidence}% confidence)`);

    // Send confirmation email
    if (process.env.EMAIL_ENABLED === 'true' && order.customer_email) {
      await sendPaymentConfirmation({
        email: order.customer_email,
        name: order.customer_name,
        orderNumber: order.reference_number,
        amount: (order.amount_cents / 100).toFixed(2)
      });
    }

    return { success: true, order, matchResult };

  } else if (matchResult.order && matchResult.confidence >= 50) {
    // Low confidence - flag for review but don't auto-confirm
    console.log(`⚠️ Low confidence match (${matchResult.confidence}%) - flagged for review`);

    await db.query(
      'INSERT INTO payment_events (order_id, event_type, event_data) VALUES (?, ?, ?)',
      [matchResult.order.id, 'payment_needs_review', JSON.stringify({
        confidence: matchResult.confidence,
        matchType: matchResult.matchType,
        paymentData
      })]
    );

    // Alert admin
    await sendAdminAlert({
      type: 'warning',
      title: 'Payment Needs Review',
      message: `Payment of $${paymentData.amount} received but needs manual confirmation.`,
      details: { paymentData, matchResult }
    });

    return { success: false, needsReview: true, matchResult };

  } else {
    // No match - log as unmatched
    console.log(`❌ No matching order found for payment of $${paymentData.amount}`);

    await db.query(
      `INSERT INTO unmatched_payments 
        (amount_cents, sender_email, sender_name, reference_code, reason, raw_text) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        paymentData.amountCents,
        paymentData.senderEmail,
        paymentData.senderName,
        paymentData.referenceCode,
        matchResult.matchType,
        JSON.stringify(paymentData)
      ]
    );

    // Alert admin
    await sendAdminAlert({
      type: 'error',
      title: 'Unmatched Payment',
      message: `Payment of $${paymentData.amount} could not be matched to any order.`,
      details: paymentData
    });

    return { success: false, unmatched: true, paymentData };
  }
}

// ===================================
// CHECK INBOX
// ===================================

async function checkInbox() {
  return new Promise((resolve, reject) => {
    const imap = createImapConnection();

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        if (err) {
          imap.end();
          return reject(err);
        }

        // Search for unread emails from last 24 hours
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const searchCriteria = ['UNSEEN', ['SINCE', yesterday]];

        imap.search(searchCriteria, (err, results) => {
          if (err) {
            imap.end();
            return reject(err);
          }

          if (!results || results.length === 0) {
            console.log('📭 No new emails');
            imap.end();
            return resolve([]);
          }

          console.log(`📬 Found ${results.length} unread email(s)`);

          const fetch = imap.fetch(results, { bodies: '', markSeen: true });
          const payments = [];

          fetch.on('message', (msg) => {
            msg.on('body', async (stream) => {
              try {
                const parsed = await simpleParser(stream);
                const bodyText = parsed.text || parsed.html || '';
                const paymentData = parseInteracEmail(bodyText);

                if (paymentData.isInterac && paymentData.amountCents) {
                  payments.push(paymentData);
                }
              } catch (parseError) {
                console.error('Email parse error:', parseError.message);
              }
            });
          });

          fetch.once('error', (err) => {
            console.error('Fetch error:', err);
          });

          fetch.once('end', async () => {
            imap.end();

            // Process found payments
            for (const payment of payments) {
              await processPayment(payment);
            }

            resolve(payments);
          });
        });
      });
    });

    imap.once('error', (err) => {
      console.error('IMAP error:', err);
      reject(err);
    });

    imap.connect();
  });
}

// ===================================
// START/STOP SERVICE
// ===================================

function startPaymentChecker(intervalMinutes = 2) {
  if (process.env.IMAP_ENABLED !== 'true') {
    console.log('⚠️ Payment checker disabled');
    return;
  }

  if (!process.env.IMAP_HOST || !process.env.IMAP_USER || !process.env.IMAP_PASS) {
    console.error('❌ IMAP not configured. Set IMAP_HOST, IMAP_USER, and IMAP_PASS');
    return;
  }

  console.log(`📧 Starting payment checker (every ${intervalMinutes} minutes)`);

  // Initial check
  checkInbox().catch(err => console.error('Initial check error:', err));

  // Set interval
  checkInterval = setInterval(() => {
    checkInbox().catch(err => console.error('Payment check error:', err));
  }, intervalMinutes * 60 * 1000);
}

function stopPaymentChecker() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
    console.log('📧 Payment checker stopped');
  }
}

// ===================================
// EXPORTS
// ===================================

module.exports = {
  startPaymentChecker,
  stopPaymentChecker,
  checkInbox,
  parseInteracEmail,
  processPayment
};
