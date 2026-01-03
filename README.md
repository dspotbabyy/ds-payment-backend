# DS Payment Gateway - Backend API

A complete Node.js backend for processing Interac e-Transfer payments with WooCommerce integration.

## 🚀 Features

- **Order Management** - Create, track, and manage payment orders
- **Automatic Payment Detection** - IMAP monitoring for Interac e-Transfer notifications
- **Smart Payment Matching** - Priority-based matching with confidence scoring
- **WooCommerce Integration** - Webhooks and API for seamless integration
- **Email Notifications** - Automated customer and admin notifications
- **Fraud Prevention** - Blacklist and velocity checks
- **Multi-Database Support** - SQLite (dev) and PostgreSQL (production)

## 📋 Requirements

- Node.js 18+
- npm or yarn
- SQLite (development) or PostgreSQL (production)
- Email account with IMAP access (for payment detection)
- SMTP credentials (for sending notifications)

## 🛠️ Quick Start

### 1. Clone/Download

```bash
git clone https://github.com/your-username/ds-payment-backend.git
cd ds-payment-backend
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
# Minimum required settings
DEFAULT_PAYMENT_EMAIL=payments@yourstore.com
RECIPIENT_NAME=Your Store

# For email notifications
EMAIL_ENABLED=true
SMTP_HOST=smtp.fastmail.com
SMTP_USER=your-email@fastmail.com
SMTP_PASS=your-app-password

# For automatic payment detection
IMAP_ENABLED=true
IMAP_HOST=imap.fastmail.com
IMAP_USER=your-email@fastmail.com
IMAP_PASS=your-app-password
```

### 4. Run

```bash
# Development
npm run dev

# Production
npm start
```

Server runs at `http://localhost:3000`

## 📡 API Endpoints

### Orders

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/orders` | Create new order |
| GET | `/api/orders/:id` | Get order by ID |
| GET | `/api/orders/reference/:ref` | Get order by reference |
| PUT | `/api/orders/:id/status` | Update order status |
| GET | `/api/orders` | List orders (paginated) |
| DELETE | `/api/orders/:id` | Delete order |

### Webhooks

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/webhooks/woocommerce` | WooCommerce order webhook |
| POST | `/api/webhooks/payment-confirmed` | Mark payment confirmed |
| POST | `/api/webhooks/payment-sent` | Customer payment intent |

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Basic health check |
| GET | `/api/health/detailed` | Detailed health check |
| GET | `/api/stats` | Order statistics |

## 🔧 WooCommerce Setup

### 1. Add Webhook in WooCommerce

Go to **WooCommerce → Settings → Advanced → Webhooks**

- **Name:** DS Payment Order Created
- **Status:** Active
- **Topic:** Order created
- **Delivery URL:** `https://your-backend.onrender.com/api/webhooks/woocommerce`
- **Secret:** (same as `WOOCOMMERCE_WEBHOOK_SECRET` in .env)

### 2. Get API Keys

Go to **WooCommerce → Settings → Advanced → REST API**

Create keys with Read/Write permissions and add to `.env`:

```env
WOOCOMMERCE_CONSUMER_KEY=ck_xxx
WOOCOMMERCE_CONSUMER_SECRET=cs_xxx
```

## ☁️ Deploy to Render.com

### 1. Create New Web Service

1. Go to [render.com](https://render.com) and create account
2. Click **New → Web Service**
3. Connect your GitHub repo (or use "Public Git repository")
4. Configure:
   - **Name:** ds-payment-backend
   - **Region:** Oregon (or closest to you)
   - **Branch:** main
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free (or Starter for always-on)

### 2. Add Environment Variables

In Render dashboard, go to **Environment** and add:

```
NODE_ENV=production
DEFAULT_PAYMENT_EMAIL=your-email
RECIPIENT_NAME=Your Store
EMAIL_ENABLED=true
SMTP_HOST=smtp.fastmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-email
SMTP_PASS=your-password
IMAP_ENABLED=true
IMAP_HOST=imap.fastmail.com
IMAP_PORT=993
IMAP_USER=your-email
IMAP_PASS=your-password
```

### 3. Add PostgreSQL (Recommended for Production)

1. In Render dashboard, click **New → PostgreSQL**
2. Create database (Free tier available)
3. Copy the **Internal Database URL**
4. Add to your web service environment:
   ```
   DATABASE_URL=postgres://...
   ```

### 4. Deploy

Click **Manual Deploy → Deploy latest commit**

Your backend will be live at: `https://ds-payment-backend.onrender.com`

## 🔐 Security Best Practices

1. **Use HTTPS** - Render provides free SSL
2. **Set strong secrets** - Use long random strings for webhook secrets
3. **Enable rate limiting** - Already configured (100 req/15min)
4. **Use app passwords** - Don't use your main email password
5. **Regular backups** - Render handles this for PostgreSQL

## 🐛 Troubleshooting

### Backend not responding
- Free tier on Render "sleeps" after 15 minutes of inactivity
- First request takes 30-60 seconds to "wake up"
- Upgrade to Starter plan ($7/mo) for always-on

### Emails not sending
- Check SMTP credentials
- Verify EMAIL_ENABLED=true
- Check spam folder
- Try using app password instead of main password

### Payments not being detected
- Verify IMAP_ENABLED=true
- Check IMAP credentials
- Ensure emails are going to monitored inbox
- Check for e-Transfer notification emails

### Database errors
- SQLite: Check write permissions on data directory
- PostgreSQL: Verify DATABASE_URL is correct

## 📁 Project Structure

```
ds-payment-backend/
├── server.js           # Main entry point
├── package.json        # Dependencies
├── .env.example        # Configuration template
├── config/
│   └── database.js     # Database configuration
├── routes/
│   ├── orders.js       # Order endpoints
│   ├── webhooks.js     # Webhook handlers
│   └── health.js       # Health checks
├── services/
│   ├── notifications.js    # Email service
│   ├── payment-checker.js  # IMAP monitoring
│   └── scheduler.js        # Scheduled tasks
└── data/
    └── orders.db       # SQLite database (dev)
```

## 📞 Support

- **Documentation:** See the full documentation package
- **Issues:** Create GitHub issue
- **Email:** your-support@email.com

## 📄 License

MIT License - feel free to use and modify.

---

**DS Payment Gateway v2.0.0** - Built for Canadian e-commerce
