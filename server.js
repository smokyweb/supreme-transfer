// COMPLETE CASHFLOW SERVER WITH INSTANT PAYOUTS & WALLET CREDITS
console.log('Starting Supreme Transfer Server with Instant Payouts & Wallet Credits...');

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// STRIPE CONFIGURATION
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  console.log('Stripe connected successfully');
} else {
  console.log('WARNING: STRIPE_SECRET_KEY not set');
}

// In-memory cache for Stripe account status
const stripeAccountCache = {};

// Middleware
app.use(cors());

// Stripe webhook — must use raw body BEFORE express.json()
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    try {
      await pool.query(
        "UPDATE transactions SET status = 'failed' WHERE metadata->>'payment_intent_id' = $1",
        [pi.id]
      );
      console.log(`Marked transaction failed for payment_intent ${pi.id}`);
    } catch (err) {
      console.error('Webhook: failed to update transaction status:', err.message);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
// Serve index.html with no-cache headers to prevent stale UI
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/index.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.use(express.static('.'));

// Token functions
function createToken(userId, email) {
  const data = JSON.stringify({ userId, email, exp: Date.now() + 7*24*60*60*1000 });
  return Buffer.from(data).toString('base64');
}

function verifyToken(token) {
  try {
    const data = JSON.parse(Buffer.from(token, 'base64').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const data = token ? verifyToken(token) : null;
  if (!data) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = data.userId;
  req.userEmail = data.email;
  req.name = data.name;
  next();
};

// ============= ADMIN AUTHENTICATION & HELPERS =============

// JWT Secret for admin tokens
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex').substring(0, 32);

// Encrypt sensitive data (for Stripe keys)
function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

// Decrypt sensitive data
function decrypt(text) {
  if (!text) return '';
  try {
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift(), 'hex');
    const encryptedText = Buffer.from(parts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (error) {
    console.error('Decryption error:', error);
    return '';
  }
}

// Admin authentication middleware
async function verifyAdmin(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const decoded = jwt.verify(token, JWT_SECRET);
    
    const result = await pool.query(
      'SELECT id, username, email, full_name, role FROM admin_users WHERE id = $1 AND is_active = true',
      [decoded.adminId]
    );

    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid token' });

    req.admin = result.rows[0];
    next();
  } catch (error) {
    console.error('Admin auth error:', error);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Log admin activity
async function logActivity(adminId, action, targetType = null, targetId = null, details = {}, ipAddress = null) {
  try {
    await pool.query(
      `INSERT INTO admin_activity_log (admin_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [adminId, action, targetType, targetId, JSON.stringify(details), ipAddress]
    );
  } catch (error) {
    console.error('Error logging activity:', error);
  }
}

// ============= DATABASE SETUP =============

async function createPlatformAdvanceTables() {
  try {
    // Create platform_advances table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_advances (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        amount INTEGER NOT NULL,
        fee INTEGER NOT NULL,
        net_amount INTEGER NOT NULL,
        status VARCHAR(50) DEFAULT 'advanced',
        stripe_account_id VARCHAR(255),
        advanced_at TIMESTAMP DEFAULT NOW(),
        reconciled_at TIMESTAMP,
        metadata JSONB
      )
    `);
    
    // Add platform_credit column to wallets if not exists
    await pool.query(`
      ALTER TABLE wallets 
      ADD COLUMN IF NOT EXISTS platform_credit INTEGER DEFAULT 0
    `).catch(() => {}); // Ignore if column exists
    
    console.log('Platform advance tables ready');
  } catch (error) {
    console.error('Error creating platform advance tables:', error);
  }
}

async function createWalletsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS wallets (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(50) UNIQUE NOT NULL,
        balance INTEGER DEFAULT 0,
        platform_credit INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Wallets table ready');
  } catch (error) {
    console.error('Error creating wallets table:', error);
  }
}

async function createInvitationsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS invitations (
        id SERIAL PRIMARY KEY,
        code VARCHAR(100) UNIQUE NOT NULL,
        inviter_id VARCHAR(50),
        invitee_email VARCHAR(255) NOT NULL,
        invitee_id VARCHAR(50),
        message TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        accepted_at TIMESTAMP,
        registered_at TIMESTAMP
      )
    `);
    console.log('Invitations table ready');
  } catch (error) {
    console.error('Error creating invitations table:', error);
  }
}

async function migratePasswordColumn() {
  try {
    // Check for both password and password_hash columns
    const result = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'users' AND column_name IN ('password', 'password_hash')
    `);

    const columns = result.rows.map(row => row.column_name);
    const hasPassword = columns.includes('password');
    const hasPasswordHash = columns.includes('password_hash');

    if (hasPassword && hasPasswordHash) {
      // Both columns exist - drop password_hash and keep password
      console.log('⚠️  Found both password and password_hash columns - removing password_hash...');
      await pool.query(`ALTER TABLE users DROP COLUMN password_hash`);
      console.log('✅ Removed duplicate password_hash column');
    } else if (hasPasswordHash && !hasPassword) {
      // Only password_hash exists - rename to password
      console.log('⚠️  Found password_hash column - migrating to password...');
      await pool.query(`ALTER TABLE users RENAME COLUMN password_hash TO password`);
      console.log('✅ Password column migrated successfully!');
    } else if (hasPassword) {
      // Only password exists - already migrated
      console.log('✅ Password column already migrated (using "password")');
    }
  } catch (error) {
    console.error('❌ Error migrating password column:', error);
    throw error; // Re-throw to prevent server from starting
  }
}

async function addUsernameColumn() {
  try {
    // Check if username column exists
    const result = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'username'
    `);

    if (result.rows.length === 0) {
      console.log('Adding username column to users table...');
      await pool.query(`
        ALTER TABLE users
        ADD COLUMN username VARCHAR(50) UNIQUE
      `);
      console.log('✅ Username column added successfully');
    } else {
      console.log('✅ Username column already exists');
    }
  } catch (error) {
    console.error('Error adding username column:', error);
  }
}

async function createContactsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        contact_user_id VARCHAR(50) NOT NULL,
        display_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, contact_user_id)
      )
    `);
    console.log('Contacts table ready');
  } catch (error) {
    console.error('Error creating contacts table:', error);
  }
}

async function createPaymentRequestsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payment_requests (
        id SERIAL PRIMARY KEY,
        requester_id VARCHAR(50) NOT NULL,
        requestee_id VARCHAR(50) NOT NULL,
        amount INTEGER NOT NULL,
        message TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        responded_at TIMESTAMP
      )
    `);
    console.log('Payment requests table ready');
  } catch (error) {
    console.error('Error creating payment_requests table:', error);
  }
}

async function createSystemSettingsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        id SERIAL PRIMARY KEY,
        setting_key VARCHAR(255) UNIQUE NOT NULL,
        setting_value TEXT,
        setting_type VARCHAR(50) DEFAULT 'string',
        updated_by INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Seed default fee settings if they don't exist
    const defaults = [
      ['user_transfer_fee_pct', '5', 'string'],
      ['user_transfer_fee_min', '100', 'string'],
      ['cashout_fee_pct', '5', 'string'],
      ['cashout_fee_min', '100', 'string'],
      ['pass_stripe_fee_to_user', 'true', 'string'],
      ['instant_payout_fee_percent', '1.5', 'string'],
      ['standard_cashout_fee_percent', '0', 'string'],
      ['standard_cashout_enabled', 'true', 'string'],
      ['instant_payout_enabled', 'true', 'string'],
      ['payment_request_fee_pct', '5', 'string'],
      ['payment_request_fee_min', '100', 'string']
    ];
    for (const [key, value, type] of defaults) {
      await pool.query(
        `INSERT INTO system_settings (setting_key, setting_value, setting_type)
         VALUES ($1, $2, $3)
         ON CONFLICT (setting_key) DO NOTHING`,
        [key, value, type]
      );
    }
    console.log('System settings table ready');
  } catch (error) {
    console.error('Error creating system_settings table:', error);
  }
}

async function createAdminWithdrawalsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_withdrawals (
        id SERIAL PRIMARY KEY,
        amount INTEGER NOT NULL,
        note TEXT,
        withdrawn_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Admin withdrawals table ready');
  } catch (error) {
    console.error('Error creating admin_withdrawals table:', error);
  }
}

async function setupEmailVerification() {
  try {
    // Add email_verified column — DEFAULT true so existing users keep access
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT true
    `);
    // Create verification codes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_verification_codes (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        code VARCHAR(10) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Email verification tables ready');
  } catch (error) {
    console.error('Error setting up email verification:', error);
  }
}

// Call on server start - wrap in async initialization
async function initializeDatabase() {
  console.log('Initializing database...');
  await createSystemSettingsTable();
  await createPlatformAdvanceTables();
  await createWalletsTable();
  await createInvitationsTable();
  await migratePasswordColumn();
  await addUsernameColumn();
  await createContactsTable();
  await createPaymentRequestsTable();
  await createAdminWithdrawalsTable();
  await setupEmailVerification();
  console.log('Database initialization complete!');
}

// ============= STRIPE WALLET FUNCTIONS =============

// Get or create Connected Account for user
async function getOrCreateConnectedAccount(userId, email) {
  try {
    // Check if user has a connected account
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [userId]
    );
    
    let accountId = userResult.rows[0]?.stripe_account_id;
    
    if (!accountId) {
      console.log(`Creating Connected Account for ${email}`);
      
      // Create a new Connected Account with prefilled business information
      // payout_schedule: manual — no automatic payouts; user must explicitly cash out
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'US',
        email: email,
        business_type: 'individual',
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        },
        business_profile: {
          mcc: '7372',
          url: 'https://supremetransfer.bluesapps.com',
          product_description: 'Individual payment services via Supreme Transfer'
        },
        settings: {
          payouts: {
            schedule: { interval: 'manual' }
          }
        },
        metadata: {
          user_id: userId
        }
      });
      
      accountId = account.id;
      console.log(`Created Connected Account: ${accountId}`);
      
      // Save to database
      await pool.query(
        'UPDATE users SET stripe_account_id = $1 WHERE id = $2',
        [accountId, userId]
      );
    }
    
    return accountId;
  } catch (error) {
    console.error('Connected Account error:', error);
    throw error;
  }
}

// Get Connected Account balance
async function getConnectedAccountBalance(accountId) {
  try {
    const balance = await stripe.balance.retrieve({
      stripeAccount: accountId
    });
    
    const available = balance.available.reduce((sum, bal) => {
      return bal.currency === 'usd' ? sum + bal.amount : sum;
    }, 0);
    
    const pending = balance.pending.reduce((sum, bal) => {
      return bal.currency === 'usd' ? sum + bal.amount : sum;
    }, 0);
    
    return { available, pending };
  } catch (error) {
    console.error('Balance fetch error:', error);
    return { available: 0, pending: 0 };
  }
}

// ============= AUTH ROUTES =============

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    const user = result.rows[0];

    // Block unverified users (email_verified = false); allow if true or NULL (legacy users)
    if (user.email_verified === false) {
      return res.status(403).json({ error: 'Email not verified', requiresVerification: true, email: user.email });
    }

    const token = createToken(user.id, user.email);
    
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        stripe_account_id: user.stripe_account_id
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/app_login', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    const user = result.rows[0];

    // Block unverified users
    if (user.email_verified === false) {
      return res.status(403).json({ error: 'Email not verified', requiresVerification: true, email: user.email });
    }

    // Check password (plaintext for legacy, bcrypt for new users)
    let passwordValid = false;
    if (user.password && user.password.startsWith('$2')) {
      passwordValid = await bcrypt.compare(password, user.password);
    } else {
      passwordValid = user.password === password;
    }
    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    const token = createToken(user.id, user.email);
    
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        stripe_account_id: user.stripe_account_id
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/forget', async (req, res) => {
  const { email } = req.body;
  
  // try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    } else {
      const min = 1000; // Smallest 6-digit number
      const max = 9999; // Largest 6-digit number
      const otp= Math.floor(Math.random() * (max - min + 1)) + min;
      const user=result.rows[0];
      await pool.query('UPDATE users SET otp = $1 WHERE email = $2', [otp,user.email]);
      await mailgunTransporter.sendMail({
        from: 'Zoompay App <invite@bluestoneapps.com>',
        to: user.email,
        subject: `${user.name || user.email} Forget Password OTP! 🎉`,
        html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; padding: 30px; text-align: center; border-radius: 10px; }
            .content { padding: 30px; background: white; }
            .button { color:white; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 10px; display: inline-block; font-weight: 600; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="content">
              <p><strong>Hi ${user.name || user.email}</strong> (${user.email})!</p>
              <p>Here is OTP code  for Reset Password</p>
              <div style="text-align: center;" >
                <div  class="button">${otp}</div>
              </div>
            </div>
          </div>
        </body>
        </html>`.trim()
      }).catch(err => console.error('Failed to send inviter notification:', err));
      res.json({'message':`Notified User  ${user.email} Forget Password  OTP`, email :user.email });
    }  
  // } catch (error) {
  //   res.status(500).json({ error: 'Login failed' });
  // }
});

app.post('/api/auth/verify_otp', async (req, res) => {
  const { email, otp } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1 and otp = $2', [email.toLowerCase(),otp]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid OTP / User' });
    }    
    const user = result.rows[0];    
    res.json({email:user.email,message:'OTP Verfied'});
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/reset_password', async (req, res) => {
  const { email, password } = req.body;
  try {
    const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{8,}$/;
    if (!password || !strongPasswordRegex.test(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters with uppercase, lowercase, number, and special character.' });
    }
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid User' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'UPDATE users SET password = $1, otp = NULL WHERE email = $2', 
      [hashedPassword, email]
    );
    res.json({ email: email, message: 'Password reset successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Reset failed' });
  }
});

app.post('/api/auth/registerAppUser', async (req, res) => {
  const { email, password, name, inviteCode,username } = req.body;

  try {

    const checking_user = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    
    if (checking_user.rows.length > 0) {
      return res.status(401).json({ error: 'username already exist' });
    }

    // Enforce strong password
    const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{8,}$/;
    if (!password || !strongPasswordRegex.test(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters with uppercase, lowercase, number, and special character.' });
    }

    const userId = 'user_' + Date.now();
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (id, email, password, name, username, email_verified) VALUES ($1, $2, $3, $4, $5, false) RETURNING *',
      [userId, email.toLowerCase(), hashedPassword, name || email.split('@')[0], username]
    );

    const user = result.rows[0];

    // Create wallet record
    await pool.query('INSERT INTO wallets (user_id, balance) VALUES ($1, 0)', [user.id]);

    // Handle invite code if provided
    if (inviteCode) {
      try {
        const inviteResult = await pool.query(
          'SELECT * FROM invitations WHERE code = $1 AND status = $2',
          [inviteCode, 'pending']
        );

        if (inviteResult.rows.length > 0) {
          const invitation = inviteResult.rows[0];

          // Update invitation status
          await pool.query(
            'UPDATE invitations SET status = $1, invitee_id = $2, registered_at = NOW() WHERE code = $3',
            ['registered', userId, inviteCode]
          );

          // Get inviter info
          const inviterResult = await pool.query(
            'SELECT name, email FROM users WHERE id = $1',
            [invitation.inviter_id]
          );

          if (inviterResult.rows.length > 0) {
            const inviter = inviterResult.rows[0];

            // Send notification email to inviter
            const appUrl = process.env.APP_URL || process.env.RAILWAY_PUBLIC_DOMAIN
              ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
              : 'https://kevin-supreme-transfer-app-production.up.railway.app';

            await mailgunTransporter.sendMail({
              from: 'Cash Flow App <invite@bluestoneapps.com>',
              to: inviter.email,
              subject: `${user.name || user.email} accepted your Supreme Transfer invitation! 🎉`,
              html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; padding: 30px; text-align: center; border-radius: 10px; }
    .content { padding: 30px; background: white; }
    .button { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 10px; display: inline-block; font-weight: 600; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0;">🎉 Great News!</h1>
    </div>
    <div class="content">
      <p>Hi ${inviter.name || inviter.email},</p>
      <p><strong>${user.name || user.email}</strong> (${user.email}) just joined Supreme Transfer using your invitation link!</p>
      <p>You can now send them money instantly or request payments.</p>
      <div style="text-align: center;">
        <a href="${appUrl}" class="button">Open Supreme Transfer</a>
      </div>
    </div>
  </div>
</body>
</html>
              `.trim()
            }).catch(err => console.error('Failed to send inviter notification:', err));

            console.log(`Notified inviter ${inviter.email} that ${user.email} joined via invite ${inviteCode}`);
          }
        }
      } catch (inviteError) {
        console.error('Error processing invite code:', inviteError);
        // Don't fail registration if invite processing fails
      }
    }

    // Generate and send email verification code
    const verifyCode = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await pool.query(
      'INSERT INTO email_verification_codes (user_id, code, expires_at) VALUES ($1, $2, $3)',
      [user.id, verifyCode, expiresAt]
    );
    await mailgunTransporter.sendMail({
      from: 'Supreme Transfer <invite@bluestoneapps.com>',
      to: user.email,
      subject: 'Verify your Supreme Transfer account',
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px">
        <h2 style="color:#4f46e5">Verify your email</h2>
        <p>Hi ${user.name || user.email}, enter this code to complete signup:</p>
        <div style="font-size:2.5rem;font-weight:bold;letter-spacing:8px;text-align:center;padding:20px;background:#f3f4f6;border-radius:8px;margin:16px 0">${verifyCode}</div>
        <p style="color:#6b7280;font-size:0.9rem">This code expires in 10 minutes.</p></div>`
    }).catch(err => console.error('Failed to send verification email:', err));

    res.json({ requiresVerification: true, email: user.email });
  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === '23505' && error.constraint === 'users_email_key') {
      return res.status(409).json({ error: 'This email address is already in use.' });
    }
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});


app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, inviteCode } = req.body;

  try {
    // Enforce strong password
    const strongPasswordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{8,}$/;
    if (!password || !strongPasswordRegex.test(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters with uppercase, lowercase, number, and special character.' });
    }

    const userId = 'user_' + Date.now();
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (id, email, password, name, email_verified) VALUES ($1, $2, $3, $4, false) RETURNING *',
      [userId, email.toLowerCase(), hashedPassword, name || email.split('@')[0]]
    );

    const user = result.rows[0];

    // Create wallet record
    await pool.query('INSERT INTO wallets (user_id, balance) VALUES ($1, 0)', [user.id]);

    // Handle invite code if provided
    if (inviteCode) {
      try {
        const inviteResult = await pool.query(
          'SELECT * FROM invitations WHERE code = $1 AND status = $2',
          [inviteCode, 'pending']
        );

        if (inviteResult.rows.length > 0) {
          const invitation = inviteResult.rows[0];

          // Update invitation status
          await pool.query(
            'UPDATE invitations SET status = $1, invitee_id = $2, registered_at = NOW() WHERE code = $3',
            ['registered', userId, inviteCode]
          );

          // Get inviter info
          const inviterResult = await pool.query(
            'SELECT name, email FROM users WHERE id = $1',
            [invitation.inviter_id]
          );

          if (inviterResult.rows.length > 0) {
            const inviter = inviterResult.rows[0];

            // Send notification email to inviter
            const appUrl = process.env.APP_URL || process.env.RAILWAY_PUBLIC_DOMAIN
              ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
              : 'https://kevin-supreme-transfer-app-production.up.railway.app';

            await mailgunTransporter.sendMail({
              from: 'Cash Flow App <invite@bluestoneapps.com>',
              to: inviter.email,
              subject: `${user.name || user.email} accepted your Supreme Transfer invitation! 🎉`,
              html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; padding: 30px; text-align: center; border-radius: 10px; }
    .content { padding: 30px; background: white; }
    .button { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 10px; display: inline-block; font-weight: 600; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0;">🎉 Great News!</h1>
    </div>
    <div class="content">
      <p>Hi ${inviter.name || inviter.email},</p>
      <p><strong>${user.name || user.email}</strong> (${user.email}) just joined Supreme Transfer using your invitation link!</p>
      <p>You can now send them money instantly or request payments.</p>
      <div style="text-align: center;">
        <a href="${appUrl}" class="button">Open Supreme Transfer</a>
      </div>
    </div>
  </div>
</body>
</html>
              `.trim()
            }).catch(err => console.error('Failed to send inviter notification:', err));

            console.log(`Notified inviter ${inviter.email} that ${user.email} joined via invite ${inviteCode}`);
          }
        }
      } catch (inviteError) {
        console.error('Error processing invite code:', inviteError);
        // Don't fail registration if invite processing fails
      }
    }

    // Generate and send email verification code
    const verifyCode = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await pool.query(
      'INSERT INTO email_verification_codes (user_id, code, expires_at) VALUES ($1, $2, $3)',
      [user.id, verifyCode, expiresAt]
    );
    await mailgunTransporter.sendMail({
      from: 'Supreme Transfer <invite@bluestoneapps.com>',
      to: user.email,
      subject: 'Verify your Supreme Transfer account',
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px">
        <h2 style="color:#4f46e5">Verify your email</h2>
        <p>Hi ${user.name || user.email}, enter this code to complete signup:</p>
        <div style="font-size:2.5rem;font-weight:bold;letter-spacing:8px;text-align:center;padding:20px;background:#f3f4f6;border-radius:8px;margin:16px 0">${verifyCode}</div>
        <p style="color:#6b7280;font-size:0.9rem">This code expires in 10 minutes.</p></div>`
    }).catch(err => console.error('Failed to send verification email:', err));

    res.json({ requiresVerification: true, email: user.email });
  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === '23505' && error.constraint === 'users_email_key') {
      return res.status(409).json({ error: 'This email address is already in use.' });
    }
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// Email verification endpoint
app.post('/api/auth/verify-email', async (req, res) => {
  const { email, code } = req.body;
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];

    const codeResult = await pool.query(
      `SELECT * FROM email_verification_codes 
       WHERE user_id = $1 AND code = $2 AND used = false AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [user.id, code]
    );
    if (codeResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired verification code' });
    }

    // Mark code used and verify user
    await pool.query('UPDATE email_verification_codes SET used = true WHERE id = $1', [codeResult.rows[0].id]);
    await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [user.id]);

    const token = createToken(user.id, user.email);
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        stripe_account_id: user.stripe_account_id
      }
    });
  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Resend verification code
