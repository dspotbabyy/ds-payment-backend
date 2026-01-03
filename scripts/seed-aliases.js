/**
 * Seed Email Aliases
 * 
 * Run this script to add your email aliases for rotation.
 * Edit the aliases array below with your actual email addresses.
 * 
 * Usage: node scripts/seed-aliases.js
 */

require('dotenv').config();
const db = require('../config/database');

// ============================================
// EDIT THIS SECTION WITH YOUR EMAIL ALIASES
// ============================================

const aliases = [
  {
    alias_email: 'payments-td@yourstore.com',    // Email address (forwarded from main)
    bank_name: 'TD Canada Trust',                 // Bank name (for your reference)
    bank_slug: 'td',                              // Short code
    daily_cap: 3000,                              // Daily limit in dollars ($3000)
    weight: 10                                    // Higher weight = used first
  },
  {
    alias_email: 'payments-rbc@yourstore.com',
    bank_name: 'RBC Royal Bank',
    bank_slug: 'rbc',
    daily_cap: 3000,
    weight: 10
  },
  {
    alias_email: 'payments-bmo@yourstore.com',
    bank_name: 'BMO Bank of Montreal',
    bank_slug: 'bmo',
    daily_cap: 3000,
    weight: 5                                     // Lower weight = backup
  }
  // Add more aliases as needed...
];

// ============================================
// DON'T EDIT BELOW THIS LINE
// ============================================

async function seedAliases() {
  try {
    console.log('🗄️  Initializing database...');
    await db.initialize();
    console.log('✅ Database ready\n');

    console.log('📧 Adding email aliases...\n');

    for (const alias of aliases) {
      try {
        const sql = `
          INSERT INTO email_aliases 
            (alias_email, bank_name, bank_slug, daily_cap_cents, weight, active)
          VALUES (?, ?, ?, ?, ?, 1)
        `;
        
        await db.query(sql, [
          alias.alias_email.toLowerCase().trim(),
          alias.bank_name,
          alias.bank_slug,
          alias.daily_cap * 100, // Convert to cents
          alias.weight
        ]);

        console.log(`   ✅ Added: ${alias.alias_email}`);
        console.log(`      Bank: ${alias.bank_name}`);
        console.log(`      Daily Cap: $${alias.daily_cap}`);
        console.log(`      Weight: ${alias.weight}\n`);

      } catch (error) {
        if (error.message.includes('UNIQUE') || error.message.includes('duplicate')) {
          console.log(`   ⚠️  Skipped (already exists): ${alias.alias_email}\n`);
        } else {
          console.error(`   ❌ Error adding ${alias.alias_email}:`, error.message, '\n');
        }
      }
    }

    // Show summary
    const allAliases = await db.query('SELECT * FROM email_aliases ORDER BY weight DESC');
    
    console.log('\n═══════════════════════════════════════');
    console.log('📊 CURRENT EMAIL ALIASES');
    console.log('═══════════════════════════════════════\n');

    let totalCap = 0;
    for (const a of allAliases) {
      const cap = a.daily_cap_cents / 100;
      totalCap += cap;
      console.log(`${a.active ? '🟢' : '🔴'} ${a.alias_email}`);
      console.log(`   Bank: ${a.bank_name || 'Not specified'}`);
      console.log(`   Daily Cap: $${cap.toFixed(2)}`);
      console.log(`   Weight: ${a.weight}`);
      console.log('');
    }

    console.log('───────────────────────────────────────');
    console.log(`Total Aliases: ${allAliases.length}`);
    console.log(`Total Daily Capacity: $${totalCap.toFixed(2)}`);
    console.log('───────────────────────────────────────\n');

    console.log('✅ Done! Your email aliases are ready.\n');

    await db.close();
    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

seedAliases();
