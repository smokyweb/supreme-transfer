// API Debug Script - Add this to your server (app.js or server.js)
// This will help us see what's happening with balances and Stripe

const debugRouter = require('express').Router();

// Debug endpoint to check user balance and Stripe data
debugRouter.get('/debug/user/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
    // Get user from database
    const userQuery = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    
    if (userQuery.rows.length === 0) {
      return res.json({ error: 'User not found' });
    }
    
    const user = userQuery.rows[0];
    
    // Get wallet balance
    const walletQuery = await pool.query(
      'SELECT * FROM wallets WHERE user_id = $1',
      [user.id]
    );
    
    // Get recent transactions
    const transactionsQuery = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
      [user.id]
    );
    
    // Get Stripe account info if stripe_customer_id exists
    let stripeInfo = null;
    if (user.stripe_customer_id) {
      try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const customer = await stripe.customers.retrieve(user.stripe_customer_id);
        
        // Get balance from Stripe
        const balance = await stripe.balance.retrieve();
        
        // Get recent charges
        const charges = await stripe.charges.list({
          customer: user.stripe_customer_id,
          limit: 5
        });
        
        stripeInfo = {
          customer,
          balance,
          charges: charges.data
        };
      } catch (stripeError) {
        stripeInfo = { error: stripeError.message };
      }
    }
    
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        stripe_customer_id: user.stripe_customer_id,
        stripe_account_id: user.stripe_account_id,
        created_at: user.created_at
      },
      wallet: walletQuery.rows[0] || { balance: 0 },
      recentTransactions: transactionsQuery.rows,
      stripeInfo,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Debug endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check database tables
debugRouter.get('/debug/tables', async (req, res) => {
  try {
    // List all tables
    const tablesQuery = await pool.query(`
      SELECT tablename 
      FROM pg_catalog.pg_tables 
      WHERE schemaname = 'public'
    `);
    
    const tableInfo = {};
    
    // Get row count for each table
    for (const row of tablesQuery.rows) {
      const countQuery = await pool.query(`SELECT COUNT(*) FROM ${row.tablename}`);
      tableInfo[row.tablename] = {
        rowCount: parseInt(countQuery.rows[0].count)
      };
      
      // Get sample data for important tables
      if (['users', 'wallets', 'transactions'].includes(row.tablename)) {
        const sampleQuery = await pool.query(`SELECT * FROM ${row.tablename} LIMIT 3`);
        tableInfo[row.tablename].sample = sampleQuery.rows;
      }
    }
    
    res.json({
      tables: tablesQuery.rows.map(r => r.tablename),
      tableInfo,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fix wallet balance manually
debugRouter.post('/debug/fix-balance', async (req, res) => {
  try {
    const { email, amount } = req.body;
    
    // Get user
    const userQuery = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    
    if (userQuery.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userId = userQuery.rows[0].id;
    
    // Update or insert wallet balance
    const walletQuery = await pool.query(
      `INSERT INTO wallets (user_id, balance, currency) 
       VALUES ($1, $2, 'USD') 
       ON CONFLICT (user_id) 
       DO UPDATE SET balance = $2, updated_at = NOW()
       RETURNING *`,
      [userId, amount]
    );
    
    // Log the transaction
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, status, description) 
       VALUES ($1, 'deposit', $2, 'completed', 'Manual balance adjustment')`,
      [userId, amount]
    );
    
    res.json({
      success: true,
      wallet: walletQuery.rows[0]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add this to your main app.js or server.js:
// app.use('/api', debugRouter);

module.exports = debugRouter;