app.post('/api/auth/resend-verification', async (req, res) => {
  const { email } = req.body;
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = userResult.rows[0];
    if (user.email_verified) return res.status(400).json({ error: 'Email already verified' });

    const verifyCode = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await pool.query(
      'INSERT INTO email_verification_codes (user_id, code, expires_at) VALUES ($1, $2, $3)',
      [user.id, verifyCode, expiresAt]
    );
    await mailgunTransporter.sendMail({
      from: 'Supreme Transfer <invite@bluestoneapps.com>',
      to: user.email,
      subject: 'Your new Supreme Transfer verification code',
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px">
        <h2 style="color:#4f46e5">New verification code</h2>
        <p>Hi ${user.name || user.email}, here is your new code:</p>
        <div style="font-size:2.5rem;font-weight:bold;letter-spacing:8px;text-align:center;padding:20px;background:#f3f4f6;border-radius:8px;margin:16px 0">${verifyCode}</div>
        <p style="color:#6b7280;font-size:0.9rem">This code expires in 10 minutes.</p></div>`
    }).catch(err => console.error('Failed to send verification email:', err));
    res.json({ message: 'Verification code sent' });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Failed to resend code' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    const user = result.rows[0];
    res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          username: user.username,
          stripe_account_id: user.stripe_account_id,
        }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get user' });
  }
});

app.get('/api/auth/users', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT id,name,balance,username,stripe_account_id,email FROM users');
    res.json({ users: result.rows, count: result.rows.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get user' });
  }
});

app.post('/api/auth/save_device_details', authMiddleware, async (req, res) => {
  const { user_id, deviceId, onesignalDeviceId, platform, timezone, status } = req.body;
 
  // try {
    const result = await pool.query('SELECT * FROM device_details WHERE user_id = $1 and deviceid= $2 and onesignalDeviceId=$3', [user_id, deviceId, onesignalDeviceId]);
    if(result.rows.length===0){
      await pool.query(
        'INSERT INTO device_details (user_id, deviceid, onesignalDeviceId, platform, timezone, status) VALUES ($1, $2, $3, $4, $5, $6)',
        [user_id, deviceId, onesignalDeviceId, platform, timezone, '1']
      );
      res.json({message : 'Device Details Added'});
    } else {
      await pool.query(
        'UPDATE device_details set status=$1 where user_id=$2 and deviceid=$3',
        [status, user_id, deviceId]
      );
      res.json({message : 'Device Details Updated'});
      // res.json({message : 'Device Details Updated',data:data.rows,token:deviceIds,response});
    }
  // } catch (error) {
  //   res.status(500).json({ error: 'Failed to get user' });
  // }
});

async function sendNotifications(title,message,tokens){
  const notificationData = {
    app_id: "ae7e1dd2-ca8c-478b-894b-85329418ec01", // OneSignal App ID
    include_player_ids: tokens, // Segment of users to send notification to
    contents: { en:message }, // Notification message
    headings: { en:title },
    data: { customData: "value" }, // Custom data for app usage
  };

  try {
    const response = await axios.post('https://onesignal.com/api/v1/notifications', notificationData, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic os_v2_app_vz7b3uwkrrdyxcklquzjighmagevmzd3zzdeccf67vjpgndrfj7pl3hn6dbjfh3bbkk7zq54snzealr42tjwa2jj4dinuf6tfk2dk7y`,
      },
    });

    console.log('Notification sent successfully:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error sending notification:', error.response ? error.response.data : error.message);
  }
}

// Check username availability
app.get('/api/auth/check-username/:username', async (req, res) => {
  try {
    const { username } = req.params;

    // Validate username format (alphanumeric, underscore, 3-30 chars)
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return res.json({ available: false, error: 'Username must be 3-30 characters (letters, numbers, underscore only)' });
    }

    const result = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    res.json({ available: result.rows.length === 0 });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check username' });
  }
});

// Update username
app.put('/api/auth/username', authMiddleware, async (req, res) => {
  try {
    const { username } = req.body;

    // Validate username format
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-30 characters (letters, numbers, underscore only)' });
    }

    // Check if username is taken
    const existing = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id != $2', [username, req.userId]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Username already taken' });
    }

    await pool.query('UPDATE users SET username = $1 WHERE id = $2', [username, req.userId]);
    res.json({ success: true, username });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update username' });
  }
});

// ============= WALLET ROUTES =============

