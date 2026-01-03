/**
 * DS Payment Gateway - Backend Server
 * Version: 2.0.0
 * 
 * A complete Node.js backend for Interac e-Transfer payment processing
 * Supports WooCommerce integration via REST API
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Import routes
const ordersRoutes = require('./routes/orders');
const webhookRoutes = require('./routes/webhooks');
const healthRoutes = require('./routes/health');
const adminRoutes = require('./routes/admin');

// Import services
const db = require('./config/database');
const { startPaymentChecker } = require('./services/payment-checker');
const { initializeScheduler } = require('./services/scheduler');

// ===================================
// EXPRESS APP SETUP
// ===================================

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Webhook-Secret']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// ===================================
// ROUTES
// ===================================

// API routes
app.use('/api/orders', ordersRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', healthRoutes);

// Root endpoint - API documentation
app.get('/', (req, res) => {
  res.json({
    name: 'DS Payment Gateway API',
    version: '2.0.0',
    description: 'Backend API for Interac e-Transfer payment processing',
    endpoints: {
      orders: {
        'POST /api/orders': 'Create a new order',
        'GET /api/orders/:id': 'Get order by ID',
        'GET /api/orders/reference/:ref': 'Get order by reference number',
        'PUT /api/orders/:id/status': 'Update order status',
        'GET /api/orders': 'List all orders (with pagination)'
      },
      webhooks: {
        'POST /api/webhooks/woocommerce': 'Receive WooCommerce order webhook',
        'POST /api/webhooks/payment-confirmed': 'Mark payment as confirmed'
      },
      health: {
        'GET /api/health': 'Health check',
        'GET /api/health/detailed': 'Detailed health check'
      }
    },
    documentation: 'https://github.com/your-repo/ds-payment-gateway'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ===================================
// SERVER STARTUP
// ===================================

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    // Initialize database
    console.log('🗄️  Initializing database...');
    await db.initialize();
    console.log('✅ Database ready');

    // Start payment checker (IMAP monitoring)
    if (process.env.IMAP_ENABLED === 'true') {
      console.log('📧 Starting payment checker...');
      startPaymentChecker();
      console.log('✅ Payment checker running');
    } else {
      console.log('⚠️  Payment checker disabled (set IMAP_ENABLED=true to enable)');
    }

    // Initialize scheduler for daily tasks
    initializeScheduler();
    console.log('⏰ Scheduler initialized');

    // Start server
    app.listen(PORT, () => {
      console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🚀 DS Payment Gateway Server Started                       ║
║                                                               ║
║   📍 URL:      http://localhost:${PORT.toString().padEnd(29)}║
║   🌍 ENV:      ${(process.env.NODE_ENV || 'development').padEnd(41)}║
║   💾 Database: ${(process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite').padEnd(41)}║
║   📧 IMAP:     ${(process.env.IMAP_ENABLED === 'true' ? 'Enabled' : 'Disabled').padEnd(41)}║
║                                                               ║
║   Endpoints:                                                  ║
║   • GET  /                     - API Documentation           ║
║   • POST /api/orders           - Create Order                ║
║   • GET  /api/orders/:id       - Get Order                   ║
║   • POST /api/webhooks/*       - Webhook Handlers            ║
║   • GET  /api/health           - Health Check                ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
      `);
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('📴 Shutting down gracefully...');
  await db.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('📴 Shutting down gracefully...');
  await db.close();
  process.exit(0);
});

// Start the server
startServer();

module.exports = app;
