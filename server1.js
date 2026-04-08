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

// Middleware
app.use(cors());
app.use(express.json());
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

// Call on server start - wrap in async initialization
async function initializeDatabase() {
  console.log('Initializing database...');
  await createPlatformAdvanceTables();
  await createWalletsTable();
  await createInvitationsTable();
  await migratePasswordColumn();
  await addUsernameColumn();
  await createContactsTable();
  await createPaymentRequestsTable();
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
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'US',
        email: email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        },
        business_profile: {
          mcc: '7392',  // Consulting services - Management, Consulting, and Public Relations
          url: 'https://supremetransfer.bluesapps.com',
          product_description: 'Individual payment services'
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
    const result = await pool.query('SELECT * FROM users WHERE email = $1 and password=$2', [email.toLowerCase(),password]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    const user = result.rows[0];
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
  // try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid User' });
    }    
    await pool.query(
      'UPDATE users SET password = $1, otp = NULL WHERE email = $2', 
      [password, email]
    );
    res.json({email:email,message:'Password reset successfully'});
  // } catch (error) {
  //   res.status(500).json({ error: 'Login failed' });
  // }
});

app.post('/api/auth/registerAppUser', async (req, res) => {
  const { email, password, name, inviteCode,username } = req.body;

  try {

    const checking_user = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    
    if (checking_user.rows.length > 0) {
      return res.status(401).json({ error: 'username already exist' });
    }

    const userId = 'user_' + Date.now();

    const result = await pool.query(
      'INSERT INTO users (id, email, password, name,username) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [userId, email.toLowerCase(), password || 'test', name || email.split('@')[0],username]
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
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed: ' + error.message });
  }
});


app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, inviteCode } = req.body;

  try {
    const userId = 'user_' + Date.now();

    const result = await pool.query(
      'INSERT INTO users (id, email, password, name) VALUES ($1, $2, $3, $4) RETURNING *',
      [userId, email.toLowerCase(), password || 'test', name || email.split('@')[0]]
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
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed: ' + error.message });
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
    // Get user's Connected Account
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.userId]
    );
    
    const accountId = userResult.rows[0]?.stripe_account_id;
    
    if (!accountId) {
      return res.json({
        balance: 0,
        formatted: '$0.00',
        pending: 0,
        pendingFormatted: '$0.00',
        hasAccount: false
      });
    }
    
    // Get balance from Stripe
    const { available, pending } = await getConnectedAccountBalance(accountId);

    // Get wallet balance and platform credit
    const walletResult = await pool.query(
      'SELECT balance, platform_credit FROM wallets WHERE user_id = $1',
      [req.userId]
    );
    const walletBalance = parseInt(walletResult.rows[0]?.balance) || 0;
    const platformCredit = parseInt(walletResult.rows[0]?.platform_credit) || 0;

    // Total available includes Stripe balance + wallet balance + platform credit
    const totalAvailable = parseInt(available) + walletBalance + platformCredit;
    
    res.json({
      balance: totalAvailable,
      formatted: `$${(totalAvailable / 100).toFixed(2)}`,
      pending: pending,
      pendingFormatted: `$${(pending / 100).toFixed(2)}`,
      platformCredit: platformCredit,
      platformCreditFormatted: `$${(platformCredit / 100).toFixed(2)}`,
      hasAccount: true,
      accountId: accountId
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
  const { amount } = req.body;
  
  console.log(`Creating payment intent for $${amount/100}`);
  
  if (!amount || amount < 100) {
    return res.status(400).json({ error: 'Minimum amount is $1.00' });
  }
  
  if (!stripe) {
    return res.json({
      clientSecret: 'mock_secret_' + Date.now(),
      amount: amount,
      mock: true
    });
  }
  
  try {
    // Get or create user's Connected Account
    const accountId = await getOrCreateConnectedAccount(req.userId, req.userEmail);
    
    // Get or create Stripe customer
    const userResult = await pool.query(
      'SELECT email, stripe_customer_id FROM users WHERE id = $1',
      [req.userId]
    );
    
    const user = userResult.rows[0];
    let customerId = user.stripe_customer_id;
    
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: {
          user_id: req.userId
        }
      });
      customerId = customer.id;
      
      await pool.query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, req.userId]
      );
    }
    
    // Create payment intent with transfer data
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: 'usd',
      customer: customerId,
      setup_future_usage: 'off_session', // Save payment method for future use
      transfer_data: {
        destination: accountId,
      },
      metadata: {
        user_id: req.userId,
        type: 'add_funds_to_wallet'
      }
    });
    
    console.log(`Created payment intent ${paymentIntent.id} with transfer to ${accountId}`);
    
    // Record pending transaction
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, description, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.userId, 'deposit', amount, 'pending', 
       `Adding $${(amount/100).toFixed(2)} to wallet`,
       JSON.stringify({ payment_intent_id: paymentIntent.id, account_id: accountId })]
    );
    
    res.json({
      clientSecret: paymentIntent.client_secret,
      amount: amount,
      paymentIntentId: paymentIntent.id,
      destinationAccount: accountId
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
    // If real payment intent, retrieve it and save the payment method
    if (stripe && payment_intent_id && payment_intent_id !== 'mock_secret') {
      const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);

      // If payment method was used, it's already attached to customer due to setup_future_usage
      if (paymentIntent.payment_method) {
        console.log(`Payment method ${paymentIntent.payment_method} saved to customer ${paymentIntent.customer}`);
      }

      await pool.query(
        "UPDATE transactions SET status = 'completed' WHERE metadata->>'payment_intent_id' = $1",
        [payment_intent_id]
      );
    } else {
      // Create completed transaction
      await pool.query(
        'INSERT INTO transactions (user_id, type, amount, status, description) VALUES ($1, $2, $3, $4, $5)',
        [req.userId, 'deposit', amount, 'completed', `Added $${(amount/100).toFixed(2)} to wallet`]
      );
    }

    // Get updated balance from Stripe
    const userResult = await pool.query(
      'SELECT stripe_account_id FROM users WHERE id = $1',
      [req.userId]
    );

    const accountId = userResult.rows[0]?.stripe_account_id;

    if (accountId) {
      const { available, pending } = await getConnectedAccountBalance(accountId);

      res.json({
        success: true,
        message: `Successfully added $${(amount/100).toFixed(2)} to your Stripe wallet`,
        balance: available,
        pending: pending,
        formatted: `$${(available/100).toFixed(2)}`,
        note: 'Funds may appear as pending for 2-7 days'
      });
    } else {
      res.json({
        success: true,
        message: `Payment confirmed`,
        amount: amount
      });
    }

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
  const { amount, forceStandard } = req.body; // amount in cents, forceStandard flag

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

    console.log(`Processing ${forceStandard ? 'standard' : 'instant'} payout for account ${accountId}`);

    const balance = await stripe.balance.retrieve({
      stripeAccount: accountId
    });

    const instantAvailable = balance.instant_available ?
      balance.instant_available.find(b => b.currency === 'usd')?.amount || 0 : 0;

    const regularAvailable = balance.available.find(b => b.currency === 'usd')?.amount || 0;
    const availableAmount = instantAvailable || regularAvailable;

    if (availableAmount === 0) {
      return res.status(400).json({
        error: 'No funds available for instant payout',
        availableSoon: balance.pending.find(b => b.currency === 'usd')?.amount || 0
      });
    }

    // Use provided amount or full available
    const payoutAmount = amount || availableAmount;

    if (payoutAmount > availableAmount) {
      return res.status(400).json({
        error: `Maximum instant payout available: $${(availableAmount/100).toFixed(2)}`
      });
    }

    // Calculate fee (1.5% with $0.50 minimum)
    const fee = Math.max(50, Math.round(payoutAmount * 0.015));
    const netAmount = payoutAmount - fee;

    console.log(`Payout: $${(payoutAmount/100).toFixed(2)} (fee: $${(fee/100).toFixed(2)})`);

    let payout;
    let payoutMethod = 'instant';
    let arrivalMessage = 'within 30 minutes';

    // If user confirmed to use standard, go directly to standard
    if (forceStandard) {
      payout = await stripe.payouts.create({
        amount: payoutAmount,
        currency: 'usd',
        method: 'standard',
        description: 'Standard payout from wallet'
      }, {
        stripeAccount: accountId
      });

      payoutMethod = 'standard';
      arrivalMessage = 'by next business day';
      console.log(`Standard payout created: ${payout.id}`);

    } else {
      // Try instant payout
      try {
        payout = await stripe.payouts.create({
          amount: payoutAmount,
          currency: 'usd',
          method: 'instant',
          description: 'Instant payout from wallet'
        }, {
          stripeAccount: accountId
        });

        console.log(`Success! Instant payout created: ${payout.id}`);

      } catch (instantError) {
        // Check if error is due to instant not being supported
        if (instantError.message && instantError.message.includes('instant')) {
          console.log('Instant payout not supported by bank');

          // Return error to ask user for confirmation
          return res.status(400).json({
            error: 'instant_not_supported',
            message: 'Your bank doesnt support instant payouts. Send funds next business day?',
            requiresConfirmation: true,
            amount: payoutAmount,
            fee: fee,
            netAmount: netAmount
          });
        } else {
          // Different error, re-throw
          throw instantError;
        }
      }
    }

    // Record transaction
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, description, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.userId, 'instant_payout', payoutAmount, 'completed',
       `${payoutMethod === 'instant' ? 'Instant' : 'Standard'} payout to bank (fee: $${(fee/100).toFixed(2)})`,
       JSON.stringify({ payout_id: payout.id, fee: fee, net: netAmount, method: payoutMethod })]
    );

    res.json({
      success: true,
      message: `Payout initiated! You'll receive $${(netAmount/100).toFixed(2)} after fees.`,
      method: payoutMethod,
      fallbackUsed: forceStandard,
      arrivalMessage: arrivalMessage,
      payout: {
        id: payout.id,
        amount: payoutAmount,
        fee: fee,
        netAmount: netAmount,
        status: payout.status,
        arrival_date: payout.arrival_date
      },
      formatted: {
        requested: `$${(payoutAmount/100).toFixed(2)}`,
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

// Regular Cash Out (Standard ACH) - No fees
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
      return res.status(400).json({ error: 'No Connected Account linked' });
    }

    console.log(`Processing cash out for account ${accountId}`);

    const balance = await stripe.balance.retrieve({
      stripeAccount: accountId
    });

    const regularAvailable = balance.available.find(b => b.currency === 'usd')?.amount || 0;

    if (regularAvailable === 0) {
      return res.status(400).json({
        error: 'No funds available for cash out',
        availableSoon: balance.pending.find(b => b.currency === 'usd')?.amount || 0
      });
    }

    // Use provided amount or full available
    const payoutAmount = amount || regularAvailable;

    if (payoutAmount > regularAvailable) {
      return res.status(400).json({
        error: `Maximum cash out available: $${(regularAvailable/100).toFixed(2)}`
      });
    }

    console.log(`Cash out: $${(payoutAmount/100).toFixed(2)}`);

    // Create standard payout (no fee for standard ACH)
    const payout = await stripe.payouts.create({
      amount: payoutAmount,
      currency: 'usd',
      method: 'standard',
      description: 'Cash out to bank account'
    }, {
      stripeAccount: accountId
    });

    console.log(`Success! Cash out created: ${payout.id}`);

    // Record transaction
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, description, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.userId, 'cash_out', payoutAmount, 'completed',
       'Cash out to bank account',
       JSON.stringify({ payout_id: payout.id, method: 'standard' })]
    );

    res.json({
      success: true,
      message: `Cash out initiated! You'll receive $${(payoutAmount/100).toFixed(2)} by next business day.`,
      payout: {
        id: payout.id,
        amount: payoutAmount,
        status: payout.status,
        arrival_date: payout.arrival_date
      },
      formatted: {
        amount: `$${(payoutAmount/100).toFixed(2)}`
      }
    });

  } catch (error) {
    console.error('Cash out error:', error);
    res.status(500).json({
      error: error.message,
      type: error.type
    });
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

    // Check if sender has sufficient balance
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
      // Create wallet for recipient
      await pool.query(
        'INSERT INTO wallets (user_id, balance, platform_credit) VALUES ($1, 0, 0)',
        [recipientUserId]
      );
    }

    // Determine how much to deduct from each source
    let balanceUsed = Math.min(senderBalance, amount);
    let platformCreditUsed = amount - balanceUsed;

    // Use a transaction to ensure atomicity
    await pool.query('BEGIN');

    try {
      // Deduct from sender's wallet
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

      // Add to recipient's wallet
      await pool.query(
        'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
        [amount, recipientUserId]
      );

      // Record transactions
      await pool.query(
        'INSERT INTO transactions (user_id, type, amount, description, metadata) VALUES ($1, $2, $3, $4, $5)',
        [req.userId, 'send', amount, note || 'Transfer sent',
         JSON.stringify({
           recipient: recipient_email,
           balance_used: balanceUsed,
           platform_credit_used: platformCreditUsed
         })]
      );

      await pool.query(
        'INSERT INTO transactions (user_id, type, amount, description, metadata) VALUES ($1, $2, $3, $4, $5)',
        [recipientUserId, 'receive', amount, note || 'Transfer received',
         JSON.stringify({ sender: req.userEmail })]
      );

      await pool.query('COMMIT');

      const data = await pool.query('SELECT onesignalDeviceId FROM device_details WHERE user_id = $1 and status= $2 ', [recipientUserId, "1"]);
      const deviceIds=[];
      if(data.rows.length>0){
        data.rows.forEach(obj => {
            deviceIds.push(obj.onesignaldeviceid);
        });
      }
      const response=sendNotifications( `${req.name ? req.name.toUpperCase() : req.userEmail}`,`$${(amount/100).toFixed(2)} sent funds`,deviceIds);

      res.json({
        success: true,
        message: `Successfully sent $${(amount/100).toFixed(2)} to ${recipient_email}`,
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
      return res.status(404).json({ error: 'Recipient not found' });
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

    // Check balance
    const walletResult = await pool.query(
      'SELECT balance, platform_credit FROM wallets WHERE user_id = $1',
      [req.userId]
    );

    const balance = walletResult.rows[0]?.balance || 0;
    const platformCredit = walletResult.rows[0]?.platform_credit || 0;
    const totalAvailable = balance + platformCredit;

    if (totalAvailable < paymentRequest.amount) {
      return res.status(400).json({
        error: `Insufficient balance. Available: $${(totalAvailable/100).toFixed(2)}, Required: $${(paymentRequest.amount/100).toFixed(2)}`
      });
    }

    // Process payment
    await pool.query('BEGIN');

    try {
      // Determine how much to deduct from each source
      let balanceUsed = Math.min(balance, paymentRequest.amount);
      let platformCreditUsed = paymentRequest.amount - balanceUsed;

      // Deduct from payer
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

      // Add to requester
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
         JSON.stringify({ payment_request_id: requestId })]
      );

      await pool.query(
        'INSERT INTO transactions (user_id, type, amount, description, metadata) VALUES ($1, $2, $3, $4, $5)',
        [paymentRequest.requester_id, 'receive', paymentRequest.amount, `Payment request: ${paymentRequest.message || 'No message'}`,
         JSON.stringify({ payment_request_id: requestId })]
      );

      await pool.query('COMMIT');

      res.json({ success: true, message: `Payment of $${(paymentRequest.amount/100).toFixed(2)} sent` });

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
    user: 'invite@bluestoneapps.com',
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

    if (!accountId) {
      // Create connected account
      accountId = await getOrCreateConnectedAccount(req.userId, req.userEmail);
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
    const usersResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const transactionsResult = await pool.query('SELECT COUNT(*) as count FROM transactions');
    const volumeResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as volume FROM transactions WHERE status = 'completed'`
    );
    const revenueResult = await pool.query(
      `SELECT COALESCE(SUM(fee), 0) as revenue FROM platform_advances WHERE status = 'advanced'`
    );

    res.json({
      total_users: parseInt(usersResult.rows[0].count),
      total_transactions: parseInt(transactionsResult.rows[0].count),
      transaction_volume: parseFloat(volumeResult.rows[0].volume) / 100,
      platform_revenue: parseFloat(revenueResult.rows[0].revenue) / 100
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to load statistics' });
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
       WHERE setting_key LIKE '%_fee_%' OR setting_key LIKE '%_amount'`
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
        `UPDATE system_settings 
         SET setting_value = $1, updated_by = $2, updated_at = NOW() 
         WHERE setting_key = $3`,
        [value, req.admin.id, key]
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

    await pool.query(
      `UPDATE platform_advances 
       SET status = 'denied', metadata = jsonb_set(COALESCE(metadata, '{}'), '{denial_reason}', to_jsonb($1::text))
       WHERE id = $2`,
      [reason, advanceId]
    );

    await logActivity(req.admin.id, 'advance_denied', 'advance', advanceId, { reason }, req.ip);
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

    // Check available balance
    const balance = await stripe.balance.retrieve({
      stripeAccount: accountId
    });

    const available = balance.available.find(b => b.currency === 'usd')?.amount || 0;
    const instant_available = balance.instant_available ?
      balance.instant_available.find(b => b.currency === 'usd')?.amount || 0 : 0;

    if (instant && instant_available < amount) {
      return res.status(400).json({
        error: `Insufficient instant payout balance. Available: $${(instant_available / 100).toFixed(2)}, Requested: $${(amount / 100).toFixed(2)}`
      });
    }

    if (!instant && available < amount) {
      return res.status(400).json({
        error: `Insufficient balance. Available: $${(available / 100).toFixed(2)}, Requested: $${(amount / 100).toFixed(2)}`
      });
    }

    // Create payout
    const payout = await stripe.payouts.create({
      amount: amount,
      currency: 'usd',
      method: instant ? 'instant' : 'standard',
      description: `Admin manual payout for ${userName || userEmail}`
    }, {
      stripeAccount: accountId
    });

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