app.get('/api/wallet/balance', authMiddleware, async (req, res) => {
  try {
    // DB is the source of truth for wallet balance — money stays on platform account
    const walletResult = await pool.query(
      'SELECT balance, platform_credit FROM wallets WHERE user_id = $1',
      [req.userId]
    );
    const walletBalance = parseInt(walletResult.rows[0]?.balance) || 0;
    const platformCredit = parseInt(walletResult.rows[0]?.platform_credit) || 0;
    const totalAvailable = walletBalance + platformCredit;

    // Pending = deposits not yet confirmed (exclude stale entries older than 2 hours)
    const pendingResult = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) AS pending FROM transactions WHERE user_id = $1 AND type = 'deposit' AND status = 'pending' AND created_at > NOW() - INTERVAL '2 hours'",
      [req.userId]
    );
    const pending = parseInt(pendingResult.rows[0]?.pending) || 0;

    // Check if connected account exists (for cash-out eligibility)
    const userResult = await pool.query('SELECT stripe_account_id FROM users WHERE id = $1', [req.userId]);
    const hasAccount = !!userResult.rows[0]?.stripe_account_id;

    res.json({
      balance: totalAvailable,
      formatted: `$${(totalAvailable / 100).toFixed(2)}`,
      pending: pending,
      pendingFormatted: `$${(pending / 100).toFixed(2)}`,
      platformCredit: platformCredit,
      platformCreditFormatted: `$${(platformCredit / 100).toFixed(2)}`,
      hasAccount: hasAccount
    });
  } catch (error) {
    console.error('Balance error:', error);
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

// Enhanced balance with breakdown
app.get('/api/wallet/balance-enhanced', authMiddleware, async (req, res) => {
  try {
    // Get Stripe balance
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.userId]
    );
    
    const accountId = userResult.rows[0]?.stripe_account_id;
    
    let stripeAvailable = 0;
    let stripePending = 0;
    
    if (accountId && stripe) {
      const { available, pending } = await getConnectedAccountBalance(accountId);
      stripeAvailable = available;
      stripePending = pending;
    }
    
    // Get wallet balance and platform credit
    const walletResult = await pool.query(
      'SELECT balance, platform_credit FROM wallets WHERE user_id = $1',
      [req.userId]
    );

    const walletBalance = parseInt(walletResult.rows[0]?.balance) || 0;
    const platformCredit = parseInt(walletResult.rows[0]?.platform_credit) || 0;
    const totalAvailable = parseInt(stripeAvailable) + walletBalance + platformCredit;

    // Set no-cache headers to prevent stale balance data
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    res.json({
      balance: totalAvailable,
      formatted: `$${(totalAvailable / 100).toFixed(2)}`,
      pending: stripePending,
      pendingFormatted: `$${(stripePending / 100).toFixed(2)}`,
      walletBalance: walletBalance,
      walletBalanceFormatted: `$${(walletBalance / 100).toFixed(2)}`,
      platformCredit: platformCredit,
      platformCreditFormatted: `$${(platformCredit / 100).toFixed(2)}`,
      stripeBalance: stripeAvailable,
      stripeFormatted: `$${(stripeAvailable / 100).toFixed(2)}`,
      hasAccount: !!accountId,
      accountId: accountId,
      breakdown: {
        stripeAvailable: `$${(stripeAvailable / 100).toFixed(2)}`,
        stripePending: `$${(stripePending / 100).toFixed(2)}`,
        walletBalance: `$${(walletBalance / 100).toFixed(2)}`,
        platformAdvance: `$${(platformCredit / 100).toFixed(2)}`,
        totalAvailable: `$${(totalAvailable / 100).toFixed(2)}`
      }
    });
  } catch (error) {
    console.error('Enhanced balance error:', error);
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

// ============= PAYMENT ROUTES =============

app.post('/api/payments/create-intent', authMiddleware, async (req, res) => {
  const { amount } = req.body; // amount the user WANTS in their wallet (in cents)

  console.log(`Creating payment intent for $${amount/100}`);

  if (!amount || amount < 100) {
    return res.status(400).json({ error: 'Minimum amount is $1.00' });
  }

  // Load pass_stripe_fee_to_user setting
  let passStripeFee = true;
  try {
    const feeRow = await pool.query(
      `SELECT setting_value FROM system_settings WHERE setting_key = 'pass_stripe_fee_to_user'`
    );
    if (feeRow.rows.length > 0) {
      passStripeFee = feeRow.rows[0].setting_value !== 'false';
    }
  } catch (e) { /* use default */ }

  // Stripe fee: 2.9% + $0.30
  const stripeFee = passStripeFee ? Math.round(amount * 0.029 + 30) : 0;
  const chargeAmount = amount + stripeFee; // total charged to card

  if (!stripe) {
    return res.json({
      clientSecret: 'mock_secret_' + Date.now(),
      amount: amount,
      chargeAmount: chargeAmount,
      stripeFee: stripeFee,
      passStripeFee: passStripeFee,
      mock: true
    });
  }

  try {
    // Get or create Stripe customer (funds stay on platform — no transfer_data)
    const userResult = await pool.query(
      'SELECT email, stripe_customer_id FROM users WHERE id = $1',
      [req.userId]
    );

    const user = userResult.rows[0];
    let customerId = user.stripe_customer_id;

    // Verify stored customer still exists in Stripe; recreate if stale/missing
    if (customerId) {
      try {
        await stripe.customers.retrieve(customerId);
      } catch (e) {
        console.log(`Stale customer ID ${customerId} — creating fresh customer for user ${req.userId}`);
        customerId = null;
        await pool.query('UPDATE users SET stripe_customer_id = NULL WHERE id = $1', [req.userId]);
      }
    }

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { user_id: req.userId }
      });
      customerId = customer.id;
      await pool.query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, req.userId]
      );
      console.log(`Created new Stripe customer ${customerId} for user ${req.userId}`);
    }

    // Charge card — money stays on platform account, no transfer_data.
    // Connected account is only used at cash-out time.
    const paymentIntent = await stripe.paymentIntents.create({
      amount: chargeAmount,
      currency: 'usd',
      customer: customerId,
      setup_future_usage: 'off_session',
      metadata: {
        user_id: req.userId,
        type: 'add_funds_to_wallet',
        wallet_amount: amount,
        stripe_fee: stripeFee,
        pass_stripe_fee: passStripeFee ? 'true' : 'false'
      }
    });

    console.log(`Created payment intent ${paymentIntent.id} for $${(chargeAmount/100).toFixed(2)} (wallet: $${(amount/100).toFixed(2)}, stripe fee: $${(stripeFee/100).toFixed(2)})`);

    // Record pending transaction — wallet credited after confirm
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, description, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.userId, 'deposit', amount, 'pending',
       `Adding $${(amount/100).toFixed(2)} to wallet`,
       JSON.stringify({ payment_intent_id: paymentIntent.id, stripe_fee: stripeFee, charge_amount: chargeAmount })]
    );

    res.json({
      clientSecret: paymentIntent.client_secret,
      amount: amount,
      chargeAmount: chargeAmount,
      stripeFee: stripeFee,
      passStripeFee: passStripeFee,
      paymentIntentId: paymentIntent.id
    });

  } catch (error) {
    console.error('Payment intent error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/payments/confirm', authMiddleware, async (req, res) => {
  const { payment_intent_id, amount } = req.body;

  console.log(`Confirming payment ${payment_intent_id}`);

  try {
    if (stripe && payment_intent_id && payment_intent_id !== 'mock_secret') {
      const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);

      // SECURITY: verify payment actually succeeded — declined/cancelled intents must never get credit
      if (paymentIntent.status !== 'succeeded') {
        console.warn(`Payment confirm rejected: intent ${payment_intent_id} has status '${paymentIntent.status}' (not succeeded)`);
        return res.status(400).json({ error: `Payment was not successful (status: ${paymentIntent.status}). No funds added.` });
      }

      if (paymentIntent.payment_method) {
        console.log(`Payment method ${paymentIntent.payment_method} saved to customer ${paymentIntent.customer}`);
      }

      // SECURITY: use the amount from Stripe (source of truth), not the client-sent amount
      // This prevents users from passing an inflated amount in the request body
      const verifiedAmount = paymentIntent.amount; // already in cents

      // Idempotency check: only credit wallet if this payment_intent hasn't been credited before
      const alreadyCredited = await pool.query(
        "SELECT id FROM transactions WHERE metadata->>'payment_intent_id' = $1 AND status = 'completed'",
        [payment_intent_id]
      );
      if (alreadyCredited.rows.length > 0) {
        console.log(`Payment ${payment_intent_id} already credited — skipping duplicate credit`);
        const walletResult = await pool.query('SELECT balance, platform_credit FROM wallets WHERE user_id = $1', [req.userId]);
        const bal = parseInt(walletResult.rows[0]?.balance) || 0;
        const pc = parseInt(walletResult.rows[0]?.platform_credit) || 0;
        return res.json({ success: true, message: 'Payment already processed', balance: bal + pc, formatted: `$${((bal + pc) / 100).toFixed(2)}` });
      }

      // Mark transaction completed
      await pool.query(
        "UPDATE transactions SET status = 'completed' WHERE metadata->>'payment_intent_id' = $1",
        [payment_intent_id]
      );

      // Credit wallet in DB using Stripe-verified amount — money stays on platform, DB is source of truth
      await pool.query(
        'INSERT INTO wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2',
        [req.userId, verifiedAmount]
      );
    } else {
      // Mock/fallback: create completed transaction and credit wallet
      await pool.query(
        'INSERT INTO transactions (user_id, type, amount, status, description) VALUES ($1, $2, $3, $4, $5)',
        [req.userId, 'deposit', amount, 'completed', `Added $${(amount/100).toFixed(2)} to wallet`]
      );
      await pool.query(
        'INSERT INTO wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2',
        [req.userId, amount]
      );
    }

    // Return DB wallet balance
    const walletResult = await pool.query(
      'SELECT balance, platform_credit FROM wallets WHERE user_id = $1',
      [req.userId]
    );
    const walletBalance = parseInt(walletResult.rows[0]?.balance) || 0;
    const platformCredit = parseInt(walletResult.rows[0]?.platform_credit) || 0;
    const totalBalance = walletBalance + platformCredit;

    // Use verifiedAmount if available (real Stripe path), else fall back to client-sent amount (mock path)
    const displayAmount = typeof verifiedAmount !== 'undefined' ? verifiedAmount : amount;
    res.json({
      success: true,
      message: `Successfully added $${(displayAmount/100).toFixed(2)} to your wallet`,
      balance: totalBalance,
      formatted: `$${(totalBalance/100).toFixed(2)}`
    });

  } catch (error) {
    console.error('Confirm error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============= STRIPE ACCOUNT MANAGEMENT =============

app.post('/api/stripe/onboarding', authMiddleware, async (req, res) => {
  try {
    const accountId = await getOrCreateConnectedAccount(req.userId, req.userEmail);

    const appUrl = process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'https://kevin-supreme-transfer-app-production.up.railway.app');

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${appUrl}/stripe-onboarding`,
      return_url: `${appUrl}/stripe-success`,
      type: 'account_onboarding',
    });

    res.json({
      url: accountLink.url,
      accountId: accountId
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stripe/account-status', authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.userId]
    );
    
    const accountId = userResult.rows[0]?.stripe_account_id;
    
    if (!accountId) {
      return res.json({ hasAccount: false });
    }
    
    const account = await stripe.accounts.retrieve(accountId);
    
    res.json({
      hasAccount: true,
      accountId: accountId,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      requirements: account.requirements
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stripe/sync', authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.userId]
    );

    const accountId = userResult.rows[0]?.stripe_account_id;

    if (!accountId) {
      return res.status(400).json({ error: 'No Connected Account' });
    }

    const { available, pending } = await getConnectedAccountBalance(accountId);

    // Get wallet balance and platform credit to show complete picture
    const walletResult = await pool.query(
      'SELECT balance, platform_credit FROM wallets WHERE user_id = $1',
      [req.userId]
    );
    const walletBalance = parseInt(walletResult.rows[0]?.balance) || 0;
    const platformCredit = parseInt(walletResult.rows[0]?.platform_credit) || 0;

    // Calculate total available (same as main balance display)
    const totalAvailable = parseInt(available) + walletBalance + platformCredit;

    res.json({
      success: true,
      available: `$${(totalAvailable/100).toFixed(2)}`,
      pending: `$${(pending/100).toFixed(2)}`,
      accountId: accountId,
      breakdown: {
        stripe: `$${(available/100).toFixed(2)}`,
        wallet: `$${(walletBalance/100).toFixed(2)}`,
        platformCredit: `$${(platformCredit/100).toFixed(2)}`
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stripe/force-update', authMiddleware, async (req, res) => {
  const { stripe_account_id } = req.body;
  
  try {
    await pool.query(
      'UPDATE users SET stripe_account_id = $1, updated_at = NOW() WHERE id = $2',
      [stripe_account_id, req.userId]
    );
    
    console.log(`Force updated user ${req.userId} with Stripe account ${stripe_account_id}`);
    
    if (stripe && stripe_account_id) {
      try {
        const balance = await stripe.balance.retrieve({
          stripeAccount: stripe_account_id
        });
        
        const available = balance.available.reduce((sum, bal) => {
          return bal.currency === 'usd' ? sum + bal.amount : sum;
        }, 0);
        
        const pending = balance.pending.reduce((sum, bal) => {
          return bal.currency === 'usd' ? sum + bal.amount : sum;
        }, 0);
        
        res.json({
          success: true,
          message: 'Account linked successfully!',
          account: stripe_account_id,
          balance: {
            available: `$${(available/100).toFixed(2)}`,
            pending: `$${(pending/100).toFixed(2)}`
          }
        });
      } catch (balanceError) {
        res.json({
          success: true,
          message: 'Account linked (balance check failed)',
          account: stripe_account_id,
          error: balanceError.message
        });
      }
    } else {
      res.json({
        success: true,
        message: 'Account ID updated',
        account: stripe_account_id
      });
    }
    
  } catch (error) {
    console.error('Force update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============= INSTANT PAYOUT TO BANK =============

app.post('/api/stripe/instant-payout', authMiddleware, async (req, res) => {
  const { amount, forceStandard } = req.body;

  if (!stripe) {
    return res.status(400).json({ error: 'Stripe not configured' });
  }

  try {
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.userId]
    );
    const accountId = userResult.rows[0]?.stripe_account_id;
    if (!accountId) {
      return res.status(400).json({ error: 'No Connected Account linked. Complete Stripe setup first.' });
    }

    // Check DB wallet balance (source of truth)
    const walletResult = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [req.userId]);
    const walletBalance = parseInt(walletResult.rows[0]?.balance) || 0;
    const requestedAmount = amount || walletBalance;

    if (requestedAmount <= 0 || walletBalance <= 0) {
      return res.status(400).json({ error: 'No funds available for payout' });
    }
    if (requestedAmount > walletBalance) {
      return res.status(400).json({
        error: `Maximum available: $${(walletBalance/100).toFixed(2)}`
      });
    }

    // Supreme Transfer instant fee: 1.5% (min $0.50). Platform keeps the fee.
    const fee = forceStandard ? 0 : Math.max(50, Math.round(requestedAmount * 0.015));
    const netAmount = requestedAmount - fee; // amount transferred to connected account & paid out to bank

    console.log(`${forceStandard ? 'Standard' : 'Instant'} payout: $${(requestedAmount/100).toFixed(2)} (fee: $${(fee/100).toFixed(2)}, net: $${(netAmount/100).toFixed(2)})`);

    // 1. Deduct full requested amount from DB wallet
    await pool.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [requestedAmount, req.userId]);

    let payout;
    let payoutMethod = forceStandard ? 'standard' : 'instant';

    try {
      // 2. Transfer NET amount from platform to connected account (platform keeps the fee)
      const transfer = await stripe.transfers.create({
        amount: netAmount,
        currency: 'usd',
        destination: accountId,
        description: `Supreme Transfer ${payoutMethod} cash out for user ${req.userId}`
      });

      // 3. Payout from connected account to bank
      try {
        payout = await stripe.payouts.create(
          { amount: netAmount, currency: 'usd', method: payoutMethod, description: `${payoutMethod} payout to bank` },
          { stripeAccount: accountId }
        );
      } catch (instantError) {
        if (!forceStandard && instantError.message?.includes('instant')) {
          // Instant not supported — roll back and tell user
          await stripe.transfers.createReversal(transfer.id);
          await pool.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [requestedAmount, req.userId]);
          return res.status(400).json({
            error: 'instant_not_supported',
            message: "Your bank doesn't support instant payouts. Use Standard (free, 1-2 days)?",
            requiresConfirmation: true,
            amount: requestedAmount,
            fee: 0,
            netAmount: requestedAmount
          });
        }
        throw instantError;
      }

      console.log(`Payout success — transfer: ${transfer.id}, payout: ${payout.id}`);

      // Record transaction
      await pool.query(
        'INSERT INTO transactions (user_id, type, amount, status, description, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.userId, 'cashout', requestedAmount, 'completed',
         `${payoutMethod === 'instant' ? 'Instant' : 'Standard'} cash out to bank (fee: $${(fee/100).toFixed(2)})`,
         JSON.stringify({ payout_id: payout.id, transfer_id: transfer.id, fee, net: netAmount, method: payoutMethod })]
      );

    } catch (stripeError) {
      // Rollback wallet on any unhandled Stripe failure
      await pool.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [requestedAmount, req.userId]);
      throw stripeError;
    }

    const arrivalMsg = payoutMethod === 'instant' ? 'within 30 minutes' : 'in 1-2 business days';
    res.json({
      success: true,
      message: `Payout initiated! You'll receive $${(netAmount/100).toFixed(2)} ${arrivalMsg}.`,
      method: payoutMethod,
      payout: {
        id: payout.id,
        amount: requestedAmount,
        fee: fee,
        netAmount: netAmount,
        status: payout.status,
        arrival_date: payout.arrival_date
      },
      formatted: {
        requested: `$${(requestedAmount/100).toFixed(2)}`,
        fee: `$${(fee/100).toFixed(2)}`,
        youReceive: `$${(netAmount/100).toFixed(2)}`
      }
    });

  } catch (error) {
    console.error('Payout error:', error);
    res.status(500).json({
      error: error.message,
      type: error.type
    });
  }
});

// Regular Cash Out (Standard ACH) - No Supreme Transfer fee
app.post('/api/stripe/cash-out', authMiddleware, async (req, res) => {
  const { amount } = req.body; // amount in cents

  if (!stripe) {
    return res.status(400).json({ error: 'Stripe not configured' });
  }

  try {
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.userId]
    );
    const accountId = userResult.rows[0]?.stripe_account_id;
    if (!accountId) {
      return res.status(400).json({ error: 'No Connected Account linked. Complete Stripe setup first.' });
    }

    // Check DB wallet balance (source of truth)
    const walletResult = await pool.query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [req.userId]
    );
    const walletBalance = parseInt(walletResult.rows[0]?.balance) || 0;
    const payoutAmount = amount || walletBalance;

    if (payoutAmount <= 0 || walletBalance <= 0) {
      return res.status(400).json({ error: 'No funds available for cash out' });
    }
    if (payoutAmount > walletBalance) {
      return res.status(400).json({
        error: `Maximum cash out available: $${(walletBalance/100).toFixed(2)}`
      });
    }

    console.log(`Standard cash out: $${(payoutAmount/100).toFixed(2)} for user ${req.userId}`);

    // 1. Deduct from DB wallet immediately
    await pool.query(
      'UPDATE wallets SET balance = balance - $1 WHERE user_id = $2',
      [payoutAmount, req.userId]
    );

    try {
      // 2. Transfer from platform to user's connected account
      const transfer = await stripe.transfers.create({
        amount: payoutAmount,
        currency: 'usd',
        destination: accountId,
        description: `Supreme Transfer wallet cash out for user ${req.userId}`
      });

      // 3. Payout from connected account to bank (standard ACH)
      const payout = await stripe.payouts.create(
        { amount: payoutAmount, currency: 'usd', method: 'standard', description: 'Cash out to bank' },
        { stripeAccount: accountId }
      );

      console.log(`Cash out success — transfer: ${transfer.id}, payout: ${payout.id}`);

      // Record transaction
      await pool.query(
        'INSERT INTO transactions (user_id, type, amount, status, description, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.userId, 'cashout', payoutAmount, 'completed',
         'Cash out to bank account',
         JSON.stringify({ payout_id: payout.id, transfer_id: transfer.id, method: 'standard' })]
      );

      res.json({
        success: true,
        message: `Cash out initiated! $${(payoutAmount/100).toFixed(2)} will arrive in 1-2 business days.`,
        payout: { id: payout.id, amount: payoutAmount, status: payout.status, arrival_date: payout.arrival_date }
      });

    } catch (stripeError) {
      // Rollback DB wallet deduction on Stripe failure
      await pool.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [payoutAmount, req.userId]);
      throw stripeError;
    }

  } catch (error) {
    console.error('Cash out error:', error);
    res.status(500).json({ error: error.message, type: error.type });
  }
});

app.get('/api/stripe/instant-payout-available', authMiddleware, async (req, res) => {
  if (!stripe) {
    return res.status(400).json({ error: 'Stripe not configured' });
  }
  
  try {
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.userId]
    );
    
    const accountId = userResult.rows[0]?.stripe_account_id;
    
    if (!accountId) {
      return res.status(400).json({ error: 'No Connected Account linked' });
    }
    
    const balance = await stripe.balance.retrieve({
      stripeAccount: accountId
    });
    
    const instantAvailable = balance.instant_available ? 
      balance.instant_available.find(b => b.currency === 'usd')?.amount || 0 : 0;
    
    const standardAvailable = balance.available.find(b => b.currency === 'usd')?.amount || 0;
    const pendingAmount = balance.pending.find(b => b.currency === 'usd')?.amount || 0;
    const availableAmount = instantAvailable || standardAvailable || pendingAmount;
    
    const fee = availableAmount > 0 ? Math.max(50, Math.round(availableAmount * 0.015)) : 0;
    const netAmount = availableAmount - fee;
    
    res.json({
      available: availableAmount > 0,
      instantAmount: availableAmount,
      standardAmount: standardAvailable,
      pendingAmount: pendingAmount,
      fee: fee,
      netAmount: netAmount,
      formatted: {
        instant: `$${(availableAmount/100).toFixed(2)}`,
        standard: `$${(standardAvailable/100).toFixed(2)}`,
        pending: `$${(pendingAmount/100).toFixed(2)}`,
        fee: `$${(fee/100).toFixed(2)}`,
        youReceive: `$${(netAmount/100).toFixed(2)}`
      }
    });
    
  } catch (error) {
    console.error('Check instant payout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============= INSTANT WALLET CREDIT (Platform Advance) =============

app.post('/api/wallet/instant-credit', authMiddleware, async (req, res) => {
  const { amount } = req.body; // amount in cents
  
  if (!amount || amount < 100) {
    return res.status(400).json({ error: 'Minimum amount is $1.00' });
  }
  
  try {
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.userId]
    );
    
    const accountId = userResult.rows[0]?.stripe_account_id;
    
    if (!accountId) {
      return res.status(400).json({ error: 'No Connected Account linked' });
    }
    
    // Get current balance from Stripe
    const balance = await stripe.balance.retrieve({
      stripeAccount: accountId
    });
    
    const pendingBalance = balance.pending.reduce((sum, bal) => {
      return bal.currency === 'usd' ? sum + bal.amount : sum;
    }, 0);
    
    const availableBalance = balance.available.reduce((sum, bal) => {
      return bal.currency === 'usd' ? sum + bal.amount : sum;
    }, 0);
    
    const instantAvailable = balance.instant_available ? 
      balance.instant_available.find(b => b.currency === 'usd')?.amount || 0 : 0;
    
    const maxAdvanceAmount = instantAvailable || pendingBalance;
    
    if (maxAdvanceAmount === 0) {
      return res.status(400).json({ 
        error: 'No pending funds available to advance',
        pending: pendingBalance,
        available: availableBalance
      });
    }
    
    if (amount > maxAdvanceAmount) {
      return res.status(400).json({ 
        error: `Maximum advance available: $${(maxAdvanceAmount/100).toFixed(2)}` 
      });
    }
    
    // Calculate platform fee (2% for instant advance)
    const fee = Math.round(amount * 0.02);
    const netAmount = amount - fee;
    
    console.log(`Instant wallet credit: $${(amount/100).toFixed(2)} (fee: $${(fee/100).toFixed(2)})`);
    
    // Record platform advance
    await pool.query(`
      INSERT INTO platform_advances 
      (user_id, amount, fee, net_amount, status, stripe_account_id, advanced_at) 
      VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [req.userId, amount, fee, netAmount, 'advanced', accountId]
    );
    
    // Update user's available balance
    await pool.query(`
      UPDATE wallets 
      SET platform_credit = COALESCE(platform_credit, 0) + $1,
          updated_at = NOW()
      WHERE user_id = $2`,
      [netAmount, req.userId]
    );
    
    // Record transaction
    await pool.query(
      `INSERT INTO transactions 
       (user_id, type, amount, status, description, metadata) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.userId, 'instant_credit', netAmount, 'completed', 
       `Instant wallet credit (fee: $${(fee/100).toFixed(2)})`,
       JSON.stringify({ 
         advanced_amount: amount,
         fee: fee, 
         net: netAmount,
         type: 'platform_advance'
       })]
    );
    
    console.log(`Platform advanced $${(netAmount/100).toFixed(2)} to user ${req.userId}`);
    
    res.json({
      success: true,
      message: `Wallet credited instantly! $${(netAmount/100).toFixed(2)} is now available to send.`,
      credit: {
        requested: amount,
        fee: fee,
        netAmount: netAmount,
        type: 'platform_advance'
      },
      formatted: {
        requested: `$${(amount/100).toFixed(2)}`,
        fee: `$${(fee/100).toFixed(2)}`,
        credited: `$${(netAmount/100).toFixed(2)}`
      },
      note: 'These funds are advanced by the platform and available immediately for transfers.'
    });
    
  } catch (error) {
    console.error('Instant credit error:', error);
    res.status(500).json({ 
      error: error.message
    });
  }
});

// ============= TRANSFERS BETWEEN USERS =============

