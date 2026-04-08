// Add this to your server to sync Stripe Connected Account balances
// This should be added to your main app.js or create a new file stripe-sync.js

const syncStripeBalances = async () => {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const { pool } = require('./database');
  
  console.log('🔄 Starting Stripe balance sync...');
  
  try {
    // Get all users with Stripe customer IDs or account IDs
    const usersQuery = await pool.query(
      `SELECT id, email, stripe_customer_id, stripe_account_id 
       FROM users 
       WHERE stripe_customer_id IS NOT NULL 
          OR stripe_account_id IS NOT NULL`
    );
    
    for (const user of usersQuery.rows) {
      try {
        let balanceAmount = 0;
        
        // If user has a Stripe Connect account
        if (user.stripe_account_id) {
          console.log(`Checking Stripe Connect account for ${user.email}`);
          
          // Get balance from connected account
          const balance = await stripe.balance.retrieve({
            stripeAccount: user.stripe_account_id
          });
          
          // Sum available balance across all currencies (convert to cents)
          balanceAmount = balance.available.reduce((sum, bal) => {
            if (bal.currency === 'usd') {
              return sum + bal.amount;
            }
            return sum;
          }, 0);
          
          console.log(`  Connect balance: $${(balanceAmount / 100).toFixed(2)}`);
        }
        
        // If user has a customer ID, check for any credits or balance
        if (user.stripe_customer_id) {
          const customer = await stripe.customers.retrieve(user.stripe_customer_id);
          
          // Check customer balance (credits)
          if (customer.balance) {
            balanceAmount += Math.abs(customer.balance); // Customer balance is negative for credits
            console.log(`  Customer credit: $${(Math.abs(customer.balance) / 100).toFixed(2)}`);
          }
        }
        
        // Update wallet balance in database
        if (balanceAmount > 0) {
          const walletResult = await pool.query(
            `INSERT INTO wallets (user_id, balance, currency) 
             VALUES ($1, $2, 'USD') 
             ON CONFLICT (user_id) 
             DO UPDATE SET 
               balance = $2,
               updated_at = NOW()
             RETURNING *`,
            [user.id, balanceAmount]
          );
          
          console.log(`✅ Updated wallet for ${user.email}: $${(balanceAmount / 100).toFixed(2)}`);
          
          // Log transaction for audit
          await pool.query(
            `INSERT INTO transactions (user_id, type, amount, status, description, metadata) 
             VALUES ($1, 'sync', $2, 'completed', 'Stripe balance sync', $3)`,
            [user.id, balanceAmount, JSON.stringify({ 
              stripe_account_id: user.stripe_account_id,
              stripe_customer_id: user.stripe_customer_id,
              synced_at: new Date().toISOString()
            })]
          );
        } else {
          console.log(`  No balance found for ${user.email}`);
        }
        
      } catch (userError) {
        console.error(`Error syncing ${user.email}:`, userError.message);
      }
    }
    
    console.log('✅ Stripe balance sync completed');
    
  } catch (error) {
    console.error('❌ Stripe sync error:', error);
  }
};

// API endpoint to manually trigger sync
const syncRoute = async (req, res) => {
  try {
    await syncStripeBalances();
    res.json({ success: true, message: 'Stripe balances synced' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// API endpoint to check/fix a specific user's balance
const checkUserBalance = async (req, res) => {
  const { email } = req.params;
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const { pool } = require('./database');
  
  try {
    // Get user from database
    const userQuery = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    
    if (userQuery.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userQuery.rows[0];
    let stripeBalance = 0;
    let stripeDetails = {};
    
    // Check Stripe Connect account
    if (user.stripe_account_id) {
      try {
        const balance = await stripe.balance.retrieve({
          stripeAccount: user.stripe_account_id
        });
        
        stripeBalance = balance.available.reduce((sum, bal) => {
          if (bal.currency === 'usd') {
            return sum + bal.amount;
          }
          return sum;
        }, 0);
        
        stripeDetails.connectAccount = {
          id: user.stripe_account_id,
          available: balance.available,
          pending: balance.pending
        };
      } catch (e) {
        stripeDetails.connectError = e.message;
      }
    }
    
    // Check Stripe Customer
    if (user.stripe_customer_id) {
      try {
        const customer = await stripe.customers.retrieve(user.stripe_customer_id);
        
        if (customer.balance) {
          stripeBalance += Math.abs(customer.balance);
        }
        
        stripeDetails.customer = {
          id: customer.id,
          balance: customer.balance,
          email: customer.email
        };
      } catch (e) {
        stripeDetails.customerError = e.message;
      }
    }
    
    // Get current wallet balance
    const walletQuery = await pool.query(
      'SELECT * FROM wallets WHERE user_id = $1',
      [user.id]
    );
    
    const currentBalance = walletQuery.rows[0]?.balance || 0;
    
    // Update if different
    if (stripeBalance !== currentBalance) {
      await pool.query(
        `INSERT INTO wallets (user_id, balance, currency) 
         VALUES ($1, $2, 'USD') 
         ON CONFLICT (user_id) 
         DO UPDATE SET balance = $2, updated_at = NOW()`,
        [user.id, stripeBalance]
      );
    }
    
    res.json({
      user: {
        id: user.id,
        email: user.email,
        stripe_account_id: user.stripe_account_id,
        stripe_customer_id: user.stripe_customer_id
      },
      balance: {
        database: currentBalance,
        stripe: stripeBalance,
        synced: stripeBalance === currentBalance,
        displayAmount: `$${(stripeBalance / 100).toFixed(2)}`
      },
      stripeDetails
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Add these routes to your Express app:
/*
app.post('/api/admin/sync-stripe', syncRoute);
app.get('/api/admin/check-balance/:email', checkUserBalance);

// Optional: Run sync on server startup
syncStripeBalances().catch(console.error);

// Optional: Run sync every hour
setInterval(() => {
  syncStripeBalances().catch(console.error);
}, 60 * 60 * 1000);
*/

module.exports = {
  syncStripeBalances,
  syncRoute,
  checkUserBalance
};
