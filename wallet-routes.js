// wallet-routes.js - Add these wallet endpoints to your Express app

const express = require('express');
const router = express.Router();

// Middleware to verify JWT token
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// GET /api/wallet/balance - Get user's balance
router.get('/balance', authMiddleware, async (req, res) => {
  const { pool } = require('./database');
  
  try {
    // Get or create wallet for user
    const walletQuery = await pool.query(
      `SELECT * FROM wallets WHERE user_id = $1`,
      [req.userId]
    );
    
    let wallet = walletQuery.rows[0];
    
    // If no wallet exists, create one with 0 balance
    if (!wallet) {
      const createWallet = await pool.query(
        `INSERT INTO wallets (user_id, balance, currency) 
         VALUES ($1, 0, 'USD') 
         RETURNING *`,
        [req.userId]
      );
      wallet = createWallet.rows[0];
    }
    
    res.json({
      balance: wallet.balance || 0,
      currency: wallet.currency || 'USD',
      formatted: `$${((wallet.balance || 0) / 100).toFixed(2)}`
    });
    
  } catch (error) {
    console.error('Get balance error:', error);
    res.status(500).json({ error: 'Failed to get balance' });
  }
});

// POST /api/wallet/deposit - Add funds (for testing)
router.post('/deposit', authMiddleware, async (req, res) => {
  const { pool } = require('./database');
  const { amount } = req.body;
  
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Update wallet balance
    const walletResult = await client.query(
      `INSERT INTO wallets (user_id, balance, currency) 
       VALUES ($1, $2, 'USD') 
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         balance = wallets.balance + $2,
         updated_at = NOW()
       RETURNING *`,
      [req.userId, amount]
    );
    
    // Record transaction
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, status, description) 
       VALUES ($1, 'deposit', $2, 'completed', 'Funds added')`,
      [req.userId, amount]
    );
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      balance: walletResult.rows[0].balance,
      formatted: `$${(walletResult.rows[0].balance / 100).toFixed(2)}`
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'Failed to process deposit' });
  } finally {
    client.release();
  }
});

// GET /api/transactions - Get user's transaction history
router.get('/', authMiddleware, async (req, res) => {
  const { pool } = require('./database');
  const { limit = 50, offset = 0 } = req.query;
  
  try {
    const transactionsQuery = await pool.query(
      `SELECT * FROM transactions 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      [req.userId, limit, offset]
    );
    
    res.json({
      transactions: transactionsQuery.rows,
      count: transactionsQuery.rows.length
    });
    
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ error: 'Failed to get transactions' });
  }
});

module.exports = router;

/* 
ADD TO YOUR MAIN APP.JS:

const walletRoutes = require('./wallet-routes');
app.use('/api/wallet', walletRoutes);
app.use('/api/transactions', walletRoutes);

ALSO MAKE SURE YOU HAVE THE auth/me ENDPOINT:

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const userQuery = await pool.query(
      'SELECT id, email, name, stripe_customer_id, stripe_account_id FROM users WHERE id = $1',
      [req.userId]
    );
    
    if (userQuery.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ user: userQuery.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

*/