app.post('/api/transfers/send', authMiddleware, async (req, res) => {
  const { recipient_email, recipient_username, amount, note } = req.body;

  try {
    // Validate amount
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Validate recipient identifier
    if (!recipient_email && !recipient_username) {
      return res.status(400).json({ error: 'Recipient email or username required' });
    }

    // Load transfer fee config from DB
    let transferFeePct = 5;
    let transferFeeMin = 100; // $1.00 in cents
    try {
      const feeRows = await pool.query(
        `SELECT setting_key, setting_value FROM system_settings
         WHERE setting_key IN ('user_transfer_fee_pct', 'user_transfer_fee_min')`
      );
      feeRows.rows.forEach(row => {
        const parsed = parseFloat(row.setting_value);
        if (row.setting_key === 'user_transfer_fee_pct') transferFeePct = isNaN(parsed) ? 5 : parsed;
        if (row.setting_key === 'user_transfer_fee_min') transferFeeMin = isNaN(parsed) ? 100 : parsed;
      });
    } catch (e) { /* use defaults */ }

    // Calculate fee: percentage with minimum
    const rawFee = Math.round(amount * (transferFeePct / 100));
    const fee = Math.max(rawFee, transferFeeMin);
    const recipientAmount = amount - fee;

    if (recipientAmount <= 0) {
      return res.status(400).json({ error: `Amount too small. Minimum fee is $${(transferFeeMin / 100).toFixed(2)}` });
    }

    // Get sender's wallet
    const senderWalletResult = await pool.query(
      'SELECT balance, platform_credit FROM wallets WHERE user_id = $1',
      [req.userId]
    );

    if (!senderWalletResult.rows[0]) {
      return res.status(400).json({ error: 'Wallet not found' });
    }

    const senderBalance = senderWalletResult.rows[0].balance || 0;
    const senderPlatformCredit = senderWalletResult.rows[0].platform_credit || 0;
    const totalAvailable = senderBalance + senderPlatformCredit;

    // Sender is debited the full amount they entered
    if (totalAvailable < amount) {
      return res.status(400).json({
        error: `Insufficient balance. Available: $${(totalAvailable/100).toFixed(2)}, Required: $${(amount/100).toFixed(2)}`
      });
    }

    // Get recipient by username or email
    let recipientResult;
    if (recipient_username) {
      recipientResult = await pool.query(
        'SELECT id, username, email FROM users WHERE LOWER(username) = LOWER($1)',
        [recipient_username]
      );
    } else {
      recipientResult = await pool.query(
        'SELECT id, username, email FROM users WHERE LOWER(email) = LOWER($1)',
        [recipient_email]
      );
    }

    if (!recipientResult.rows[0]) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const recipientUserId = recipientResult.rows[0].id;

    // Cannot send to yourself
    if (recipientUserId === req.userId) {
      return res.status(400).json({ error: 'Cannot send money to yourself' });
    }

    // Get or create recipient's wallet
    let recipientWalletResult = await pool.query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [recipientUserId]
    );

    if (!recipientWalletResult.rows[0]) {
      await pool.query(
        'INSERT INTO wallets (user_id, balance, platform_credit) VALUES ($1, 0, 0)',
        [recipientUserId]
      );
    }

    // Determine how much to deduct from each source (full amount from sender)
    let balanceUsed = Math.min(senderBalance, amount);
    let platformCreditUsed = amount - balanceUsed;

    await pool.query('BEGIN');

    try {
      // Deduct full amount from sender's wallet
      if (balanceUsed > 0) {
        await pool.query(
          'UPDATE wallets SET balance = balance - $1 WHERE user_id = $2',
          [balanceUsed, req.userId]
        );
      }

      if (platformCreditUsed > 0) {
        await pool.query(
          'UPDATE wallets SET platform_credit = platform_credit - $1 WHERE user_id = $2',
          [platformCreditUsed, req.userId]
        );
      }

      // Recipient gets amount minus fee
      await pool.query(
        'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
        [recipientAmount, recipientUserId]
      );

      // Record sender transaction (full amount debited)
      await pool.query(
        'INSERT INTO transactions (user_id, type, amount, description, metadata) VALUES ($1, $2, $3, $4, $5)',
        [req.userId, 'send', amount, note || 'Transfer sent',
         JSON.stringify({
           recipient: recipient_email || recipient_username,
           fee: fee,
           fee_pct: transferFeePct,
           recipient_receives: recipientAmount,
           balance_used: balanceUsed,
           platform_credit_used: platformCreditUsed
         })]
      );

      // Record receiver transaction (net amount received)
      await pool.query(
        'INSERT INTO transactions (user_id, type, amount, description, metadata) VALUES ($1, $2, $3, $4, $5)',
        [recipientUserId, 'receive', recipientAmount, note || 'Transfer received',
         JSON.stringify({ sender: req.userEmail })]
      );

      // Record platform fee transaction
      if (fee > 0) {
        await pool.query(
          'INSERT INTO transactions (user_id, type, amount, status, description, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
          [req.userId, 'transfer_fee', fee, 'completed', `Transfer fee (${transferFeePct}%, min $${(transferFeeMin/100).toFixed(2)})`,
           JSON.stringify({ transfer_amount: amount, fee_pct: transferFeePct, fee_min: transferFeeMin })]
        );
      }

      await pool.query('COMMIT');

      const data = await pool.query('SELECT onesignalDeviceId FROM device_details WHERE user_id = $1 and status= $2 ', [recipientUserId, "1"]);
      const deviceIds=[];
      if(data.rows.length>0){
        data.rows.forEach(obj => {
            deviceIds.push(obj.onesignaldeviceid);
        });
      }
      const response=sendNotifications( `${req.name ? req.name.toUpperCase() : req.userEmail}`,`$${(recipientAmount/100).toFixed(2)} sent funds`,deviceIds);

      res.json({
        success: true,
        message: `Successfully sent $${(amount/100).toFixed(2)}. Recipient gets $${(recipientAmount/100).toFixed(2)} (fee: $${(fee/100).toFixed(2)})`,
        amount: amount,
        fee: fee,
        feePct: transferFeePct,
        recipientReceives: recipientAmount,
        balanceUsed: balanceUsed > 0 ? `$${(balanceUsed/100).toFixed(2)}` : null,
        platformCreditUsed: platformCreditUsed > 0 ? `$${(platformCreditUsed/100).toFixed(2)}` : null
      });

    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }

  } catch (error) {
    console.error('Transfer error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============= CASH OUT TO BANK (USER) =============

/**
 * User Cash Out to Bank
 * User can cash out their wallet balance to their bank account
 * Standard: Free (1-2 days)
 * Instant: Extra fee (arrives quickly using platform funds advance)
 */
app.post('/api/wallet/cash-out', authMiddleware, async (req, res) => {
  try {
    const { amount, instant = false } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Get user info and wallet balance
    const userResult = await pool.query(
      `SELECT u.*, w.balance, w.platform_credit
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.id = $1`,
      [req.userId]
    );

    if (!userResult.rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const walletBalance = user.balance || 0;
    const platformCredit = user.platform_credit || 0;
    const totalAvailable = walletBalance + platformCredit;

    if (!user.stripe_account_id) {
      return res.status(400).json({ error: 'Please connect your bank account first' });
    }

    if (totalAvailable < amount) {
      return res.status(400).json({
        error: `Insufficient wallet balance. Available: $${(totalAvailable / 100).toFixed(2)}, Requested: $${(amount / 100).toFixed(2)}`
      });
    }

    // Load all fee settings from DB
    let INSTANT_FEE_PERCENT = 1.5;
    let STANDARD_FEE_PERCENT = 0;
    let standardEnabled = true;
    let instantEnabled = true;
    let cashoutFeePct = 5;
    let cashoutFeeMin = 100; // $1.00 in cents
    const INSTANT_FEE_MIN = 50; // $0.50 in cents
    try {
      const feeRows = await pool.query(
        `SELECT setting_key, setting_value FROM system_settings
         WHERE setting_key IN ('instant_payout_fee_percent', 'standard_cashout_fee_percent',
           'standard_cashout_enabled', 'instant_payout_enabled',
           'cashout_fee_pct', 'cashout_fee_min')`
      );
      feeRows.rows.forEach(row => {
        const parsed = parseFloat(row.setting_value);
        if (row.setting_key === 'instant_payout_fee_percent') INSTANT_FEE_PERCENT = isNaN(parsed) ? 1.5 : parsed;
        if (row.setting_key === 'standard_cashout_fee_percent') STANDARD_FEE_PERCENT = isNaN(parsed) ? 0 : parsed;
        if (row.setting_key === 'standard_cashout_enabled') standardEnabled = row.setting_value !== 'false';
        if (row.setting_key === 'instant_payout_enabled') instantEnabled = row.setting_value !== 'false';
        if (row.setting_key === 'cashout_fee_pct') cashoutFeePct = isNaN(parsed) ? 5 : parsed;
        if (row.setting_key === 'cashout_fee_min') cashoutFeeMin = isNaN(parsed) ? 100 : parsed;
      });
    } catch (e) { /* use defaults */ }

    // Reject cash-out if the requested method is disabled by admin
    if (instant && !instantEnabled) {
      return res.status(400).json({ error: 'Instant payout is currently disabled' });
    }
    if (!instant && !standardEnabled) {
      return res.status(400).json({ error: 'Standard cash out is currently disabled' });
    }

    // Admin fee: cashout_fee_pct with cashout_fee_min
    const rawAdminFee = Math.round(amount * (cashoutFeePct / 100));
    const adminFee = Math.max(rawAdminFee, cashoutFeeMin);

    // Stripe payout fee: $0.25 for standard, instant has its own
    const stripePayoutFee = instant ? Math.max(INSTANT_FEE_MIN, Math.round(amount * (INSTANT_FEE_PERCENT / 100))) : 25; // $0.25 standard Stripe payout fee

    const totalFees = adminFee + stripePayoutFee;
    const netReceived = amount - totalFees;

    if (netReceived <= 0) {
      return res.status(400).json({ error: `Amount too small after fees. Admin fee: $${(adminFee/100).toFixed(2)}, Stripe fee: $${(stripePayoutFee/100).toFixed(2)}` });
    }

    if (totalAvailable < amount) {
      return res.status(400).json({
        error: `Insufficient balance. Available: $${(totalAvailable / 100).toFixed(2)}, Required: $${(amount / 100).toFixed(2)}`
      });
    }

    console.log(`User ${user.email} cashing out: $${(amount / 100).toFixed(2)}, instant: ${instant}, admin fee: $${(adminFee / 100).toFixed(2)}, stripe fee: $${(stripePayoutFee / 100).toFixed(2)}, net: $${(netReceived / 100).toFixed(2)}`);

    await pool.query('BEGIN');

    try {
      // Transfer net amount to user's Stripe account
      const transfer = await stripe.transfers.create({
        amount: netReceived,
        currency: 'usd',
        destination: user.stripe_account_id,
        description: `Cash out for ${user.name || user.email}`
      });

      let payout;
      let actualMethod = instant ? 'instant' : 'standard';

      // Try instant first if requested, fallback to standard
      try {
        payout = await stripe.payouts.create({
          amount: netReceived,
          currency: 'usd',
          method: instant ? 'instant' : 'standard',
          description: `Cash out for ${user.name || user.email}`
        }, {
          stripeAccount: user.stripe_account_id
        });
      } catch (payoutError) {
        if (instant && (payoutError.code === 'instant_payouts_unsupported' ||
                        payoutError.message?.includes('Instant Payouts are not enabled'))) {
          console.log('Instant payout failed, falling back to standard...');
          payout = await stripe.payouts.create({
            amount: netReceived,
            currency: 'usd',
            method: 'standard',
            description: `Cash out for ${user.name || user.email}`
          }, {
            stripeAccount: user.stripe_account_id
          });
          actualMethod = 'standard';
        } else {
          throw payoutError;
        }
      }

      // Deduct full amount from user's wallet
      let balanceUsed = Math.min(walletBalance, amount);
      let platformCreditUsed = amount - balanceUsed;

      if (balanceUsed > 0) {
        await pool.query(
          'UPDATE wallets SET balance = balance - $1 WHERE user_id = $2',
          [balanceUsed, req.userId]
        );
      }

      if (platformCreditUsed > 0) {
        await pool.query(
          'UPDATE wallets SET platform_credit = platform_credit - $1 WHERE user_id = $2',
          [platformCreditUsed, req.userId]
        );
      }

      // Record transaction
      await pool.query(
        `INSERT INTO transactions
         (user_id, type, amount, status, description, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.userId,
          'cash_out',
          amount,
          'completed',
          `Cash out to bank (${actualMethod})`,
          JSON.stringify({
            transfer_id: transfer.id,
            payout_id: payout.id,
            method: actualMethod,
            requested_method: instant ? 'instant' : 'standard',
            admin_fee: adminFee,
            admin_fee_pct: cashoutFeePct,
            stripe_fee: stripePayoutFee,
            net_received: netReceived,
            balance_used: balanceUsed,
            platform_credit_used: platformCreditUsed
          })
        ]
      );

      // Record admin fee transaction
      if (adminFee > 0) {
        await pool.query(
          `INSERT INTO transactions
           (user_id, type, amount, status, description, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            req.userId,
            'cash_out_fee',
            adminFee,
            'completed',
            `Cash out admin fee (${cashoutFeePct}%, min $${(cashoutFeeMin/100).toFixed(2)})`,
            JSON.stringify({
              related_transfer: transfer.id,
              fee_percent: cashoutFeePct,
              fee_min: cashoutFeeMin
            })
          ]
        );
      }

      await pool.query('COMMIT');

      res.json({
        success: true,
        transferId: transfer.id,
        payoutId: payout.id,
        amount,
        adminFee,
        stripeFee: stripePayoutFee,
        totalFees,
        netReceived,
        method: actualMethod,
        message: `Cash out successful! You'll receive $${(netReceived / 100).toFixed(2)} in ${actualMethod === 'instant' ? '~30 minutes' : '1-2 business days'}.`,
        arrivalTime: actualMethod === 'instant' ? '~30 minutes' : '1-2 business days'
      });

    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }

  } catch (error) {
    console.error('Cash out error:', error);
    res.status(500).json({ error: error.message || 'Failed to process cash out' });
  }
});

// ============= CONTACTS API =============

// Get user's contacts
app.get('/api/contacts', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.id, c.display_name, c.created_at,
             u.id as user_id, u.username, u.email, u.name
      FROM contacts c
      JOIN users u ON c.contact_user_id = u.id
      WHERE c.user_id = $1
      ORDER BY c.display_name ASC, u.name ASC
    `, [req.userId]);

    res.json({ contacts: result.rows });
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({ error: 'Failed to get contacts' });
  }
});

// Add contact
app.post('/api/contacts', authMiddleware, async (req, res) => {
  try {
    const { username, email, display_name } = req.body;

    if (!username && !email) {
      return res.status(400).json({ error: 'Username or email required' });
    }

    // Build query to find user by username and/or email
    let userResult;
    if (username && email) {
      // Both provided - find user matching either
      userResult = await pool.query(
        'SELECT id, username, email, name FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)',
        [username, email]
      );
    } else if (username) {
      // Only username provided
      userResult = await pool.query(
        'SELECT id, username, email, name FROM users WHERE LOWER(username) = LOWER($1)',
        [username]
      );
    } else {
      // Only email provided
      userResult = await pool.query(
        'SELECT id, username, email, name FROM users WHERE LOWER(email) = LOWER($1)',
        [email]
      );
    }

    if (!userResult.rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }

    const contactUser = userResult.rows[0];

    // Cannot add yourself
    if (contactUser.id === req.userId) {
      return res.status(400).json({ error: 'Cannot add yourself as a contact' });
    }

    // Check if already a contact
    const existing = await pool.query(
      'SELECT id FROM contacts WHERE user_id = $1 AND contact_user_id = $2',
      [req.userId, contactUser.id]
    );

    if (existing.rows[0]) {
      return res.status(400).json({ error: 'Already in contacts' });
    }

    // Add contact
    await pool.query(
      'INSERT INTO contacts (user_id, contact_user_id, display_name) VALUES ($1, $2, $3)',
      [req.userId, contactUser.id, display_name || contactUser.name]
    );

    res.json({
      success: true,
      contact: {
        user_id: contactUser.id,
        username: contactUser.username,
        email: contactUser.email,
        name: contactUser.name,
        display_name: display_name || contactUser.name
      }
    });
  } catch (error) {
    console.error('Add contact error:', error);
    res.status(500).json({ error: 'Failed to add contact' });
  }
});

// Remove contact
app.delete('/api/contacts/:contactId', authMiddleware, async (req, res) => {
  try {
    const { contactId } = req.params;

    await pool.query(
      'DELETE FROM contacts WHERE id = $1 AND user_id = $2',
      [contactId, req.userId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Remove contact error:', error);
    res.status(500).json({ error: 'Failed to remove contact' });
  }
});

// Search users by username or email
app.get('/api/users/search', authMiddleware, async (req, res) => {
  try {
    const { query } = req.query;

    if (!query || query.length < 2) {
      return res.json({ users: [] });
    }

    const result = await pool.query(`
      SELECT id, username, email, name
      FROM users
      WHERE (LOWER(username) LIKE LOWER($1) OR LOWER(email) LIKE LOWER($1))
        AND id != $2
      LIMIT 10
    `, [`%${query}%`, req.userId]);

    res.json({ users: result.rows });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// ============= PAYMENT REQUESTS API =============

// Get payment requests (both sent and received)
app.get('/api/payment-requests', authMiddleware, async (req, res) => {
  try {
    // Requests I've sent
    const sentResult = await pool.query(`
      SELECT pr.*,
             u.username as requestee_username, u.email as requestee_email, u.name as requestee_name
      FROM payment_requests pr
      JOIN users u ON pr.requestee_id = u.id
      WHERE pr.requester_id = $1
      ORDER BY pr.created_at DESC
    `, [req.userId]);

    // Requests I've received
    const receivedResult = await pool.query(`
      SELECT pr.*,
             u.username as requester_username, u.email as requester_email, u.name as requester_name
      FROM payment_requests pr
      JOIN users u ON pr.requester_id = u.id
      WHERE pr.requestee_id = $1
      ORDER BY pr.created_at DESC
    `, [req.userId]);

    res.json({
      sent: sentResult.rows,
      received: receivedResult.rows,
      pending_count: receivedResult.rows.filter(r => r.status === 'pending').length
    });
  } catch (error) {
    console.error('Get payment requests error:', error);
    res.status(500).json({ error: 'Failed to get payment requests' });
  }
});

// Create payment request
app.post('/api/payment-requests', authMiddleware, async (req, res) => {
  try {
    const { recipient_username, recipient_email, amount, message } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    if (!recipient_username && !recipient_email) {
      return res.status(400).json({ error: 'Recipient username or email required' });
    }

    // Find recipient
    let recipientResult;
    if (recipient_username) {
      recipientResult = await pool.query(
        'SELECT id, username, email FROM users WHERE LOWER(username) = LOWER($1)',
        [recipient_username]
      );
    } else {
      recipientResult = await pool.query(
        'SELECT id, username, email FROM users WHERE LOWER(email) = LOWER($1)',
        [recipient_email]
      );
    }

    if (!recipientResult.rows[0]) {
      return res.status(404).json({
        error: 'User not found on Supreme Transfer',
        user_not_found: true,
        invite_link: `https://supremetransfer.bluesapps.com/join?ref=${encodeURIComponent(req.userId)}`
      });
    }

    const recipientUserId = recipientResult.rows[0].id;

    if (recipientUserId === req.userId) {
      return res.status(400).json({ error: 'Cannot request money from yourself' });
    }

    // Create payment request
    const result = await pool.query(
      'INSERT INTO payment_requests (requester_id, requestee_id, amount, message) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.userId, recipientUserId, amount, message]
    );

    res.json({ success: true, request: result.rows[0] });
  } catch (error) {
    console.error('Create payment request error:', error);
    res.status(500).json({ error: 'Failed to create payment request' });
  }
});

