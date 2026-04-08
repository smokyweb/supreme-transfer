// ADD THESE ROUTES TO YOUR APP.JS or SERVER.JS
// This file shows exactly what needs to be added to make all endpoints work

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { pool } = require('./database');

// JWT Secret - use environment variable
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

// ============================================
// MIDDLEWARE
// ============================================

// Auth middleware - verifies JWT token
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ============================================
// AUTH ROUTES
// ============================================

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  
  try {
    // Check if user exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user
    const userResult = await pool.query(
      'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email, hashedPassword, name]
    );
    
    const user = userResult.rows[0];
    
    // Create wallet for user
    await pool.query(
      'INSERT INTO wallets (user_id, balance, currency) VALUES ($1, 0, $2)',
      [user.id, 'USD']
    );
    
    // Generate token
    const token = jwt.sign({ userId: user.id }, JWT_SECRET);
    
    res.json({ token, user });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  
  try {
    // Get user
    const userResult = await pool.query(
      'SELECT id, email, password, name, stripe_customer_id, stripe_account_id FROM users WHERE email = $1',
      [email]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = userResult.rows[0];
    
    // Verify password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Generate token
    const token = jwt.sign({ userId: user.id }, JWT_SECRET);
    
    // Don't send password back
    delete user.password;
    
    res.json({ token, user });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me - CRITICAL: This endpoint is required!
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT id, email, name, stripe_customer_id, stripe_account_id FROM users WHERE id = $1',
      [req.userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ user: userResult.rows[0] });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// ============================================
// WALLET ROUTES
// ============================================

// GET /api/wallet/balance - CRITICAL: This endpoint is required!
app.get('/api/wallet/balance', authMiddleware, async (req, res) => {
  try {
    // Get or create wallet
    let walletResult = await pool.query(
      'SELECT * FROM wallets WHERE user_id = $1',
      [req.userId]
    );
    
    if (walletResult.rows.length === 0) {
      // Create wallet with 0 balance
      walletResult = await pool.query(
        'INSERT INTO wallets (user_id, balance, currency) VALUES ($1, 0, $2) RETURNING *',
        [req.userId, 'USD']
      );
    }
    
    const wallet = walletResult.rows[0];
    
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

// ============================================
// TRANSACTION ROUTES
// ============================================

// GET /api/transactions - CRITICAL: This endpoint is required!
app.get('/api/transactions', authMiddleware, async (req, res) => {
  try {
    const transactionsResult = await pool.query(
      `SELECT * FROM transactions 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 50`,
      [req.userId]
    );
    
    res.json({
      transactions: transactionsResult.rows,
      count: transactionsResult.rows.length
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ error: 'Failed to get transactions' });
  }
});

// ============================================
// TRANSFER ROUTES
// ============================================

// POST /api/transfers/send
app.post('/api/transfers/send', authMiddleware, async (req, res) => {
  const { recipient_email, amount, note } = req.body;
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Get recipient
    const recipientResult = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [recipient_email]
    );
    
    if (recipientResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Recipient not found' });
    }
    
    const recipientId = recipientResult.rows[0].id;
    
    // Check sender balance
    const senderWalletResult = await client.query(
      'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
      [req.userId]
    );
    
    if (senderWalletResult.rows.length === 0 || senderWalletResult.rows[0].balance < amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Deduct from sender
    await client.query(
      'UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2',
      [amount, req.userId]
    );
    
    // Add to recipient
    await client.query(
      `INSERT INTO wallets (user_id, balance, currency) 
       VALUES ($1, $2, 'USD') 
       ON CONFLICT (user_id) 
       DO UPDATE SET balance = wallets.balance + $2, updated_at = NOW()`,
      [recipientId, amount]
    );
    
    // Record transactions
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, status, description, metadata) 
       VALUES ($1, 'send', $2, 'completed', $3, $4)`,
      [req.userId, amount, note || 'Transfer sent', JSON.stringify({ recipient_email })]
    );
    
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, status, description, metadata) 
       VALUES ($1, 'receive', $2, 'completed', $3, $4)`,
      [recipientId, amount, note || 'Transfer received', JSON.stringify({ sender_id: req.userId })]
    );
    
    await client.query('COMMIT');
    
    res.json({ success: true, message: 'Transfer completed' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Transfer error:', error);
    res.status(500).json({ error: 'Transfer failed' });
  } finally {
    client.release();
  }
});

// ============================================
// PAYMENT ROUTES (Stripe)
// ============================================

// POST /api/payments/create-intent
app.post('/api/payments/create-intent', authMiddleware, async (req, res) => {
  const { amount } = req.body;
  
  try {
    // For now, return a mock response
    // In production, integrate with Stripe here
    res.json({
      clientSecret: 'mock_secret_' + Date.now(),
      amount: amount
    });
  } catch (error) {
    console.error('Payment intent error:', error);
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
});

// POST /api/payments/confirm
app.post('/api/payments/confirm', authMiddleware, async (req, res) => {
  const { payment_intent_id, amount } = req.body;
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Add funds to wallet
    await client.query(
      `INSERT INTO wallets (user_id, balance, currency) 
       VALUES ($1, $2, 'USD') 
       ON CONFLICT (user_id) 
       DO UPDATE SET balance = wallets.balance + $2, updated_at = NOW()`,
      [req.userId, amount]
    );
    
    // Record transaction
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, status, description, metadata) 
       VALUES ($1, 'deposit', $2, 'completed', 'Funds added', $3)`,
      [req.userId, amount, JSON.stringify({ payment_intent_id })]
    );
    
    await client.query('COMMIT');
    
    res.json({ success: true, message: 'Payment confirmed' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Payment confirm error:', error);
    res.status(500).json({ error: 'Payment confirmation failed' });
  } finally {
    client.release();
  }
});

// ============================================
// CONFIG ROUTE
// ============================================

// GET /api/config - Returns Stripe publishable key
app.get('/api/config', (req, res) => {
  res.json({
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || ''
  });
});

// ============================================
// ADMIN/DEBUG ROUTES (Optional but helpful)
// ============================================

// POST /api/admin/add-test-funds - Add test funds to any user
app.post('/api/admin/add-test-funds', async (req, res) => {
  const { email, amount } = req.body;
  
  try {
    // Get user
    const userResult = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userId = userResult.rows[0].id;
    
    // Add funds
    const walletResult = await pool.query(
      `INSERT INTO wallets (user_id, balance, currency) 
       VALUES ($1, $2, 'USD') 
       ON CONFLICT (user_id) 
       DO UPDATE SET balance = wallets.balance + $2, updated_at = NOW()
       RETURNING *`,
      [userId, amount]
    );
    
    // Record transaction
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, status, description) 
       VALUES ($1, 'deposit', $2, 'completed', 'Test funds added')`,
      [userId, amount]
    );
    
    res.json({
      success: true,
      wallet: walletResult.rows[0],
      formatted: `$${(walletResult.rows[0].balance / 100).toFixed(2)}`
    });
  } catch (error) {
    console.error('Add test funds error:', error);
    res.status(500).json({ error: 'Failed to add funds' });
  }
});

console.log('✅ All API routes loaded');
console.log('Available endpoints:');
console.log('  POST /api/auth/register');
console.log('  POST /api/auth/login');
console.log('  GET  /api/auth/me (requires auth)');
console.log('  GET  /api/wallet/balance (requires auth)');
console.log('  GET  /api/transactions (requires auth)');
console.log('  POST /api/transfers/send (requires auth)');
console.log('  POST /api/payments/create-intent (requires auth)');
console.log('  POST /api/payments/confirm (requires auth)');
console.log('  GET  /api/config');
console.log('  POST /api/admin/add-test-funds');
