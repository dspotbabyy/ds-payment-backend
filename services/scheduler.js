/**
 * Scheduler Service
 * Handles scheduled tasks like daily cleanup, reports, and reminders
 */

const db = require('../config/database');
const { sendAdminAlert } = require('./notifications');

let dailyTasksInterval = null;

// ===================================
// SCHEDULED TASKS
// ===================================

async function cleanupExpiredOrders() {
  try {
    // Find orders that are pending and expired (older than 24 hours)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const result = await db.query(
      `UPDATE orders 
       SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP 
       WHERE status = 'pending' 
         AND created_at < ?`,
      [oneDayAgo]
    );

    const count = result?.changes || 0;
    if (count > 0) {
      console.log(`🧹 Cancelled ${count} expired order(s)`);
    }

    return count;
  } catch (error) {
    console.error('Cleanup error:', error);
    return 0;
  }
}

async function resetDailyLimits() {
  try {
    // Reset daily totals for email aliases
    await db.query('UPDATE email_aliases SET daily_total_cents = 0');
    console.log('🔄 Daily limits reset');
  } catch (error) {
    console.error('Reset daily limits error:', error);
  }
}

async function generateDailyReport() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Get yesterday's stats
    const stats = await db.get(`
      SELECT 
        COUNT(*) as total_orders,
        SUM(CASE WHEN status = 'paid' OR status = 'completed' THEN 1 ELSE 0 END) as paid_orders,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_orders,
        SUM(CASE WHEN status = 'paid' OR status = 'completed' THEN amount_cents ELSE 0 END) as total_revenue
      FROM orders 
      WHERE DATE(created_at) = ?
    `, [yesterday]);

    const unmatched = await db.get(`
      SELECT COUNT(*) as count 
      FROM unmatched_payments 
      WHERE resolved = 0
    `);

    const report = {
      date: yesterday,
      totalOrders: stats?.total_orders || 0,
      paidOrders: stats?.paid_orders || 0,
      cancelledOrders: stats?.cancelled_orders || 0,
      totalRevenue: stats?.total_revenue ? (stats.total_revenue / 100).toFixed(2) : '0.00',
      conversionRate: stats?.total_orders > 0 
        ? ((stats.paid_orders / stats.total_orders) * 100).toFixed(1) + '%'
        : '0%',
      unmatchedPayments: unmatched?.count || 0
    };

    console.log('📊 Daily Report:', report);

    // Send report to admin
    if (process.env.EMAIL_ENABLED === 'true') {
      await sendAdminAlert({
        type: 'info',
        title: `Daily Report - ${yesterday}`,
        message: `
Orders: ${report.totalOrders}
Paid: ${report.paidOrders}
Cancelled: ${report.cancelledOrders}
Revenue: $${report.totalRevenue} CAD
Conversion: ${report.conversionRate}
Unmatched Payments: ${report.unmatchedPayments}
        `.trim(),
        details: report
      });
    }

    return report;
  } catch (error) {
    console.error('Daily report error:', error);
    return null;
  }
}

async function retryFailedWebhooks() {
  try {
    const failures = await db.query(`
      SELECT * FROM webhook_failures 
      WHERE resolved = 0 AND retry_count < 5
      ORDER BY created_at ASC
      LIMIT 10
    `);

    for (const failure of failures) {
      try {
        const payload = JSON.parse(failure.payload);
        
        // Attempt to resend webhook
        const response = await fetch(failure.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: failure.payload
        });

        if (response.ok) {
          await db.query(
            'UPDATE webhook_failures SET resolved = 1 WHERE id = ?',
            [failure.id]
          );
          console.log(`✅ Webhook retry successful: ${failure.id}`);
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
      } catch (retryError) {
        await db.query(
          'UPDATE webhook_failures SET retry_count = retry_count + 1, last_retry_at = CURRENT_TIMESTAMP WHERE id = ?',
          [failure.id]
        );
        console.log(`❌ Webhook retry failed: ${failure.id} - ${retryError.message}`);
      }
    }
  } catch (error) {
    console.error('Retry webhooks error:', error);
  }
}

// ===================================
// RUN ALL DAILY TASKS
// ===================================

async function runDailyTasks() {
  console.log('⏰ Running daily tasks...');
  
  await cleanupExpiredOrders();
  await resetDailyLimits();
  await generateDailyReport();
  await retryFailedWebhooks();
  
  console.log('✅ Daily tasks completed');
}

// ===================================
// SCHEDULER INITIALIZATION
// ===================================

function initializeScheduler() {
  // Calculate time until next midnight
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const msUntilMidnight = midnight.getTime() - now.getTime();

  console.log(`⏰ Scheduler initialized - next daily run in ${Math.round(msUntilMidnight / 1000 / 60)} minutes`);

  // Schedule first run at midnight
  setTimeout(() => {
    runDailyTasks();
    
    // Then run every 24 hours
    dailyTasksInterval = setInterval(runDailyTasks, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);

  // Also run cleanup every hour for expired orders
  setInterval(cleanupExpiredOrders, 60 * 60 * 1000);
}

function stopScheduler() {
  if (dailyTasksInterval) {
    clearInterval(dailyTasksInterval);
    dailyTasksInterval = null;
  }
}

// ===================================
// EXPORTS
// ===================================

module.exports = {
  initializeScheduler,
  stopScheduler,
  runDailyTasks,
  cleanupExpiredOrders,
  resetDailyLimits,
  generateDailyReport,
  retryFailedWebhooks
};
