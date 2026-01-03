/**
 * Notification Service
 * Handles sending emails to customers and admins
 */

const nodemailer = require('nodemailer');

// ===================================
// EMAIL TRANSPORTER SETUP
// ===================================

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  // Support multiple email providers
  const config = {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  };

  // Special handling for common providers
  if (process.env.EMAIL_SERVICE === 'gmail') {
    config.service = 'gmail';
  } else if (process.env.EMAIL_SERVICE === 'fastmail') {
    config.host = 'smtp.fastmail.com';
    config.port = 465;
    config.secure = true;
  }

  transporter = nodemailer.createTransport(config);
  return transporter;
}

// ===================================
// EMAIL TEMPLATES
// ===================================

const templates = {
  orderConfirmation: (data) => ({
    subject: `Order Confirmation - ${data.orderNumber}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #1e3a5f 0%, #2d5a87 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="margin: 0; font-size: 24px;">Order Confirmed!</h1>
        </div>
        
        <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none;">
          <p>Hi ${data.name || 'there'},</p>
          
          <p>Thank you for your order! To complete your purchase, please send an Interac e-Transfer with the following details:</p>
          
          <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e0e0e0;"><strong>Amount:</strong></td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e0e0e0; text-align: right; font-size: 20px; color: #1e3a5f;"><strong>$${data.amount} CAD</strong></td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e0e0e0;"><strong>Send to:</strong></td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e0e0e0; text-align: right;">${data.paymentEmail}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0;"><strong>Reference:</strong></td>
                <td style="padding: 10px 0; text-align: right; color: #e74c3c; font-weight: bold;">${data.orderNumber}</td>
              </tr>
            </table>
          </div>
          
          <div style="background: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0; color: #856404;">
              <strong>⚠️ Important:</strong> Please include <strong>${data.orderNumber}</strong> in your e-Transfer message so we can match your payment!
            </p>
          </div>
          
          <p><strong>How to send an Interac e-Transfer:</strong></p>
          <ol>
            <li>Log into your online banking</li>
            <li>Go to "Send Interac e-Transfer"</li>
            <li>Enter the amount: <strong>$${data.amount}</strong></li>
            <li>Enter recipient email: <strong>${data.paymentEmail}</strong></li>
            <li>Include <strong>${data.orderNumber}</strong> in the message field</li>
            <li>Confirm and send</li>
          </ol>
          
          <p>Once we receive your payment, we'll send you a confirmation email and begin processing your order.</p>
          
          <p style="color: #666; font-size: 14px;">If you have any questions, please don't hesitate to contact us.</p>
        </div>
        
        <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
          <p>This is an automated email. Please do not reply directly.</p>
        </div>
      </body>
      </html>
    `,
    text: `
Order Confirmation - ${data.orderNumber}

Hi ${data.name || 'there'},

Thank you for your order! To complete your purchase, please send an Interac e-Transfer:

Amount: $${data.amount} CAD
Send to: ${data.paymentEmail}
Reference: ${data.orderNumber}

IMPORTANT: Please include ${data.orderNumber} in your e-Transfer message!

Once we receive your payment, we'll send you a confirmation email.
    `
  }),

  paymentConfirmation: (data) => ({
    subject: `Payment Received - ${data.orderNumber}`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #27ae60 0%, #2ecc71 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="margin: 0; font-size: 24px;">✓ Payment Received!</h1>
        </div>
        
        <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none;">
          <p>Hi ${data.name || 'there'},</p>
          
          <p>Great news! We've received your payment of <strong>$${data.amount} CAD</strong> for order <strong>${data.orderNumber}</strong>.</p>
          
          <div style="background: #d4edda; border: 1px solid #28a745; padding: 15px; border-radius: 8px; margin: 20px 0; text-align: center;">
            <p style="margin: 0; color: #155724; font-size: 18px;">
              ✓ Your order is now being processed!
            </p>
          </div>
          
          <p>We'll send you another email with tracking information once your order ships.</p>
          
          <p>Thank you for your business!</p>
        </div>
        
        <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
          <p>This is an automated email. Please do not reply directly.</p>
        </div>
      </body>
      </html>
    `,
    text: `
Payment Received - ${data.orderNumber}

Hi ${data.name || 'there'},

Great news! We've received your payment of $${data.amount} CAD for order ${data.orderNumber}.

Your order is now being processed!

We'll send you tracking information once your order ships.

Thank you for your business!
    `
  }),

  adminAlert: (data) => ({
    subject: `[DS Payment] ${data.type}: ${data.title}`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2 style="color: ${data.type === 'error' ? '#e74c3c' : '#3498db'};">${data.type.toUpperCase()}: ${data.title}</h2>
        <p>${data.message}</p>
        ${data.details ? `<pre style="background: #f5f5f5; padding: 15px; border-radius: 4px;">${JSON.stringify(data.details, null, 2)}</pre>` : ''}
        <p style="color: #999; font-size: 12px;">Generated at ${new Date().toISOString()}</p>
      </div>
    `,
    text: `${data.type.toUpperCase()}: ${data.title}\n\n${data.message}\n\n${data.details ? JSON.stringify(data.details, null, 2) : ''}`
  })
};

// ===================================
// SEND FUNCTIONS
// ===================================

async function sendEmail(to, template, data) {
  if (process.env.EMAIL_ENABLED !== 'true') {
    console.log(`📧 [DISABLED] Would send ${template} to ${to}`);
    return { sent: false, reason: 'Email disabled' };
  }

  try {
    const emailContent = templates[template](data);
    const transport = getTransporter();

    const result = await transport.sendMail({
      from: `"${process.env.EMAIL_FROM_NAME || 'DS Payment'}" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
      to,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text
    });

    console.log(`✅ Email sent: ${template} to ${to}`);
    return { sent: true, messageId: result.messageId };

  } catch (error) {
    console.error(`❌ Email failed: ${template} to ${to}`, error.message);
    return { sent: false, error: error.message };
  }
}

async function sendOrderConfirmation(data) {
  return sendEmail(data.email, 'orderConfirmation', data);
}

async function sendPaymentConfirmation(data) {
  return sendEmail(data.email, 'paymentConfirmation', data);
}

async function sendAdminAlert(data) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.warn('Admin email not configured');
    return { sent: false, reason: 'Admin email not configured' };
  }
  return sendEmail(adminEmail, 'adminAlert', data);
}

// ===================================
// EXPORTS
// ===================================

module.exports = {
  sendEmail,
  sendOrderConfirmation,
  sendPaymentConfirmation,
  sendAdminAlert
};