// Approve payment request (pay it)
app.post('/api/payment-requests/:requestId/approve', authMiddleware, async (req, res) => {
  try {
    const { requestId } = req.params;

    // Get request details
    const requestResult = await pool.query(
      'SELECT * FROM payment_requests WHERE id = $1 AND requestee_id = $2 AND status = $3',
      [requestId, req.userId, 'pending']
    );

    if (!requestResult.rows[0]) {
      return res.status(404).json({ error: 'Payment request not found or already processed' });
    }

    const paymentRequest = requestResult.rows[0];

    // Load payment request fee settings
    let requestFeePct = 5;
    let requestFeeMin = 100; // cents
    const feeRows = await pool.query(
      `SELECT setting_key, setting_value FROM system_settings
       WHERE setting_key IN ('payment_request_fee_pct', 'payment_request_fee_min')`
    );
    feeRows.rows.forEach(row => {
      const parsed = parseFloat(row.setting_value);
      if (row.setting_key === 'payment_request_fee_pct') requestFeePct = isNaN(parsed) ? 5 : parsed;
      if (row.setting_key === 'payment_request_fee_min') requestFeeMin = isNaN(parsed) ? 100 : parsed;
    });

    // Calculate fee: max(amount * pct / 100, min)
    const calculatedFee = Math.round(paymentRequest.amount * requestFeePct / 100);
    const fee = Math.max(calculatedFee, requestFeeMin);
    const totalDebit = paymentRequest.amount + fee;

    // Check balance (must cover amount + fee)
    const walletResult = await pool.query(
      'SELECT balance, platform_credit FROM wallets WHERE user_id = $1',
      [req.userId]
    );

    const balance = walletResult.rows[0]?.balance || 0;
    const platformCredit = walletResult.rows[0]?.platform_credit || 0;
    const totalAvailable = balance + platformCredit;

    if (totalAvailable < totalDebit) {
      return res.status(400).json({
        error: `Insufficient balance. Available: $${(totalAvailable/100).toFixed(2)}, Required: $${(totalDebit/100).toFixed(2)} (includes $${(fee/100).toFixed(2)} processing fee)`
      });
    }

    // Process payment
    await pool.query('BEGIN');

    try {
      // Determine how much to deduct from each source (amount + fee)
      let balanceUsed = Math.min(balance, totalDebit);
      let platformCreditUsed = totalDebit - balanceUsed;

      // Deduct from payer (amount + fee)
      if (balanceUsed > 0) {
        await pool.query(
          'UPDATE wallets SET balance = balance - $1 WHERE user_id = $2',
          [balanceUsed, req.userId]
        );
      }

      if (platformCreditUsed > 0) {
        await pool.query(
          'UPDATE wallets SET platform_credit = platform_credit - $1 WHERE user_id = $2',
          [platformCreditUsed, req.userId]
        );
      }

      // Add exact requested amount to requester
      await pool.query(
        'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
        [paymentRequest.amount, paymentRequest.requester_id]
      );

      // Update request status
      await pool.query(
        'UPDATE payment_requests SET status = $1, responded_at = NOW() WHERE id = $2',
        ['approved', requestId]
      );

      // Create transactions
      await pool.query(
        'INSERT INTO transactions (user_id, type, amount, description, metadata) VALUES ($1, $2, $3, $4, $5)',
        [req.userId, 'send', paymentRequest.amount, `Payment request: ${paymentRequest.message || 'No message'}`,
         JSON.stringify({ payment_request_id: requestId, fee: fee })]
      );

      await pool.query(
        'INSERT INTO transactions (user_id, type, amount, description, metadata) VALUES ($1, $2, $3, $4, $5)',
        [paymentRequest.requester_id, 'receive', paymentRequest.amount, `Payment request: ${paymentRequest.message || 'No message'}`,
         JSON.stringify({ payment_request_id: requestId })]
      );

      // Record fee transaction
      if (fee > 0) {
        await pool.query(
          'INSERT INTO transactions (user_id, type, amount, description, metadata) VALUES ($1, $2, $3, $4, $5)',
          [req.userId, 'fee', fee, `Payment request processing fee (${requestFeePct}%)`,
           JSON.stringify({ payment_request_id: requestId, fee_pct: requestFeePct, fee_min: requestFeeMin })]
        );
      }

      await pool.query('COMMIT');

      res.json({ success: true, message: `Payment of $${(paymentRequest.amount/100).toFixed(2)} sent (fee: $${(fee/100).toFixed(2)})` });

    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }

  } catch (error) {
    console.error('Approve payment request error:', error);
    res.status(500).json({ error: 'Failed to approve payment request' });
  }
});

// Reject payment request
app.post('/api/payment-requests/:requestId/reject', authMiddleware, async (req, res) => {
  try {
    const { requestId } = req.params;

    const result = await pool.query(
      'UPDATE payment_requests SET status = $1, responded_at = NOW() WHERE id = $2 AND requestee_id = $3 AND status = $4 RETURNING *',
      ['rejected', requestId, req.userId, 'pending']
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Payment request not found or already processed' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Reject payment request error:', error);
    res.status(500).json({ error: 'Failed to reject payment request' });
  }
});

// ============= OTHER ROUTES =============

app.get('/api/transactions', authMiddleware, async (req, res) => {
  try {
    if(req.userId==='user_1767184782619'){
      const { user_id } = req.query;
      if(user_id){
        const result = await pool.query(
          'SELECT * FROM transactions, users where transactions.user_id=users.id and transactions.user_id = $1 ORDER BY transactions.created_at DESC',[user_id]);
        res.json({ transactions: result.rows, count: result.rows.length,user_id:user_id })
      } else {
        const result = await pool.query(
          'SELECT * FROM transactions, users where transactions.user_id=users.id ORDER BY transactions.created_at DESC');
        res.json({ transactions: result.rows, count: result.rows.length,user_id:user_id })
      }
    } else {
      const result = await pool.query(
        'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
        [req.userId]
      );
      res.json({ transactions: result.rows, count: result.rows.length });
    }
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to get transactions' });
  }
});

// Get single transaction detail
app.get('/api/transactions/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    res.json({ transaction: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get transaction' });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    hasStripe: !!stripe,
    stripeConfigured: !!process.env.STRIPE_SECRET_KEY
  });
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const kevin = await pool.query(`
      SELECT * FROM users WHERE email = 'kevin@knoxwebhq.com'
    `);
    
    if (kevin.rows.length > 0 && kevin.rows[0].stripe_account_id) {
      const { available, pending } = await getConnectedAccountBalance(kevin.rows[0].stripe_account_id);
      
      // Get platform credit
      const walletResult = await pool.query(
        'SELECT platform_credit FROM wallets WHERE user_id = $1',
        [kevin.rows[0].id]
      );
      const platformCredit = walletResult.rows[0]?.platform_credit || 0;
      
      res.json({
        user: kevin.rows[0],
        balance: {
          available: `$${(available/100).toFixed(2)}`,
          pending: `$${(pending/100).toFixed(2)}`,
          platformCredit: `$${(platformCredit/100).toFixed(2)}`,
          total: `$${((available + platformCredit)/100).toFixed(2)}`,
          accountId: kevin.rows[0].stripe_account_id
        }
      });
    } else {
      res.json({ user: kevin.rows[0] || null });
    }
  } catch (error) {
    res.json({ error: error.message });
  }
});

// ============= EMAIL CONFIGURATION (MAILGUN SMTP) =============
const nodemailer = require('nodemailer');
const mailgunTransporter = nodemailer.createTransport({
  host: 'smtp.mailgun.org',
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || 'invite@bluestoneapps.com',
    pass: process.env.SMTP_PASS || ''
  }
});

