// EMERGENCY FIX - Add to app.js if JWT is not working
// This is a simplified version without JWT dependency

// Simple auth check (NOT SECURE - just for testing)
const getUserId = (req) => {
  // For testing, just return user ID 1 or extract from a simple token
  const token = req.headers.authorization?.replace('Bearer ', '');
  // Assuming your login returns something like "user-1" as token
  return token ? token.split('-')[1] || 1 : null;
};

// Add these routes to make the app work:

app.get('/api/auth/me', async (req, res) => {
  // For testing, just return the first user
  const result = await pool.query('SELECT * FROM users LIMIT 1');
  if (result.rows[0]) {
    res.json({ user: result.rows[0] });
  } else {
    res.status(404).json({ error: 'No user found' });
  }
});

app.get('/api/wallet/balance', async (req, res) => {
  // Get first user's wallet for testing
  const userResult = await pool.query('SELECT id FROM users LIMIT 1');
  if (!userResult.rows[0]) {
    return res.json({ balance: 0 });
  }
  
  const userId = userResult.rows[0].id;
  let walletResult = await pool.query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
  
  if (!walletResult.rows[0]) {
    // Create wallet
    walletResult = await pool.query(
      'INSERT INTO wallets (user_id, balance, currency) VALUES ($1, 0, $2) RETURNING *',
      [userId, 'USD']
    );
  }
  
  res.json({ 
    balance: walletResult.rows[0].balance || 0,
    formatted: `$${((walletResult.rows[0].balance || 0) / 100).toFixed(2)}`
  });
});

app.get('/api/transactions', async (req, res) => {
  // Get first user's transactions
  const userResult = await pool.query('SELECT id FROM users LIMIT 1');
  if (!userResult.rows[0]) {
    return res.json({ transactions: [] });
  }
  
  const result = await pool.query(
    'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC',
    [userResult.rows[0].id]
  );
  res.json({ transactions: result.rows });
});

// Stub endpoints to prevent 404 errors
app.post('/api/transfers/send', (req, res) => res.json({ success: true }));
app.post('/api/payments/create-intent', (req, res) => res.json({ clientSecret: 'test_secret' }));
app.post('/api/payments/confirm', (req, res) => res.json({ success: true }));
app.get('/api/config', (req, res) => res.json({ stripePublishableKey: '' }));

// SUPER SIMPLE: Add money to test
app.get('/add-money', async (req, res) => {
  const userResult = await pool.query('SELECT id FROM users LIMIT 1');
  if (userResult.rows[0]) {
    await pool.query(
      'INSERT INTO wallets (user_id, balance, currency) VALUES ($1, 10000, $2) ' +
      'ON CONFLICT (user_id) DO UPDATE SET balance = 10000',
      [userResult.rows[0].id, 'USD']
    );
    res.send('<h1>Added $100!</h1><p>Go back and refresh the app</p>');
  } else {
    res.send('No users found - register first');
  }
});

console.log('Emergency routes added - visit /add-money to add test funds');
