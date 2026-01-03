/**
 * Email Rotation Service
 * Rotates payment emails every 20 orders
 * Auto-skips disabled emails
 */

const db = require('../config/database');

const ORDERS_PER_ROTATION = 20;

/**
 * Get the current active payment email for a new order
 * Rotates every 20 orders, skips disabled emails
 */
async function getNextPaymentEmail() {
  try {
    // Get rotation state
    let state = await db.get(
      "SELECT * FROM rotation_state WHERE id = 1"
    );

    // Initialize if doesn't exist
    if (!state) {
      await db.query(`
        INSERT INTO rotation_state (id, current_alias_id, order_count)
        VALUES (1, NULL, 0)
      `);
      state = { current_alias_id: null, order_count: 0 };
    }

    // Get all active aliases ordered by ID
    const aliases = await db.query(`
      SELECT * FROM email_aliases 
      WHERE active = 1 
      ORDER BY id ASC
    `);

    if (aliases.length === 0) {
      console.log('⚠️ No active email aliases found, using default');
      return {
        email: process.env.DEFAULT_PAYMENT_EMAIL,
        name: process.env.RECIPIENT_NAME,
        alias_id: null
      };
    }

    let currentAliasId = state.current_alias_id;
    let orderCount = state.order_count || 0;

    // If no current alias, start with first one
    if (!currentAliasId) {
      currentAliasId = aliases[0].id;
    }

    // Check if we need to rotate (every 20 orders)
    if (orderCount >= ORDERS_PER_ROTATION) {
      // Find current alias index
      const currentIndex = aliases.findIndex(a => a.id === currentAliasId);
      
      // Move to next alias (wrap around if at end)
      const nextIndex = (currentIndex + 1) % aliases.length;
      currentAliasId = aliases[nextIndex].id;
      orderCount = 0;

      console.log(`🔄 Rotated to next email alias (ID: ${currentAliasId})`);
    }

    // Get the current alias
    let currentAlias = aliases.find(a => a.id === currentAliasId);

    // If current alias not found (was disabled), get first active one
    if (!currentAlias) {
      currentAlias = aliases[0];
      currentAliasId = currentAlias.id;
      orderCount = 0;
      console.log(`⚠️ Previous alias disabled, switched to ${currentAlias.alias_email}`);
    }

    // Increment order count
    orderCount++;

    // Update rotation state
    await db.query(`
      UPDATE rotation_state 
      SET current_alias_id = ?, order_count = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `, [currentAliasId, orderCount]);

    // Update last_used_at for this alias
    await db.query(`
      UPDATE email_aliases 
      SET last_used_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [currentAliasId]);

    console.log(`📧 Using email: ${currentAlias.alias_email} (Order ${orderCount}/${ORDERS_PER_ROTATION})`);

    return {
      email: currentAlias.alias_email,
      name: currentAlias.bank_name || process.env.RECIPIENT_NAME,
      alias_id: currentAlias.id,
      bank_slug: currentAlias.bank_slug,
      orders_until_rotation: ORDERS_PER_ROTATION - orderCount
    };

  } catch (error) {
    console.error('❌ Rotation error:', error.message);
    // Fallback to default
    return {
      email: process.env.DEFAULT_PAYMENT_EMAIL,
      name: process.env.RECIPIENT_NAME,
      alias_id: null
    };
  }
}

/**
 * Get current rotation status
 */
async function getRotationStatus() {
  try {
    const state = await db.get("SELECT * FROM rotation_state WHERE id = 1");
    const aliases = await db.query(`
      SELECT * FROM email_aliases WHERE active = 1 ORDER BY id ASC
    `);
    const totalAliases = await db.query(`SELECT COUNT(*) as count FROM email_aliases`);

    if (!state || aliases.length === 0) {
      return {
        active: false,
        message: 'No aliases configured',
        aliases_count: 0
      };
    }

    const currentAlias = aliases.find(a => a.id === state.current_alias_id);

    return {
      active: true,
      current_email: currentAlias?.alias_email || 'None',
      current_bank: currentAlias?.bank_name || 'Unknown',
      orders_on_current: state.order_count,
      orders_until_rotation: ORDERS_PER_ROTATION - state.order_count,
      orders_per_rotation: ORDERS_PER_ROTATION,
      total_aliases: totalAliases[0]?.count || 0,
      active_aliases: aliases.length,
      rotation_order: aliases.map((a, i) => ({
        position: i + 1,
        email: a.alias_email,
        bank: a.bank_name,
        is_current: a.id === state.current_alias_id
      }))
    };
  } catch (error) {
    return { active: false, error: error.message };
  }
}

/**
 * Force rotate to next email (admin function)
 */
async function forceRotate() {
  try {
    const aliases = await db.query(`
      SELECT * FROM email_aliases WHERE active = 1 ORDER BY id ASC
    `);

    if (aliases.length === 0) {
      return { success: false, message: 'No active aliases' };
    }

    const state = await db.get("SELECT * FROM rotation_state WHERE id = 1");
    
    const currentIndex = aliases.findIndex(a => a.id === state?.current_alias_id);
    const nextIndex = (currentIndex + 1) % aliases.length;
    const nextAlias = aliases[nextIndex];

    await db.query(`
      UPDATE rotation_state 
      SET current_alias_id = ?, order_count = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `, [nextAlias.id]);

    return {
      success: true,
      message: `Rotated to ${nextAlias.alias_email}`,
      new_email: nextAlias.alias_email,
      new_bank: nextAlias.bank_name
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Reset rotation to first alias
 */
async function resetRotation() {
  try {
    const firstAlias = await db.get(`
      SELECT * FROM email_aliases WHERE active = 1 ORDER BY id ASC LIMIT 1
    `);

    await db.query(`
      UPDATE rotation_state 
      SET current_alias_id = ?, order_count = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `, [firstAlias?.id || null]);

    return {
      success: true,
      message: 'Rotation reset',
      current_email: firstAlias?.alias_email || 'None'
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  getNextPaymentEmail,
  getRotationStatus,
  forceRotate,
  resetRotation,
  ORDERS_PER_ROTATION
};