// ============= INVITE USER ENDPOINT =============
app.post('/api/invite/send', authMiddleware, async (req, res) => {
  const { email, message } = req.body;

  try {
    // Get sender info
    const senderResult = await pool.query(
      'SELECT name, email FROM users WHERE id = $1',
      [req.userId]
    );

    const sender = senderResult.rows[0];
    const senderName = sender?.name || sender?.email || 'A friend';

    // Generate unique invite code
    const inviteCode = 'inv_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    // Store invitation in database
    await pool.query(
      'INSERT INTO invitations (code, inviter_id, invitee_email, message, status, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
      [inviteCode, req.userId, email.toLowerCase(), message || '', 'pending']
    );

    // Use APP_URL from environment or fallback
    const appUrl = process.env.APP_URL || process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'https://kevin-supreme-transfer-app-production.up.railway.app';

    const signupUrl = `${appUrl}?invite=${inviteCode}`;

    // Create invitation email
    const personalMessage = message ? `\n\n"${message}"\n\n` : '\n\n';

    const emailText = `
Hi there!

${senderName} has invited you to join Supreme Transfer - a simple and secure digital wallet for sending and receiving money.
${personalMessage}
With Supreme Transfer, you can:
• Send and receive money instantly
• Add funds from your card
• Cash out to your bank account
• Track all your transactions

Join now: ${signupUrl}

See you there!
- The Supreme Transfer Team
    `.trim();

    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
    .logo { font-size: 48px; margin-bottom: 10px; }
    .content { background: white; padding: 30px; border: 1px solid #e0e0e0; border-top: none; }
    .message { background: #f8f9ff; padding: 15px; border-left: 4px solid #667eea; margin: 20px 0; font-style: italic; }
    .features { background: #f8f9fa; padding: 20px; border-radius: 10px; margin: 20px 0; }
    .feature { margin: 10px 0; padding-left: 25px; position: relative; }
    .feature:before { content: "✓"; position: absolute; left: 0; color: #28a745; font-weight: bold; }
    .cta { text-align: center; margin: 30px 0; }
    .button { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 10px; display: inline-block; font-weight: 600; }
    .footer { text-align: center; color: #666; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">💰</div>
      <h1 style="margin: 0;">You're Invited to Supreme Transfer!</h1>
    </div>
    <div class="content">
      <p>Hi there!</p>
      <p><strong>${senderName}</strong> has invited you to join <strong>Supreme Transfer</strong> - a simple and secure digital wallet for sending and receiving money.</p>
      ${message ? `<div class="message">"${message}"</div>` : ''}
      <div class="features">
        <h3 style="margin-top: 0;">With Supreme Transfer, you can:</h3>
        <div class="feature">Send and receive money instantly</div>
        <div class="feature">Add funds from your card</div>
        <div class="feature">Cash out to your bank account</div>
        <div class="feature">Track all your transactions</div>
      </div>
      <div class="cta">
        <a href="${signupUrl}" class="button">Join Supreme Transfer Now</a>
      </div>
      <p style="color: #666; font-size: 14px;">Click the button above to create your free account and start sending money!</p>
    </div>
    <div class="footer">
      <p>This invitation was sent by ${senderName} (${sender?.email})</p>
      <p>© ${new Date().getFullYear()} Supreme Transfer. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
    `.trim();

    // Send email via Mailgun SMTP
    await mailgunTransporter.sendMail({
      from: 'Cash Flow App <invite@bluestoneapps.com>',
      to: email,
      subject: `${senderName} invited you to join Supreme Transfer! 💰`,
      text: emailText,
      html: emailHtml
    });

    // Log the invitation
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, description, metadata) VALUES ($1, $2, $3, $4, $5)',
      [req.userId, 'invite_sent', 0, `Invited ${email}`,
       JSON.stringify({ invited_email: email, message: message })]
    );

    res.json({
      success: true,
      message: `Invitation sent to ${email}`
    });

  } catch (error) {
    console.error('Invite error:', error);
    res.status(500).json({ error: 'Failed to send invitation: ' + error.message });
  }
});

// ============= PAYMENT METHODS ENDPOINTS =============

// Get user's payment methods
app.get('/api/payments/methods', authMiddleware, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    // Get user's Stripe customer ID
    const userResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [req.userId]
    );

    const customerId = userResult.rows[0]?.stripe_customer_id;

    if (!customerId) {
      return res.json({ paymentMethods: [], defaultPaymentMethod: null });
    }

    // Get customer's payment methods
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: 'card'
    });

    // Get customer details for default payment method
    const customer = await stripe.customers.retrieve(customerId);

    res.json({
      paymentMethods: paymentMethods.data,
      defaultPaymentMethod: customer.invoice_settings?.default_payment_method || null
    });

  } catch (error) {
    console.error('Payment methods error:', error);
    res.status(500).json({ error: 'Failed to retrieve payment methods' });
  }
});

// Set default payment method
app.post('/api/payments/set-default', authMiddleware, async (req, res) => {
  const { paymentMethodId } = req.body;

  try {
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    const userResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [req.userId]
    );

    const customerId = userResult.rows[0]?.stripe_customer_id;

    if (!customerId) {
      return res.status(400).json({ error: 'No Stripe customer found' });
    }

    // Update customer's default payment method
    await stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId
      }
    });

    res.json({
      success: true,
      message: 'Default payment method updated'
    });

  } catch (error) {
    console.error('Set default payment method error:', error);
    res.status(500).json({ error: 'Failed to set default payment method' });
  }
});

// Remove payment method
app.post('/api/payments/remove', authMiddleware, async (req, res) => {
  const { paymentMethodId } = req.body;

  try {
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    // Detach payment method from customer
    await stripe.paymentMethods.detach(paymentMethodId);

    res.json({
      success: true,
      message: 'Payment method removed'
    });

  } catch (error) {
    console.error('Remove payment method error:', error);
    res.status(500).json({ error: 'Failed to remove payment method' });
  }
});

// ============= PAYOUT METHODS ENDPOINTS =============

// Get user's payout methods (bank accounts/debit cards from connected account)
app.get('/api/payout/methods', authMiddleware, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    // Get user's Stripe connected account ID
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.userId]
    );

    const accountId = userResult.rows[0]?.stripe_account_id;

    if (!accountId) {
      return res.json({ payoutMethods: [], defaultPayoutMethod: null });
    }

    // Get external accounts (bank accounts and debit cards)
    const externalAccounts = await stripe.accounts.listExternalAccounts(
      accountId,
      { limit: 10 }
    );

    // Get account to find default
    const account = await stripe.accounts.retrieve(accountId);

    res.json({
      payoutMethods: externalAccounts.data,
      defaultPayoutMethod: account.external_accounts?.default_for_currency?.usd || account.default_currency || null
    });

  } catch (error) {
    console.error('Payout methods error:', error);
    res.status(500).json({ error: 'Failed to retrieve payout methods' });
  }
});

// Add payout method - requires bank account token from Stripe
app.post('/api/payout/add', authMiddleware, async (req, res) => {
  const { bankToken } = req.body;

  try {
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.userId]
    );

    const accountId = userResult.rows[0]?.stripe_account_id;

    if (!accountId) {
      return res.status(400).json({ error: 'No Stripe account found. Complete Stripe signup first.' });
    }

    // Add external account to connected account
    const externalAccount = await stripe.accounts.createExternalAccount(
      accountId,
      { external_account: bankToken }
    );

    res.json({
      success: true,
      message: 'Payout method added successfully',
      payoutMethod: externalAccount
    });

  } catch (error) {
    console.error('Add payout method error:', error);
    res.status(500).json({ error: 'Failed to add payout method: ' + error.message });
  }
});

// Set default payout method
app.post('/api/payout/set-default', authMiddleware, async (req, res) => {
  const { externalAccountId } = req.body;

  try {
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.userId]
    );

    const accountId = userResult.rows[0]?.stripe_account_id;

    if (!accountId) {
      return res.status(400).json({ error: 'No Stripe account found' });
    }

    // Update external account to be default
    await stripe.accounts.updateExternalAccount(
      accountId,
      externalAccountId,
      { default_for_currency: true }
    );

    res.json({
      success: true,
      message: 'Default payout method updated'
    });

  } catch (error) {
    console.error('Set default payout method error:', error);
    res.status(500).json({ error: 'Failed to set default payout method' });
  }
});

// Remove payout method
app.post('/api/payout/remove', authMiddleware, async (req, res) => {
  const { externalAccountId } = req.body;

  try {
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.userId]
    );

    const accountId = userResult.rows[0]?.stripe_account_id;

    if (!accountId) {
      return res.status(400).json({ error: 'No Stripe account found' });
    }

    // Delete external account
    await stripe.accounts.deleteExternalAccount(
      accountId,
      externalAccountId
    );

    res.json({
      success: true,
      message: 'Payout method removed'
    });

  } catch (error) {
    console.error('Remove payout method error:', error);
    res.status(500).json({ error: 'Failed to remove payout method' });
  }
});

// ============= STRIPE ACCOUNT LINK =============

// Create Stripe account link for onboarding
app.post('/api/stripe/create-account-link', authMiddleware, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe not configured' });
    }

    // Get or create connected account
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.userId]
    );

    let accountId = userResult.rows[0]?.stripe_account_id;

    // Verify stored account still exists in Stripe; recreate if stale/missing
    if (accountId) {
      try {
        await stripe.accounts.retrieve(accountId);
      } catch (e) {
        console.log(`Stale connected account ${accountId} — recreating for user ${req.userId}`);
        accountId = null;
        await pool.query('UPDATE users SET stripe_account_id = NULL WHERE id = $1', [req.userId]);
      }
    }

    if (!accountId) {
      // Create connected account
      accountId = await getOrCreateConnectedAccount(req.userId, req.userEmail);
    }

    // Auto-accept ToS on behalf of user (they agreed to Supreme Transfer's terms which include Stripe's)
    try {
      const userIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '127.0.0.1';
      await stripe.accounts.update(accountId, {
        tos_acceptance: {
          date: Math.floor(Date.now() / 1000),
          ip: userIp,
          service_agreement: 'full'
        }
      });
    } catch (tosErr) {
      console.warn('ToS acceptance warning (non-fatal):', tosErr.message);
    }

    // Create account link
    const appUrl = process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'https://kevin-supreme-transfer-app-production.up.railway.app');

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${appUrl}/`,
      return_url: `${appUrl}/`,
      type: 'account_onboarding',
    });

    res.json({
      success: true,
      url: accountLink.url
    });

  } catch (error) {
    console.error('Account link error:', error);
    res.status(500).json({ error: 'Failed to create account link: ' + error.message });
  }
});

app.get('/api/admin/platform-advances', async (req, res) => {
  try {
    const advances = await pool.query(`
      SELECT 
        pa.*,
        u.email 
      FROM platform_advances pa
      JOIN users u ON u.id = pa.user_id
      WHERE pa.status = 'advanced'
      ORDER BY pa.advanced_at DESC
    `);
    
    const totalAdvanced = advances.rows.reduce((sum, adv) => sum + adv.net_amount, 0);
    const totalFees = advances.rows.reduce((sum, adv) => sum + adv.fee, 0);
    
    res.json({
      advances: advances.rows,
      summary: {
        totalAdvanced: totalAdvanced,
        totalFees: totalFees,
        count: advances.rows.length,
        formatted: {
          advanced: `$${(totalAdvanced/100).toFixed(2)}`,
          fees: `$${(totalFees/100).toFixed(2)}`
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============= ADMIN PORTAL =============

// Serve admin page
app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ============= ADMIN API ROUTES =============

/**
 * Admin Login
 */
app.post('/admin/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query(
      'SELECT * FROM admin_users WHERE username = $1 AND is_active = true',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const admin = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, admin.password_hash);
    
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await pool.query('UPDATE admin_users SET last_login = NOW() WHERE id = $1', [admin.id]);
    await logActivity(admin.id, 'admin_login', null, null, {}, req.ip);

    const token = jwt.sign(
      { adminId: admin.id, username: admin.username, role: admin.role },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      success: true,
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        email: admin.email,
        full_name: admin.full_name,
        role: admin.role
      }
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * Verify Admin Token
 */
app.get('/admin/api/auth/verify', verifyAdmin, (req, res) => {
  res.json({ success: true, admin: req.admin });
});

/**
 * Change Admin Password
 */
app.post('/admin/api/auth/change-password', verifyAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    // Get current admin user with password
    const result = await pool.query(
      'SELECT * FROM admin_users WHERE id = $1',
      [req.admin.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Admin user not found' });
    }

    const admin = result.rows[0];

    // Verify current password
    const passwordMatch = await bcrypt.compare(currentPassword, admin.password_hash);
    
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const newPasswordHash = await bcrypt.hash(newPassword, 10);

    // Update password
    await pool.query(
      'UPDATE admin_users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newPasswordHash, req.admin.id]
    );

    // Log activity
    await logActivity(req.admin.id, 'password_changed', 'admin', req.admin.id, {}, req.ip);

    res.json({ success: true, message: 'Password changed successfully' });

  } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

/**
 * Get Dashboard Statistics
 */
app.get('/admin/api/stats', verifyAdmin, async (req, res) => {
  try {
    const { from, to } = req.query;
    let dateFilter = '';
    const dateParams = [];
    if (from && to) {
      dateFilter = ` AND created_at BETWEEN $1 AND $2`;
      dateParams.push(new Date(from), new Date(to));
    } else if (from) {
      dateFilter = ` AND created_at >= $1`;
      dateParams.push(new Date(from));
    } else if (to) {
      dateFilter = ` AND created_at <= $1`;
      dateParams.push(new Date(to));
    }

    const usersResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const transactionsResult = await pool.query('SELECT COUNT(*) as count FROM transactions');
    const volumeResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as volume FROM transactions WHERE status = 'completed'${dateFilter}`,
      dateParams
    );
    const revenueResult = await pool.query(
      `SELECT COALESCE(SUM(fee), 0) as revenue FROM platform_advances WHERE status = 'advanced'${dateFilter}`,
      dateParams
    );

    // New stats
    const walletBalanceResult = await pool.query(
      `SELECT COALESCE(SUM(balance), 0) as total FROM wallets`
    );
    const advanceFeeResult = await pool.query(
      `SELECT COALESCE(SUM(fee), 0) as total FROM platform_advances WHERE status = 'advanced'${dateFilter}`,
      dateParams
    );
    const withdrawalResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM admin_withdrawals`
    );
    const userFundsResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE status = 'completed'${dateFilter}`,
      dateParams
    );

    const adminAvailable = parseFloat(advanceFeeResult.rows[0].total) - parseFloat(withdrawalResult.rows[0].total);

    res.json({
      total_users: parseInt(usersResult.rows[0].count),
      total_transactions: parseInt(transactionsResult.rows[0].count),
      transaction_volume: parseFloat(volumeResult.rows[0].volume) / 100,
      platform_revenue: parseFloat(revenueResult.rows[0].revenue) / 100,
      total_wallet_balance: parseFloat(walletBalanceResult.rows[0].total) / 100,
      admin_amount_available: adminAvailable / 100,
      user_funds_waiting: parseFloat(userFundsResult.rows[0].total) / 100
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to load statistics' });
  }
});

// Admin withdrawal endpoint
app.post('/admin/api/withdraw', verifyAdmin, async (req, res) => {
  try {
    const { amount, note } = req.body;
    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    const amountCents = Math.round(parseFloat(amount) * 100);
    await pool.query(
      'INSERT INTO admin_withdrawals (amount, note) VALUES ($1, $2)',
      [amountCents, note || null]
    );
    res.json({ success: true, message: `Withdrawal of $${amount} recorded successfully` });
  } catch (error) {
    console.error('Withdraw error:', error);
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

/**
 * Get Recent Admin Activity
 */
app.get('/admin/api/activity/recent', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, au.username FROM admin_activity_log a
       LEFT JOIN admin_users au ON a.admin_id = au.id
       ORDER BY a.created_at DESC LIMIT 20`
    );
    res.json({ activities: result.rows });
  } catch (error) {
    console.error('Activity error:', error);
    res.json({ activities: [] }); // Return empty array if table doesn't exist yet
  }
});

/**
 * Get Pending Platform Advances
 */
app.get('/admin/api/advances/pending', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pa.*, u.email as user_email, u.name as user_name
       FROM platform_advances pa
       JOIN users u ON pa.user_id = u.id
       WHERE pa.status = 'advanced'
       ORDER BY pa.advanced_at DESC LIMIT 10`
    );
    res.json({ advances: result.rows });
  } catch (error) {
    console.error('Advances error:', error);
    res.json({ advances: [] });
  }
});

/**
 * Platform Fees Report — sums all fee transactions from wallet_transactions
 */
app.get('/admin/api/platform-fees', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         wt.description,
         wt.amount,
         wt.created_at,
         u.email as user_email
       FROM wallet_transactions wt
       LEFT JOIN users u ON wt.user_id = u.id
       WHERE wt.transaction_type = 'fee'
          OR wt.description ILIKE '%admin fee%'
          OR wt.description ILIKE '%cash out admin%'
          OR wt.description ILIKE '%instant fee%'
          OR wt.description ILIKE '%platform fee%'
       ORDER BY wt.created_at DESC
       LIMIT 200`
    );

    const fees = result.rows.map(r => ({
      ...r,
      amount: Math.abs(parseFloat(r.amount))
    }));

    const total = fees.reduce((sum, f) => sum + f.amount, 0);

    res.json({
      fees,
      summary: {
        total: Math.round(total * 100) / 100,
        count: fees.length
      }
    });
  } catch (error) {
    console.error('Platform fees error:', error);
    res.json({ fees: [], summary: { total: 0, count: 0 } });
  }
});

/**
 * Sync all Stripe accounts into in-memory cache
 */
app.post('/admin/api/sync-stripe-accounts', verifyAdmin, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });
  try {
    const result = await pool.query('SELECT id, stripe_account_id FROM users WHERE stripe_account_id IS NOT NULL');
    let synced = 0;
    let failed = 0;
    await Promise.allSettled(result.rows.map(async (u) => {
      try {
        const account = await stripe.accounts.retrieve(u.stripe_account_id);
        stripeAccountCache[u.id] = {
          status: account.charges_enabled ? 'enabled' : 'restricted',
          charges_enabled: account.charges_enabled,
          payouts_enabled: account.payouts_enabled,
          requirements: account.requirements,
          updated_at: new Date().toISOString()
        };
        synced++;
      } catch (err) {
        console.error(`Sync failed for user ${u.id}:`, err.message);
        failed++;
      }
    }));
    res.json({ success: true, synced, failed });
  } catch (error) {
    console.error('Sync stripe accounts error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get platform Stripe balance
 */
app.get('/admin/api/platform-balance', verifyAdmin, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });
  try {
    const balance = await stripe.balance.retrieve();
    const available_usd = (balance.available.find(b => b.currency === 'usd')?.amount || 0) / 100;
    const pending_usd = (balance.pending.find(b => b.currency === 'usd')?.amount || 0) / 100;
    const total_usd = available_usd + pending_usd;
    res.json({
      available_usd,
      pending_usd,
      total_usd,
      formatted: {
        available: `$${available_usd.toFixed(2)}`,
        pending: `$${pending_usd.toFixed(2)}`,
        total: `$${total_usd.toFixed(2)}`
      }
    });
  } catch (error) {
    console.error('Platform balance error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Bulk delete users
 * NOTE: registered BEFORE /admin/api/users/:userId to avoid route conflicts
 */
app.post('/admin/api/users/bulk-delete', verifyAdmin, async (req, res) => {
  const { userIds, confirm } = req.body;
  if (!confirm) return res.status(400).json({ error: 'confirm: true required' });
  if (!Array.isArray(userIds) || userIds.length === 0) return res.status(400).json({ error: 'userIds array required' });

  let deleted = 0;
  const skipped = [];

  for (const userId of userIds) {
    try {
      const userRes = await pool.query('SELECT id, email, name, stripe_account_id FROM users WHERE id = $1', [userId]);
      if (!userRes.rows[0]) { skipped.push({ userId, reason: 'User not found' }); continue; }

      const walletRes = await pool.query('SELECT balance, platform_credit FROM wallets WHERE user_id = $1', [userId]);
      const balance = parseInt(walletRes.rows[0]?.balance) || 0;
      const platformCredit = parseInt(walletRes.rows[0]?.platform_credit) || 0;
      if (balance + platformCredit > 0) {
        skipped.push({ userId, reason: `Balance $${((balance + platformCredit) / 100).toFixed(2)} must be zeroed first` });
        continue;
      }

      await pool.query('DELETE FROM payment_requests WHERE requester_id = $1 OR requestee_id = $1', [userId]);
      await pool.query('DELETE FROM contacts WHERE user_id = $1 OR contact_user_id = $1', [userId]);
      await pool.query('DELETE FROM invitations WHERE inviter_id = $1 OR invitee_id = $1', [userId]);
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM wallet_transactions WHERE user_id = $1', [userId]).catch(() => {});
      await pool.query('DELETE FROM platform_advances WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM wallets WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      deleted++;
    } catch (err) {
      skipped.push({ userId, reason: err.message });
    }
  }

  res.json({ deleted, skipped });
});

/**
 * Get live Stripe status for a user
 * NOTE: registered BEFORE /admin/api/users/:userId to avoid route conflicts
 */
app.get('/admin/api/users/:userId/stripe-status', verifyAdmin, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });
  try {
    const { userId } = req.params;
    const userResult = await pool.query('SELECT stripe_account_id FROM users WHERE id = $1', [userId]);
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });

    const accountId = userResult.rows[0].stripe_account_id;
    if (!accountId) return res.status(400).json({ error: 'No Stripe account connected' });

    const account = await stripe.accounts.retrieve(accountId);
    const restricted = !account.charges_enabled || !!account.requirements?.disabled_reason;
    const status = restricted ? 'restricted' : 'enabled';

    let request_link = null;
    if (restricted) {
      // Try account_update first; fall back to account_onboarding for accounts that haven't completed onboarding
      for (const linkType of ['account_update', 'account_onboarding']) {
        try {
          const link = await stripe.accountLinks.create({
            account: accountId,
            type: linkType,
            refresh_url: 'https://supremetransfer.bluesapps.com/admin',
            return_url: 'https://supremetransfer.bluesapps.com/admin'
          });
          request_link = link.url;
          break;
        } catch (linkErr) {
          console.error(`Failed to create ${linkType} link:`, linkErr.message);
        }
      }
    }

    res.json({
      status,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      requirements: {
        disabled_reason: account.requirements?.disabled_reason || null,
        currently_due: account.requirements?.currently_due || [],
        errors: account.requirements?.errors || []
      },
      request_link
    });
  } catch (error) {
    console.error('Stripe status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get All Users (with pagination and search)
 */
app.get('/admin/api/users', verifyAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT id, name, email, username, stripe_account_id, created_at
      FROM users
    `;
    let params = [];

    if (search) {
      query += ` WHERE email ILIKE $1 OR name ILIKE $1 OR username ILIKE $1`;
      params.push(`%${search}%`);
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    const countQuery = search 
      ? `SELECT COUNT(*) FROM users WHERE email ILIKE $1 OR name ILIKE $1 OR username ILIKE $1`
      : `SELECT COUNT(*) FROM users`;
    const countParams = search ? [`%${search}%`] : [];
    const countResult = await pool.query(countQuery, countParams);

    res.json({
      users: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      limit: parseInt(limit)
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

/**
 * Batch Stripe Account Statuses (must be before /:userId to avoid route conflict)
 */
app.get('/admin/api/users/stripe-statuses', verifyAdmin, async (req, res) => {
  try {
    const { account_ids } = req.query;
    if (!account_ids) return res.json({ statuses: {} });

    const ids = account_ids.split(',').filter(id => id && id.startsWith('acct_'));
    if (ids.length === 0) return res.json({ statuses: {} });

    const results = await Promise.allSettled(
      ids.map(async (accountId) => {
        const account = await stripe.accounts.retrieve(accountId);
        return {
          id: accountId,
          payouts_enabled: account.payouts_enabled,
          charges_enabled: account.charges_enabled,
          details_submitted: account.details_submitted,
          disabled_reason: account.requirements?.disabled_reason || null,
          requirements: {
            currently_due: account.requirements?.currently_due || [],
            past_due: account.requirements?.past_due || [],
            eventually_due: account.requirements?.eventually_due || [],
            disabled_reason: account.requirements?.disabled_reason || null
          }
        };
      })
    );

    const statuses = {};
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        statuses[ids[i]] = result.value;
      } else {
        statuses[ids[i]] = { error: result.reason?.message || 'Failed to fetch' };
      }
    });

    res.json({ statuses });
  } catch (error) {
    console.error('Stripe statuses batch error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get User Details
 */
app.get('/admin/api/users/:userId', verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    const userResult = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const transactionsResult = await pool.query(
      `SELECT * FROM transactions 
       WHERE user_id = $1 OR user_id = $1 
       ORDER BY created_at DESC LIMIT 20`,
      [userId]
    );

    const walletResult = await pool.query(
      'SELECT * FROM wallets WHERE user_id = $1',
      [userId]
    );

    res.json({
      user: userResult.rows[0],
      transactions: transactionsResult.rows,
      wallet: walletResult.rows[0] || null
    });
  } catch (error) {
    console.error('Get user details error:', error);
    res.status(500).json({ error: 'Failed to load user details' });
  }
});

/**
 * Update User
 */
app.put('/admin/api/users/:userId', verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { name, email } = req.body;

    await pool.query(
      `UPDATE users SET name = $1, email = $2 WHERE id = $3`,
      [name, email, userId]
    );

    await logActivity(req.admin.id, 'user_update', 'user', userId, { name, email }, req.ip);

    res.json({ success: true });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

/**
 * Update User's Stripe Account ID (Admin)
 */
app.put('/admin/api/users/:userId/stripe-account', verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { stripe_account_id } = req.body;

    // Validate account ID format
    if (!stripe_account_id || !stripe_account_id.startsWith('acct_')) {
      return res.status(400).json({ error: 'Invalid Stripe account ID format. Must start with "acct_"' });
    }

    // Get old account ID for logging
    const oldResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [userId]
    );

    const oldAccountId = oldResult.rows[0]?.stripe_account_id;

    // Update the account ID
    await pool.query(
      `UPDATE users SET stripe_account_id = $1 WHERE id = $2`,
      [stripe_account_id, userId]
    );

    // Log the change
    await logActivity(
      req.admin.id,
      'stripe_account_id_update',
      'user',
      userId,
      {
        old_account_id: oldAccountId,
        new_account_id: stripe_account_id
      },
      req.ip
    );

    res.json({
      success: true,
      message: 'Stripe account ID updated successfully',
      old_account_id: oldAccountId,
      new_account_id: stripe_account_id
    });
  } catch (error) {
    console.error('Update Stripe account ID error:', error);
    res.status(500).json({ error: 'Failed to update Stripe account ID' });
  }
});

/**
 * Enable Instant Payouts for User's Stripe Account (Admin)
 */

// Credit a user's DB wallet (admin — used for migration and manual adjustments)
app.post('/admin/api/users/:userId/credit-wallet', verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, note } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    await pool.query(
      'INSERT INTO wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2',
      [userId, amount]
    );
    const result = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
    const newBalance = result.rows[0]?.balance || 0;

    console.log(`Admin credited $${(amount/100).toFixed(2)} to wallet for user ${userId}. Note: ${note}. New balance: $${(newBalance/100).toFixed(2)}`);
    res.json({ success: true, credited: amount, newBalance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Disable auto-payouts on ALL connected accounts (run once)
app.post('/admin/api/disable-all-auto-payouts', verifyAdmin, async (req, res) => {
  try {
    const users = await pool.query('SELECT id, stripe_account_id FROM users WHERE stripe_account_id IS NOT NULL');
    const results = [];
    for (const user of users.rows) {
      try {
        await stripe.accounts.update(user.stripe_account_id, {
          settings: { payouts: { schedule: { interval: 'manual' } } }
        });
        results.push({ userId: user.id, accountId: user.stripe_account_id, status: 'ok' });
      } catch (e) {
        results.push({ userId: user.id, accountId: user.stripe_account_id, status: 'error', error: e.message });
      }
    }
    res.json({ updated: results.filter(r => r.status === 'ok').length, failed: results.filter(r => r.status === 'error').length, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/admin/api/users/:userId/enable-instant-payouts', verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    // Get user's Stripe account ID
    const userResult = await pool.query(
      'SELECT stripe_account_id, email FROM users WHERE id = $1',
      [userId]
    );

    if (!userResult.rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }

    const accountId = userResult.rows[0].stripe_account_id;
    const userEmail = userResult.rows[0].email;

    if (!accountId) {
      return res.status(400).json({ error: 'User has no Stripe account connected' });
    }

    // Note: instant_payouts is not a requestable capability for Express accounts.
    // Instant payout availability is determined by Stripe automatically.
    console.log(`Checking instant payout availability for account: ${accountId}`);
    
    const account = await stripe.accounts.retrieve(accountId);

    console.log(`Instant payouts capability status:`, account.capabilities?.instant_payouts);

    // Log the change
    await logActivity(
      req.admin.id,
      'instant_payouts_enabled',
      'account',
      accountId,
      {
        userId,
        userEmail,
        accountId,
        capability_status: account.capabilities?.instant_payouts
      },
      req.ip
    );

    res.json({
      success: true,
      message: 'Instant payouts capability requested successfully',
      accountId: accountId,
      capability_status: account.capabilities?.instant_payouts,
      note: 'Capability may take a few minutes to activate. Check account details to verify.'
    });
  } catch (error) {
    console.error('Enable instant payouts error:', {
      message: error.message,
      type: error.type,
      code: error.code,
      statusCode: error.statusCode,
      raw: error.raw
    });
    
    // Return detailed error information
    res.status(error.statusCode || 500).json({ 
      error: error.message || 'Failed to enable instant payouts',
      stripeErrorCode: error.code,
      stripeErrorType: error.type,
      details: error.type === 'StripeInvalidRequestError' 
        ? 'This account may not be eligible for instant payouts, or the capability may already be enabled.' 
        : 'Check if account meets Stripe requirements for instant payouts'
    });
  }
});

/**
 * Stripe-enrich multiple transactions
 * NOTE: registered BEFORE /admin/api/transactions/:txId to avoid route conflicts
 */
app.post('/admin/api/transactions/stripe-enrich', verifyAdmin, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });
  const { transactionIds } = req.body;
  if (!Array.isArray(transactionIds) || transactionIds.length === 0) return res.status(400).json({ error: 'transactionIds required' });

  try {
    const result = await pool.query(
      'SELECT id, metadata FROM transactions WHERE id = ANY($1::int[])',
      [transactionIds]
    );

    const enrichMap = {};

    // Batch in chunks of 20
    const chunks = [];
    const eligible = result.rows.filter(r => r.metadata?.payment_intent_id);
    for (let i = 0; i < eligible.length; i += 20) chunks.push(eligible.slice(i, i + 20));

    for (const chunk of chunks) {
      await Promise.all(chunk.map(async (row) => {
        const piId = row.metadata.payment_intent_id;
        try {
          const pi = await stripe.paymentIntents.retrieve(piId, { expand: ['payment_method'] });
          const pm = pi.payment_method;
          enrichMap[row.id] = {
            pi_id: pi.id,
            status: pi.status,
            last4: pm?.card?.last4 || null,
            brand: pm?.card?.brand || null
          };
        } catch (err) {
          enrichMap[row.id] = null;
        }
      }));
    }

    res.json(enrichMap);
  } catch (error) {
    console.error('Stripe enrich error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get Stripe detail for a single transaction
 */
app.get('/admin/api/transactions/:txId/stripe-detail', verifyAdmin, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });
  try {
    const { txId } = req.params;
    const txResult = await pool.query('SELECT * FROM transactions WHERE id = $1', [txId]);
    if (!txResult.rows[0]) return res.status(404).json({ error: 'Transaction not found' });

    const tx = txResult.rows[0];
    const piId = tx.metadata?.payment_intent_id;
    if (!piId) return res.json({ error: 'No Stripe payment intent linked' });

    const pi = await stripe.paymentIntents.retrieve(piId, { expand: ['payment_method', 'charges'] });
    const pm = pi.payment_method;

    const charges = (pi.charges?.data || []).map(c => ({
      id: c.id,
      status: c.status,
      amount: c.amount,
      paid: c.paid,
      refunded: c.refunded,
      failure_code: c.failure_code || null,
      failure_message: c.failure_message || null
    }));

    res.json({
      id: pi.id,
      status: pi.status,
      amount: pi.amount,
      currency: pi.currency,
      created: pi.created,
      description: pi.description,
      payment_method: pm ? {
        type: pm.type,
        last4: pm.card?.last4 || null,
        brand: pm.card?.brand || null,
        network: pm.card?.network || null
      } : null,
      charges
    });
  } catch (error) {
    console.error('Stripe tx detail error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get All Transactions
 */
app.get('/admin/api/transactions', verifyAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, status, type, user_id } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT t.*, 
             u1.email as sender_email, u1.name as sender_name,
             u2.email as recipient_email, u2.name as recipient_name
      FROM transactions t
      LEFT JOIN users u1 ON t.user_id = u1.id
      LEFT JOIN users u2 ON t.user_id = u2.id
      WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND t.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (type) {
      query += ` AND t.type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    if (user_id) {
      query += ` AND t.user_id = $${paramIndex}`;
      params.push(user_id);
      paramIndex++;
    }

    query += ` ORDER BY t.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);

    const users = await pool.query('SELECT id,name,balance,username,stripe_account_id,email FROM users');

    res.json({ transactions: result.rows,users: users.rows });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

/**
 * Get Stripe details for a transaction (payment intent + card last4)
 */
app.get('/admin/api/transactions/:txnId/stripe-details', verifyAdmin, async (req, res) => {
  try {
    const { txnId } = req.params;

    const txnResult = await pool.query('SELECT * FROM transactions WHERE id = $1', [txnId]);
    if (!txnResult.rows[0]) return res.status(404).json({ error: 'Transaction not found' });

    const txn = txnResult.rows[0];

    // Look for payment_intent_id in direct column or metadata JSON
    let paymentIntentId = txn.payment_intent_id;
    if (!paymentIntentId && txn.metadata) {
      try {
        const meta = typeof txn.metadata === 'string' ? JSON.parse(txn.metadata) : txn.metadata;
        paymentIntentId = meta.payment_intent_id || meta.stripe_payment_intent_id || null;
      } catch (e) {}
    }

    if (!paymentIntentId) {
      return res.json({ transaction: txn, stripeData: null, message: 'No Stripe payment intent linked to this transaction' });
    }

    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['charges.data.payment_method_details', 'payment_method']
      });

      const charge = paymentIntent.charges?.data?.[0];
      const last4 = charge?.payment_method_details?.card?.last4 || paymentIntent.payment_method?.card?.last4 || null;
      const brand = charge?.payment_method_details?.card?.brand || paymentIntent.payment_method?.card?.brand || null;

      res.json({
        transaction: txn,
        stripeData: {
          payment_intent_id: paymentIntentId,
          status: paymentIntent.status,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          last4,
          brand,
          charge: charge ? {
            id: charge.id,
            status: charge.status,
            amount: charge.amount,
            created: charge.created,
            receipt_url: charge.receipt_url,
            failure_code: charge.failure_code,
            failure_message: charge.failure_message
          } : null,
          created: paymentIntent.created,
          description: paymentIntent.description
        }
      });
    } catch (stripeErr) {
      res.json({ transaction: txn, stripeData: null, stripeError: stripeErr.message });
    }
  } catch (error) {
    console.error('Transaction stripe details error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Public Fee Config (no auth required — used by frontend Cash Out modal)
 */
app.get('/api/config/fees', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT setting_key, setting_value FROM system_settings
       WHERE setting_key IN (
         'instant_payout_fee_percent', 'standard_cashout_fee_percent',
         'standard_cashout_enabled', 'instant_payout_enabled',
         'user_transfer_fee_pct', 'user_transfer_fee_min',
         'cashout_fee_pct', 'cashout_fee_min',
         'pass_stripe_fee_to_user',
         'payment_request_fee_pct', 'payment_request_fee_min'
       )`
    );
    const fees = {
      instant_payout_fee_percent: 1.5,
      standard_cashout_fee_percent: 0,
      standard_cashout_enabled: true,
      instant_payout_enabled: true,
      user_transfer_fee_pct: 5,
      user_transfer_fee_min: 100,
      cashout_fee_pct: 5,
      cashout_fee_min: 100,
      pass_stripe_fee_to_user: true,
      payment_request_fee_pct: 5,
      payment_request_fee_min: 100
    };
    result.rows.forEach(row => {
      if (row.setting_key.includes('_enabled') || row.setting_key === 'pass_stripe_fee_to_user') {
        fees[row.setting_key] = row.setting_value !== 'false';
      } else {
        const parsed = parseFloat(row.setting_value);
        fees[row.setting_key] = isNaN(parsed) ? 0 : parsed;
      }
    });
    res.json({ fees });
  } catch (error) {
    res.json({ fees: {
      instant_payout_fee_percent: 1.5, standard_cashout_fee_percent: 0,
      standard_cashout_enabled: true, instant_payout_enabled: true,
      user_transfer_fee_pct: 5, user_transfer_fee_min: 100,
      cashout_fee_pct: 5, cashout_fee_min: 100, pass_stripe_fee_to_user: true,
      payment_request_fee_pct: 5, payment_request_fee_min: 100
    }});
  }
});

/**
 * Get Stripe Settings
 */
app.get('/admin/api/settings/stripe', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT setting_key, setting_value, setting_type 
       FROM system_settings WHERE setting_key LIKE 'stripe_%'`
    );

    const settings = {};
    result.rows.forEach(row => {
      settings[row.setting_key] = row.setting_type === 'encrypted' ? decrypt(row.setting_value) : row.setting_value;
    });

    res.json({ settings });
  } catch (error) {
    console.error('Get Stripe settings error:', error);
    res.json({ settings: {} }); // Return empty if table doesn't exist yet
  }
});

/**
 * Update Stripe Settings
 */
app.put('/admin/api/settings/stripe', verifyAdmin, async (req, res) => {
  try {
    const settings = req.body;

    if (settings.stripe_test_secret_key && !settings.stripe_test_secret_key.startsWith('sk_test_')) {
      return res.status(400).json({ error: 'Invalid test secret key format' });
    }
    if (settings.stripe_live_secret_key && !settings.stripe_live_secret_key.startsWith('sk_live_')) {
      return res.status(400).json({ error: 'Invalid live secret key format' });
    }

    for (const [key, value] of Object.entries(settings)) {
      const settingType = key.includes('secret_key') ? 'encrypted' : 'string';
      const settingValue = key.includes('secret_key') ? encrypt(value) : value;

      await pool.query(
        `INSERT INTO system_settings (setting_key, setting_value, setting_type, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (setting_key) 
         DO UPDATE SET setting_value = $2, updated_by = $4, updated_at = NOW()`,
        [key, settingValue, settingType, req.admin.id]
      );
    }

    await logActivity(req.admin.id, 'stripe_settings_update', 'settings', 'stripe', settings, req.ip);
    res.json({ success: true });
  } catch (error) {
    console.error('Update Stripe settings error:', error);
    res.status(500).json({ error: 'Failed to update Stripe settings' });
  }
});

/**
 * Get Fee Settings
 */
app.get('/admin/api/settings/fees', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT setting_key, setting_value
       FROM system_settings
       WHERE setting_key LIKE '%_fee_%' OR setting_key LIKE '%_amount' OR setting_key LIKE '%_enabled'`
    );

    const fees = {};
    result.rows.forEach(row => { fees[row.setting_key] = row.setting_value; });
    res.json({ fees });
  } catch (error) {
    console.error('Get fee settings error:', error);
    res.json({ fees: {} });
  }
});

/**
 * Update Fee Settings
 */
app.put('/admin/api/settings/fees', verifyAdmin, async (req, res) => {
  try {
    const fees = req.body;
    for (const [key, value] of Object.entries(fees)) {
      await pool.query(
        `INSERT INTO system_settings (setting_key, setting_value, setting_type, updated_by)
         VALUES ($1, $2, 'string', $3)
         ON CONFLICT (setting_key)
         DO UPDATE SET setting_value = $2, updated_by = $3, updated_at = NOW()`,
        [key, value, req.admin.id]
      );
    }
    await logActivity(req.admin.id, 'fee_settings_update', 'settings', 'fees', fees, req.ip);
    res.json({ success: true });
  } catch (error) {
    console.error('Update fee settings error:', error);
    res.status(500).json({ error: 'Failed to update fee settings' });
  }
});

/**
 * Approve Platform Advance
 */
app.post('/admin/api/advances/:advanceId/approve', verifyAdmin, async (req, res) => {
  try {
    const { advanceId } = req.params;

    await pool.query(
      `UPDATE platform_advances 
       SET status = 'approved', metadata = jsonb_set(COALESCE(metadata, '{}'), '{approved_by}', to_jsonb($1::text))
       WHERE id = $2`,
      [req.admin.id, advanceId]
    );

    await logActivity(req.admin.id, 'advance_approved', 'advance', advanceId, {}, req.ip);
    res.json({ success: true });
  } catch (error) {
    console.error('Approve advance error:', error);
    res.status(500).json({ error: 'Failed to approve advance' });
  }
});

/**
 * Deny Platform Advance
 */
app.post('/admin/api/advances/:advanceId/deny', verifyAdmin, async (req, res) => {
  try {
    const { advanceId } = req.params;
    const { reason } = req.body;

    // Delete the advance record entirely when denied
    await pool.query('DELETE FROM platform_advances WHERE id = $1', [parseInt(advanceId, 10)]);

    await logActivity(req.admin.id, 'advance_denied_deleted', 'advance', advanceId, { reason }, req.ip);
    res.json({ success: true });
  } catch (error) {
    console.error('Deny advance error:', error);
    res.status(500).json({ error: 'Failed to deny advance' });
  }
});

/**
 * Get User's Stripe Balance (Admin)
 */
app.get('/admin/api/users/:userId/stripe-balance', verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    // Get user's Stripe account ID
    const userResult = await pool.query(
      'SELECT stripe_account_id, email FROM users WHERE id = $1',
      [userId]
    );

    if (!userResult.rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }

    const accountId = userResult.rows[0].stripe_account_id;

    if (!accountId) {
      return res.status(400).json({ error: 'User has no Stripe account connected' });
    }

    // Retrieve balance from Stripe
    const balance = await stripe.balance.retrieve({
      stripeAccount: accountId
    });

    const available = balance.available.find(b => b.currency === 'usd')?.amount || 0;
    const pending = balance.pending.find(b => b.currency === 'usd')?.amount || 0;
    const instant_available = balance.instant_available ?
      balance.instant_available.find(b => b.currency === 'usd')?.amount || 0 : 0;

    res.json({
      available,
      pending,
      instant_available,
      currency: 'usd'
    });
  } catch (error) {
    console.error('Get Stripe balance error:', error);
    
    // Check for test/live mode mismatch
    if (error.message && error.message.includes('does not have access to account')) {
      const isLiveKey = process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_');
      const mode = isLiveKey ? 'LIVE' : 'TEST';
      return res.status(400).json({ 
        error: `Stripe mode mismatch. Platform is in ${mode} mode, but this user's account was created in ${isLiveKey ? 'TEST' : 'LIVE'} mode. User needs to reconnect their Stripe account in ${mode} mode, or switch platform to ${isLiveKey ? 'TEST' : 'LIVE'} mode.` 
      });
    }
    
    res.status(500).json({ error: error.message || 'Failed to retrieve Stripe balance' });
  }
});

/**
 * Get Payouts for a User's Connected Account (Admin)
 */
app.get('/admin/api/users/:userId/payouts', verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 10 } = req.query;

    const userResult = await pool.query('SELECT stripe_account_id FROM users WHERE id = $1', [userId]);
    const accountId = userResult.rows[0]?.stripe_account_id;
    if (!accountId) return res.status(400).json({ error: 'No Stripe account connected' });

    // Fetch payouts
    const payouts = await stripe.payouts.list(
      { limit: parseInt(limit) },
      { stripeAccount: accountId }
    );

    // Fetch external accounts (bank/card) for destination details
    const extAccounts = await stripe.accounts.listExternalAccounts(accountId, { limit: 5 });

    // Fetch recent charges for summary
    const charges = await stripe.charges.list(
      { limit: 100 },
      { stripeAccount: accountId }
    );

    const chargesSummary = charges.data.reduce((acc, c) => {
      if (c.status === 'succeeded') {
        acc.count++;
        acc.gross += c.amount;
        acc.fees += c.application_fee_amount || 0;
      }
      return acc;
    }, { count: 0, gross: 0, fees: 0 });
    chargesSummary.total = chargesSummary.gross - chargesSummary.fees;

    const result = payouts.data.map(p => {
      const dest = extAccounts.data.find(a => a.id === p.destination) || null;
      return {
        id: p.id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        arrival_date: p.arrival_date,
        created: p.created,
        method: p.method,
        description: p.description,
        destination: dest ? {
          type: dest.object,
          brand: dest.brand || null,
          last4: dest.last4,
          bank_name: dest.bank_name || null,
          instant_eligible: dest.available_payout_methods?.includes('instant') || false,
          currency: dest.currency
        } : null
      };
    });

    res.json({ payouts: result, charges_summary: chargesSummary });
  } catch (error) {
    console.error('Payouts fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch payouts: ' + error.message });
  }
});

