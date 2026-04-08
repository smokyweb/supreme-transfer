// MINIMAL APP.JS - Just the essentials
// This is a simpler version if you want to keep your existing code and just add the missing routes

const express = require('express');
const cors = require('cors');
const { pool, initDatabase } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Basic middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Simple JWT implementation (no library needed)
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key';

// Simple token creation
function createToken(userId, email) {
  const payload = JSON.stringify({ userId, email, exp: Date.now() + 7*24*60*60*1000 });
  return Buffer.from(payload).toString('base64');
}

// Simple token verification
function verifyToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    if (payload.exp < Date.now()) throw new Error('Expired');
    return payload;
  } catch {
    return null;
  }
}

// Simple auth middleware
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = payload.userId;
  next();
};

// ============================================
// EXISTING AUTH ROUTES (you probably have these)
// ============================================

app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  try {
    // Simple password storage (not secure - use bcrypt in production!)
    const result = await pool.query(
      'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email, password, name]
    );
    const user = result.rows[0];
    
    // Create wallet
    await pool.query('INSERT INTO wallets (user_id, balance, currency) VALUES ($1, 0, $2)', [user.id, 'USD']);
    
    const token = createToken(user.id, user.email);
    res.json({ token, user });
  } catch (error) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    
    // Simple password check (not secure - use bcrypt in production!)
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    delete user.password;
    const token = createToken(user.id, user.email);
    res.json({ token, user });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============================================
// ADD THESE MISSING ROUTES - THESE ARE CRITICAL!
// ============================================

// GET /api/auth/me - REQUIRED BY FRONTEND
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name FROM users WHERE id = $1',
      [req.userId]
    );
    res.json({ user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// GET /api/wallet/balance - REQUIRED BY FRONTEND
app.get('/api/wallet/balance', authMiddleware, async (req, res) => {
  try {
    let result = await pool.query('SELECT * FROM wallets WHERE user_id = $1', [req.userId]);
    
    // Create wallet if doesn't exist
    if (result.rows.length === 0) {
      result = await pool.query(
        'INSERT INTO wallets (user_id, balance, currency) VALUES ($1, 0, $2) RETURNING *',
        [req.userId, 'USD']
      );
    }
    
    const balance = result.rows[0].balance || 0;
    res.json({
      balance: balance,
      currency: 'USD',
      formatted: `$${(balance / 100).toFixed(2)}`
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

// GET /api/transactions - REQUIRED BY FRONTEND
app.get('/api/transactions', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.userId]
    );
    res.json({
      transactions: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get transactions' });
  }
});

// POST /api/transfers/send - For sending money
app.post('/api/transfers/send', authMiddleware, async (req, res) => {
  const { recipient_email, amount, note } = req.body;
  
  try {
    // Get recipient
    const recipientResult = await pool.query('SELECT id FROM users WHERE email = $1', [recipient_email]);
    if (!recipientResult.rows[0]) {
      return res.status(404).json({ error: 'Recipient not found' });
    }
    
    const recipientId = recipientResult.rows[0].id;
    
    // Check balance
    const walletResult = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [req.userId]);
    if (!walletResult.rows[0] || walletResult.rows[0].balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Transfer money
    await pool.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [amount, req.userId]);
    await pool.query(
      'INSERT INTO wallets (user_id, balance, currency) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2',
      [recipientId, amount, 'USD']
    );
    
    // Record transactions
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, description) VALUES ($1, $2, $3, $4, $5)',
      [req.userId, 'send', amount, 'completed', note || 'Transfer sent']
    );
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, description) VALUES ($1, $2, $3, $4, $5)',
      [recipientId, 'receive', amount, 'completed', note || 'Transfer received']
    );
    
    res.json({ success: true, message: 'Transfer completed' });
  } catch (error) {
    res.status(500).json({ error: 'Transfer failed' });
  }
});

// POST /api/payments/create-intent - For Stripe payments
app.post('/api/payments/create-intent', authMiddleware, async (req, res) => {
  // Mock response - implement Stripe here if needed
  res.json({
    clientSecret: 'mock_secret_' + Date.now(),
    amount: req.body.amount
  });
});

// POST /api/payments/confirm - Confirm payment
app.post('/api/payments/confirm', authMiddleware, async (req, res) => {
  const { amount } = req.body;
  try {
    // Add funds to wallet
    await pool.query(
      'INSERT INTO wallets (user_id, balance, currency) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $2',
      [req.userId, amount, 'USD']
    );
    
    // Record transaction
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, description) VALUES ($1, $2, $3, $4, $5)',
      [req.userId, 'deposit', amount, 'completed', 'Funds added']
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Payment failed' });
  }
});

// GET /api/config - For Stripe key
app.get('/api/config', (req, res) => {
  res.json({ stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

// ============================================
// HELPFUL TEST ROUTE
// ============================================

// Visit this URL to add test funds: /api/test-add-funds/email@example.com
app.get('/api/test-add-funds/:email', async (req, res) => {
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [req.params.email]);
    if (!userResult.rows[0]) {
      return res.send('User not found');
    }
    
    const userId = userResult.rows[0].id;
    const amount = 10000; // $100.00
    
    await pool.query(
      'INSERT INTO wallets (user_id, balance, currency) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET balance = $2',
      [userId, amount, 'USD']
    );
    
    res.send(`
      <h1>✅ Added $100 test funds to ${req.params.email}</h1>
      <a href="/">Go to app</a>
    `);
  } catch (error) {
    res.send('Error: ' + error.message);
  }
});

// ============================================
// START SERVER
// ============================================

async function start() {
  try {
    await initDatabase();
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`💡 Add test funds: /api/test-add-funds/kevin@knoxwebhq.com`);
    });
  } catch (error) {
    console.error('Failed to start:', error);
  }
}

start();