/**
 * Send Funds from Platform to User's Bank (Admin)
 * This mimics Stripe Dashboard's "Add Funds" feature
 */
/**
 * Admin: Force-delete a user — zeros wallet first, then deletes everything
 */
app.delete('/admin/api/users/:userId/force', verifyAdmin, async (req, res) => {
  const { userId } = req.params;
  try {
    const userRes = await pool.query('SELECT id, email, name, stripe_account_id FROM users WHERE id = $1', [userId]);
    if (!userRes.rows[0]) return res.status(404).json({ error: 'User not found' });
    const user = userRes.rows[0];

    // Zero entire wallet (balance + platform_credit)
    await pool.query(
      'UPDATE wallets SET balance = 0, platform_credit = 0 WHERE user_id = $1',
      [userId]
    );

    // Delete in dependency order
    await pool.query('DELETE FROM payment_requests WHERE requester_id = $1 OR requestee_id = $1', [userId]);
    await pool.query('DELETE FROM contacts WHERE user_id = $1 OR contact_user_id = $1', [userId]);
    await pool.query('DELETE FROM invitations WHERE inviter_id = $1 OR invitee_id = $1', [userId]);
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM wallet_transactions WHERE user_id = $1', [userId]).catch(() => {});
    await pool.query('DELETE FROM platform_advances WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM wallets WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    await logActivity(req.admin.id, 'user_force_deleted', 'user', userId,
      { deletedEmail: user.email, deletedBy: req.admin.username }, req.ip);

    res.json({ success: true, message: `User ${user.email} force-deleted successfully.` });
  } catch (error) {
    console.error('Force delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Admin: Delete a user account and all associated data
 */
app.delete('/admin/api/users/:userId', verifyAdmin, async (req, res) => {
  const { userId } = req.params;
  const { confirm } = req.query; // require ?confirm=true as safety check

  if (confirm !== 'true') {
    return res.status(400).json({ error: 'Pass ?confirm=true to confirm deletion' });
  }

  try {
    // Get user info before deleting
    const userRes = await pool.query('SELECT id, email, name, stripe_account_id FROM users WHERE id = $1', [userId]);
    if (!userRes.rows[0]) return res.status(404).json({ error: 'User not found' });

    const user = userRes.rows[0];

    // Check wallet balance — refuse if non-zero balance (funds still owed to user)
    const walletRes = await pool.query('SELECT balance, platform_credit FROM wallets WHERE user_id = $1', [userId]);
    const balance = parseInt(walletRes.rows[0]?.balance) || 0;
    const platformCredit = parseInt(walletRes.rows[0]?.platform_credit) || 0;
    const totalBalance = balance + platformCredit;

    if (totalBalance > 0) {
      return res.status(400).json({
        error: `Cannot delete: user has $${(totalBalance / 100).toFixed(2)} remaining balance. Zero the balance first using Set Balance before deleting.`,
        balance: `$${(totalBalance / 100).toFixed(2)}`
      });
    }

    // Delete in dependency order
    await pool.query('DELETE FROM payment_requests WHERE requester_id = $1 OR requestee_id = $1', [userId]);
    await pool.query('DELETE FROM contacts WHERE user_id = $1 OR contact_user_id = $1', [userId]);
    await pool.query('DELETE FROM invitations WHERE inviter_id = $1 OR invitee_id = $1', [userId]);
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM wallet_transactions WHERE user_id = $1', [userId]).catch(() => {}); // non-fatal if table doesn't exist
    await pool.query('DELETE FROM platform_advances WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM wallets WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    // Log the deletion
    await logActivity(
      req.admin.id,
      'user_deleted',
      'user',
      userId,
      { deletedEmail: user.email, deletedName: user.name, stripeAccountId: user.stripe_account_id, deletedBy: req.admin.username },
      req.ip
    );

    console.log(`Admin ${req.admin.username} deleted user ${userId} (${user.email})`);

    res.json({
      success: true,
      message: `User ${user.email} and all associated data deleted successfully.`,
      deletedUser: { id: userId, email: user.email, name: user.name }
    });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Admin: Set a user's wallet balance directly (for corrections)
 */
app.post('/admin/api/users/:userId/set-balance', verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { balance_dollars, reason } = req.body;

    if (balance_dollars == null || balance_dollars < 0) {
      return res.status(400).json({ error: 'balance_dollars required and must be >= 0' });
    }

    const balanceCents = Math.round(parseFloat(balance_dollars) * 100);

    const userRes = await pool.query('SELECT email, name FROM users WHERE id = $1', [userId]);
    if (!userRes.rows[0]) return res.status(404).json({ error: 'User not found' });

    // Get old balance for logging
    const oldRes = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
    const oldBalance = parseInt(oldRes.rows[0]?.balance) || 0;

    // Set balance (also zero platform_credit when setting to 0)
    await pool.query(
      `INSERT INTO wallets (user_id, balance, platform_credit) VALUES ($1, $2, 0)
       ON CONFLICT (user_id) DO UPDATE SET balance = $2, platform_credit = CASE WHEN $2 = 0 THEN 0 ELSE wallets.platform_credit END`,
      [userId, balanceCents]
    );

    // Record adjustment transaction
    const diff = balanceCents - oldBalance;
    await pool.query(
      `INSERT INTO wallet_transactions (user_id, amount, transaction_type, description)
       VALUES ($1, $2, 'adjustment', $3)
       ON CONFLICT DO NOTHING`,
      [userId, diff, reason || `Admin balance correction: ${(oldBalance/100).toFixed(2)} → ${balance_dollars}`]
    ).catch(() => {}); // non-fatal if wallet_transactions doesn't have this column

    console.log(`Admin balance correction: user ${userId} (${userRes.rows[0].email}): ${(oldBalance/100).toFixed(2)} → $${balance_dollars}`);

    res.json({
      success: true,
      message: `Balance updated to $${balance_dollars}`,
      old_balance: `$${(oldBalance/100).toFixed(2)}`,
      new_balance: `$${balance_dollars}`
    });
  } catch (error) {
    console.error('Set balance error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/admin/api/users/:userId/send-funds', verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, instant = false } = req.body;

    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid userId or amount' });
    }

    // Get user info
    const userResult = await pool.query(
      'SELECT stripe_account_id, email, name FROM users WHERE id = $1',
      [userId]
    );

    if (!userResult.rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }

    const accountId = userResult.rows[0].stripe_account_id;
    const userEmail = userResult.rows[0].email;
    const userName = userResult.rows[0].name;

    if (!accountId) {
      return res.status(400).json({ error: 'User has no Stripe account connected' });
    }

    console.log(`Attempting to send funds to account: ${accountId}`);

    // Verify this is actually a connected account, not the platform account
    try {
      const account = await stripe.accounts.retrieve(accountId);
      console.log(`Account details:`, {
        id: account.id,
        type: account.type,
        email: account.email
      });

      if (account.type !== 'express' && account.type !== 'standard' && account.type !== 'custom') {
        return res.status(400).json({
          error: 'Invalid account type. This must be a Connected Account, not a platform account.',
          accountId: accountId,
          accountType: account.type || 'platform'
        });
      }
    } catch (accountError) {
      console.error('Error retrieving account:', accountError);
      return res.status(400).json({
        error: 'Cannot retrieve account. This may not be a valid Connected Account.',
        details: accountError.message,
        accountId: accountId
      });
    }

    console.log(`Sending funds from platform to ${userName} (${accountId}): $${(amount / 100).toFixed(2)}`);

    // Step 1: Create a transfer from platform to connected account
    let transfer;
    try {
      transfer = await stripe.transfers.create({
        amount: amount,
        currency: 'usd',
        destination: accountId,
        description: `Platform transfer to ${userName || userEmail}`
      });
      console.log(`Transfer created: ${transfer.id}`);
    } catch (transferError) {
      console.error('Transfer error:', {
        message: transferError.message,
        code: transferError.code,
        type: transferError.type,
        accountId: accountId
      });

      // Check if error is about destination being own account
      if (transferError.message && transferError.message.includes('cannot be set to your own account')) {
        return res.status(400).json({
          error: 'The stored Stripe account ID appears to be your platform account, not a Connected Account.',
          details: 'Please update the user\'s Stripe account ID to their actual Express Connected Account ID.',
          currentAccountId: accountId,
          suggestion: 'Check the user\'s account in Stripe Dashboard → Connect → Accounts, and update the account ID in the admin panel.'
        });
      }

      throw transferError;
    }

    // Step 2: Create a payout from the connected account to their bank
    // Admin always uses standard payout
    const payout = await stripe.payouts.create({
      amount: amount,
      currency: 'usd',
      method: 'standard',
      description: `Admin payout for ${userName || userEmail}`
    }, {
      stripeAccount: accountId
    });

    console.log(`Payout created: ${payout.id}, method: standard`);

    // Record transaction
    await pool.query(
      `INSERT INTO transactions 
       (user_id, type, amount, status, description, metadata) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        'platform_payout',
        amount,
        'completed',
        `Platform standard payout by admin`,
        JSON.stringify({
          transfer_id: transfer.id,
          payout_id: payout.id,
          admin_id: req.admin.id,
          admin_email: req.admin.email,
          method: 'standard'
        })
      ]
    );

    // Log activity
    await logActivity(
      req.admin.id,
      'platform_payout_sent',
      'payout',
      payout.id,
      {
        userId,
        userEmail,
        amount,
        method: 'standard',
        transferId: transfer.id,
        payoutId: payout.id
      },
      req.ip
    );

    res.json({
      success: true,
      transferId: transfer.id,
      payoutId: payout.id,
      amount,
      method: 'standard',
      message: `Successfully sent $${(amount / 100).toFixed(2)} to ${userName}'s bank account`
    });
  } catch (error) {
    console.error('Platform payout error:', {
      message: error.message,
      code: error.code,
      type: error.type
    });
    
    // Return detailed error
    res.status(error.statusCode || 500).json({ 
      error: error.message || 'Failed to send funds',
      stripeErrorCode: error.code,
      stripeErrorType: error.type
    });
  }
});

/**
 * Get Stripe Account Details (Admin - Diagnostic)
 */
app.get('/admin/api/users/:userId/stripe-account-details', verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    // Get user's Stripe account ID
    const userResult = await pool.query(
      'SELECT stripe_account_id, email FROM users WHERE id = $1',
      [userId]
    );

    if (!userResult.rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }

    const accountId = userResult.rows[0].stripe_account_id;

    if (!accountId) {
      return res.status(400).json({ error: 'User has no Stripe account connected' });
    }

    // Retrieve full account details from Stripe
    const account = await stripe.accounts.retrieve(accountId);

    // Return relevant diagnostic information
    res.json({
      id: account.id,
      type: account.type,
      country: account.country,
      capabilities: account.capabilities,
      payouts_enabled: account.payouts_enabled,
      charges_enabled: account.charges_enabled,
      details_submitted: account.details_submitted,
      settings: {
        payouts: account.settings?.payouts,
        card_payments: account.settings?.card_payments
      },
      requirements: account.requirements,
      created: account.created
    });
  } catch (error) {
    console.error('Get Stripe account details error:', error);
    res.status(500).json({ error: error.message || 'Failed to retrieve account details' });
  }
});

/**
 * Send Manual Payout (Admin)
 */
app.post('/admin/api/payouts/send', verifyAdmin, async (req, res) => {
  try {
    const { userId, amount, instant = false } = req.body;

    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid userId or amount' });
    }

    // Get user info
    const userResult = await pool.query(
      'SELECT stripe_account_id, email, name FROM users WHERE id = $1',
      [userId]
    );

    if (!userResult.rows[0]) {
      return res.status(404).json({ error: 'User not found' });
    }

    const accountId = userResult.rows[0].stripe_account_id;
    const userEmail = userResult.rows[0].email;
    const userName = userResult.rows[0].name;

    if (!accountId) {
      return res.status(400).json({ error: 'User has no Stripe account connected' });
    }

    // Check available balance (use regular available for both instant and standard)
    const balance = await stripe.balance.retrieve({
      stripeAccount: accountId
    });

    const available = balance.available.find(b => b.currency === 'usd')?.amount || 0;

    // Check if user has sufficient balance
    if (available < amount) {
      return res.status(400).json({
        error: `Insufficient balance. Available: $${(available / 100).toFixed(2)}, Requested: $${(amount / 100).toFixed(2)}`
      });
    }

    // Try to create payout - let Stripe determine if instant is allowed
    // Stripe will reject instant payouts if the account isn't eligible
    let payout;
    try {
      payout = await stripe.payouts.create({
        amount: amount,
        currency: 'usd',
        method: instant ? 'instant' : 'standard',
        description: `Admin manual payout for ${userName || userEmail}`
      }, {
        stripeAccount: accountId
      });
    } catch (payoutError) {
      // Log full error details for debugging
      console.error('Stripe payout error details:', {
        code: payoutError.code,
        type: payoutError.type,
        message: payoutError.message,
        decline_code: payoutError.decline_code,
        raw: payoutError.raw,
        accountId: accountId,
        amount: amount,
        instant: instant
      });

      // Return detailed error with Stripe's actual message
      if (instant) {
        return res.status(400).json({
          error: payoutError.message || 'Instant payout failed',
          stripeErrorCode: payoutError.code,
          stripeErrorType: payoutError.type,
          suggestion: 'Try using Standard payout instead, or check account settings in Stripe Dashboard',
          availableBalance: `$${(available / 100).toFixed(2)}`,
          accountId: accountId,
          debugInfo: {
            message: payoutError.message,
            code: payoutError.code,
            type: payoutError.type
          }
        });
      }
      // If it's a different error, throw it to be caught by outer catch
      throw payoutError;
    }

    // Record transaction
    await pool.query(
      `INSERT INTO transactions 
       (user_id, type, amount, status, description, metadata) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        'admin_payout',
        amount,
        'completed',
        `Manual ${instant ? 'instant' : 'standard'} payout by admin`,
        JSON.stringify({
          payout_id: payout.id,
          admin_id: req.admin.id,
          admin_email: req.admin.email,
          method: instant ? 'instant' : 'standard'
        })
      ]
    );

    // Log activity
    await logActivity(
      req.admin.id,
      'manual_payout_sent',
      'payout',
      payout.id,
      {
        userId,
        userEmail,
        amount,
        instant,
        payoutId: payout.id
      },
      req.ip
    );

    res.json({
      success: true,
      payoutId: payout.id,
      amount,
      method: instant ? 'instant' : 'standard',
      message: `Payout of $${(amount / 100).toFixed(2)} sent successfully`
    });
  } catch (error) {
    console.error('Manual payout error:', error);
    
    // Check for test/live mode mismatch
    if (error.message && error.message.includes('does not have access to account')) {
      const isLiveKey = process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_');
      const mode = isLiveKey ? 'LIVE' : 'TEST';
      return res.status(400).json({ 
        error: `Stripe mode mismatch! Platform is in ${mode} mode, but this user's Stripe account was created in ${isLiveKey ? 'TEST' : 'LIVE'} mode. Solution: Either (1) Switch platform to ${isLiveKey ? 'TEST' : 'LIVE'} mode in Admin Settings, or (2) Have user reconnect Stripe account while platform is in ${mode} mode.` 
      });
    }
    
    res.status(500).json({ error: error.message || 'Failed to send payout' });
  }
});

// ============= END ADMIN ROUTES =============

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: 'supreme-transfer-complete-v2',
    features: [
      'connected-accounts',
      'instant-payouts',
      'wallet-credits',
      'platform-advances'
    ],
    stripe: !!stripe
  });
});

// Start server - wait for database initialization first
async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, () => {
      console.log('============================================================');
      console.log('Supreme Transfer Complete Server v2.0');
      console.log(`Port: ${PORT}`);
      console.log(`Stripe: ${stripe ? 'CONNECTED' : 'NOT CONFIGURED'}`);
      console.log('============================================================');
      console.log('Features:');
      console.log('✅ Stripe Connected Accounts');
      console.log('✅ Instant Payouts to Bank (1.5% fee)');
      console.log('✅ Instant Wallet Credits (2% fee)');
      console.log('✅ Platform Advances');
      console.log('✅ User-to-User Transfers');
      console.log('✅ Admin Portal');
      console.log('============================================================');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
