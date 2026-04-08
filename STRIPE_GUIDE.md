# Stripe Connect Implementation Guide

This guide provides detailed information about implementing Stripe Connect for your cash app.

## Table of Contents
1. [Understanding Stripe Connect](#understanding-stripe-connect)
2. [Account Types](#account-types)
3. [Implementation Steps](#implementation-steps)
4. [Key Features](#key-features)
5. [Best Practices](#best-practices)
6. [Security Considerations](#security-considerations)

## Understanding Stripe Connect

Stripe Connect allows you to create a platform where multiple users can send and receive payments. Each user gets their own Stripe account (called a "connected account") that is linked to your platform account.

### Key Concepts

- **Platform Account**: Your main Stripe account
- **Connected Accounts**: Individual Stripe accounts for each user
- **Transfers**: Moving money between accounts
- **Payouts**: Sending money to bank accounts
- **Application Fees**: Optional fees you can charge

## Account Types

### Express Accounts (Recommended for Cash Apps)
```javascript
const account = await stripe.accounts.create({
  type: 'express',
  country: 'US',
  email: userEmail,
  capabilities: {
    card_payments: { requested: true },
    transfers: { requested: true },
  }
});
```

**Pros:**
- Stripe handles onboarding UI
- Simplified compliance
- Faster setup
- Stripe handles KYC/AML

**Cons:**
- Less customization
- Users see Stripe branding
- Limited control over user experience

### Custom Accounts (Advanced)
```javascript
const account = await stripe.accounts.create({
  type: 'custom',
  country: 'US',
  email: userEmail,
  capabilities: {
    card_payments: { requested: true },
    transfers: { requested: true },
  },
  business_type: 'individual'
});
```

**Pros:**
- Full UI customization
- Complete control
- Your branding throughout

**Cons:**
- You handle compliance
- More development work
- More liability

## Implementation Steps

### Step 1: Create Connected Accounts

When a user signs up:

```javascript
// 1. Create Stripe Connect account
const account = await stripe.accounts.create({
  type: 'express',
  country: 'US',
  email: user.email,
  capabilities: {
    card_payments: { requested: true },
    transfers: { requested: true },
  },
  business_profile: {
    product_description: 'P2P payment app',
  },
  individual: {
    email: user.email,
    first_name: user.firstName,
    last_name: user.lastName,
  }
});

// 2. Save account ID to your database
user.stripeAccountId = account.id;
await user.save();

// 3. Create onboarding link
const accountLink = await stripe.accountLinks.create({
  account: account.id,
  refresh_url: `${YOUR_DOMAIN}/reauth`,
  return_url: `${YOUR_DOMAIN}/dashboard`,
  type: 'account_onboarding',
});

// 4. Redirect user to onboarding
res.redirect(accountLink.url);
```

### Step 2: Check Account Status

Before allowing transactions:

```javascript
const account = await stripe.accounts.retrieve(stripeAccountId);

if (!account.charges_enabled || !account.payouts_enabled) {
  // Account needs to complete onboarding
  return { error: 'Please complete account setup' };
}

if (account.requirements.currently_due.length > 0) {
  // Additional information needed
  return { 
    error: 'Additional verification required',
    requirements: account.requirements.currently_due 
  };
}
```

### Step 3: Implement Transfers

#### P2P Transfer
```javascript
async function transferMoney(fromUserId, toUserId, amount) {
  // 1. Validate users and balances
  const fromUser = await getUser(fromUserId);
  const toUser = await getUser(toUserId);
  
  if (fromUser.balance < amount) {
    throw new Error('Insufficient balance');
  }

  // 2. Create Stripe transfer
  const transfer = await stripe.transfers.create({
    amount: Math.round(amount * 100), // Convert to cents
    currency: 'usd',
    destination: toUser.stripeAccountId,
    source_transaction: fromUser.lastChargeId, // Optional: link to source
    transfer_group: `order_${Date.now()}`, // Optional: group related transfers
    metadata: {
      from_user_id: fromUserId,
      to_user_id: toUserId,
    }
  });

  // 3. Update balances in your database
  await updateBalance(fromUserId, -amount);
  await updateBalance(toUserId, amount);

  // 4. Record transaction
  await createTransaction({
    transferId: transfer.id,
    fromUserId,
    toUserId,
    amount,
    status: 'completed'
  });

  return transfer;
}
```

### Step 4: Add Funds (Charge + Transfer)

```javascript
async function addFunds(userId, amount, paymentMethodId) {
  const user = await getUser(userId);

  // Create PaymentIntent with automatic transfer
  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100),
    currency: 'usd',
    payment_method: paymentMethodId,
    confirm: true,
    automatic_payment_methods: {
      enabled: true,
      allow_redirects: 'never',
    },
    transfer_data: {
      destination: user.stripeAccountId,
      // Optional: take application fee
      // amount: Math.round(amount * 100 * 0.98), // 2% fee
    },
    metadata: {
      user_id: userId,
      action: 'add_funds'
    }
  });

  if (paymentIntent.status === 'succeeded') {
    // Update user balance
    await updateBalance(userId, amount);
    return paymentIntent;
  }

  throw new Error('Payment failed');
}
```

### Step 5: Payouts to Bank

```javascript
async function withdrawToBank(userId, amount) {
  const user = await getUser(userId);

  if (user.balance < amount) {
    throw new Error('Insufficient balance');
  }

  // Create payout on connected account
  const payout = await stripe.payouts.create(
    {
      amount: Math.round(amount * 100),
      currency: 'usd',
      method: 'standard', // or 'instant' for instant payouts (extra fee)
      metadata: {
        user_id: userId
      }
    },
    {
      stripeAccount: user.stripeAccountId
    }
  );

  // Update balance
  await updateBalance(userId, -amount);

  return payout;
}
```

### Step 6: Handle Webhooks

```javascript
app.post('/webhooks/stripe', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle different event types
  switch (event.type) {
    case 'account.updated':
      // Connected account was updated
      const account = event.data.object;
      await handleAccountUpdate(account);
      break;

    case 'transfer.created':
      // Transfer was created
      const transfer = event.data.object;
      await handleTransferCreated(transfer);
      break;

    case 'transfer.failed':
      // Transfer failed
      await handleTransferFailed(event.data.object);
      break;

    case 'payout.paid':
      // Payout was successful
      await handlePayoutPaid(event.data.object);
      break;

    case 'payout.failed':
      // Payout failed
      await handlePayoutFailed(event.data.object);
      break;

    case 'charge.succeeded':
      // Payment succeeded
      await handleChargeSucceeded(event.data.object);
      break;

    case 'charge.refunded':
      // Charge was refunded
      await handleChargeRefunded(event.data.object);
      break;

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({received: true});
});
```

## Key Features Implementation

### 1. User Balance Management

```javascript
class BalanceManager {
  // Get balance from Stripe
  async getStripeBalance(stripeAccountId) {
    const balance = await stripe.balance.retrieve({
      stripeAccount: stripeAccountId
    });
    
    return {
      available: balance.available[0]?.amount / 100 || 0,
      pending: balance.pending[0]?.amount / 100 || 0
    };
  }

  // Update internal balance
  async updateBalance(userId, amount) {
    await db.query(
      'UPDATE users SET balance = balance + $1 WHERE id = $2',
      [amount, userId]
    );
  }

  // Sync with Stripe
  async syncBalance(userId) {
    const user = await getUser(userId);
    const stripeBalance = await this.getStripeBalance(user.stripeAccountId);
    
    await db.query(
      'UPDATE users SET balance = $1, pending_balance = $2 WHERE id = $3',
      [stripeBalance.available, stripeBalance.pending, userId]
    );
  }
}
```

### 2. Transaction History

```javascript
async function getTransactionHistory(userId, options = {}) {
  const { limit = 50, startingAfter } = options;

  // Get from your database
  const transactions = await db.query(
    `SELECT * FROM transactions 
     WHERE from_user_id = $1 OR to_user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );

  // Optionally, also fetch from Stripe
  const stripeTransfers = await stripe.transfers.list({
    destination: user.stripeAccountId,
    limit,
    starting_after: startingAfter
  });

  return {
    transactions,
    stripeTransfers: stripeTransfers.data
  };
}
```

### 3. Payment Methods

```javascript
// Add card
async function addCard(userId, paymentMethodId) {
  const user = await getUser(userId);

  // Create customer if doesn't exist
  if (!user.stripeCustomerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { user_id: userId }
    });
    user.stripeCustomerId = customer.id;
    await user.save();
  }

  // Attach payment method
  await stripe.paymentMethods.attach(paymentMethodId, {
    customer: user.stripeCustomerId
  });

  // Set as default
  await stripe.customers.update(user.stripeCustomerId, {
    invoice_settings: {
      default_payment_method: paymentMethodId
    }
  });

  return paymentMethodId;
}

// Add bank account
async function addBankAccount(userId, bankAccountToken) {
  const user = await getUser(userId);

  // Add to connected account
  const bankAccount = await stripe.accounts.createExternalAccount(
    user.stripeAccountId,
    {
      external_account: bankAccountToken
    }
  );

  return bankAccount;
}
```

### 4. Refunds

```javascript
async function refundTransaction(transactionId) {
  const transaction = await getTransaction(transactionId);

  // Reverse the transfer
  const reversal = await stripe.transfers.createReversal(
    transaction.stripeTransferId,
    {
      amount: Math.round(transaction.amount * 100)
    }
  );

  // Update balances
  await updateBalance(transaction.fromUserId, transaction.amount);
  await updateBalance(transaction.toUserId, -transaction.amount);

  // Update transaction status
  await updateTransaction(transactionId, {
    status: 'refunded',
    reversalId: reversal.id
  });

  return reversal;
}
```

## Best Practices

### 1. Error Handling

```javascript
async function safeTransfer(fromUserId, toUserId, amount) {
  try {
    // Validate
    if (amount <= 0) {
      throw new Error('Invalid amount');
    }

    const fromUser = await getUser(fromUserId);
    const toUser = await getUser(toUserId);

    if (!fromUser || !toUser) {
      throw new Error('User not found');
    }

    if (fromUser.balance < amount) {
      throw new Error('Insufficient balance');
    }

    // Check account status
    const fromAccount = await stripe.accounts.retrieve(fromUser.stripeAccountId);
    const toAccount = await stripe.accounts.retrieve(toUser.stripeAccountId);

    if (!fromAccount.charges_enabled || !toAccount.charges_enabled) {
      throw new Error('Account not verified');
    }

    // Perform transfer
    return await transferMoney(fromUserId, toUserId, amount);

  } catch (error) {
    // Log error
    console.error('Transfer failed:', error);

    // Notify user
    await notifyUser(fromUserId, {
      type: 'transfer_failed',
      error: error.message
    });

    throw error;
  }
}
```

### 2. Idempotency

```javascript
async function idempotentTransfer(fromUserId, toUserId, amount, idempotencyKey) {
  // Check if already processed
  const existing = await db.query(
    'SELECT * FROM transactions WHERE idempotency_key = $1',
    [idempotencyKey]
  );

  if (existing.length > 0) {
    return existing[0]; // Already processed
  }

  // Process transfer
  const transfer = await stripe.transfers.create(
    {
      amount: Math.round(amount * 100),
      currency: 'usd',
      destination: toUser.stripeAccountId
    },
    {
      idempotencyKey // Stripe will handle duplicates
    }
  );

  // Save with idempotency key
  await db.query(
    'INSERT INTO transactions (idempotency_key, ...) VALUES ($1, ...)',
    [idempotencyKey, ...]
  );

  return transfer;
}
```

### 3. Rate Limiting

```javascript
const rateLimit = require('express-rate-limit');

const transferLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Max 5 transfers per 15 minutes
  message: 'Too many transfer attempts'
});

app.post('/api/transfer/send', transferLimiter, async (req, res) => {
  // Handle transfer
});
```

### 4. Logging

```javascript
async function logTransaction(transaction) {
  await db.query(
    `INSERT INTO transaction_logs 
     (transaction_id, user_id, action, amount, timestamp, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      transaction.id,
      transaction.userId,
      transaction.action,
      transaction.amount,
      new Date(),
      JSON.stringify(transaction.metadata)
    ]
  );
}
```

## Security Considerations

### 1. Never Expose Secret Keys

```javascript
// ❌ WRONG - Never do this
const stripe = require('stripe')('sk_live_actual_key_here');

// ✅ CORRECT - Use environment variables
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
```

### 2. Validate Webhook Signatures

```javascript
// Always verify webhook signatures
try {
  const event = stripe.webhooks.constructEvent(
    req.body,
    req.headers['stripe-signature'],
    process.env.STRIPE_WEBHOOK_SECRET
  );
} catch (err) {
  return res.status(400).send(`Webhook Error: ${err.message}`);
}
```

### 3. Sanitize User Input

```javascript
function sanitizeAmount(amount) {
  const parsed = parseFloat(amount);
  
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error('Invalid amount');
  }
  
  if (parsed > 10000) {
    throw new Error('Amount exceeds limit');
  }
  
  return Math.round(parsed * 100) / 100; // Round to 2 decimals
}
```

### 4. Implement Access Controls

```javascript
async function checkAccess(userId, resourceId) {
  const resource = await getResource(resourceId);
  
  if (resource.userId !== userId && !isAdmin(userId)) {
    throw new Error('Unauthorized access');
  }
  
  return true;
}
```

## Testing

### Test Mode

Always develop in test mode first:

```javascript
// Use test API keys
const stripe = require('stripe')('sk_test_...');

// Test card numbers
const TEST_CARDS = {
  success: '4242424242424242',
  decline: '4000000000000002',
  authenticate: '4000002500003155'
};
```

### Unit Tests

```javascript
const { expect } = require('chai');

describe('Transfer Service', () => {
  it('should transfer money between users', async () => {
    const result = await transferMoney(user1.id, user2.id, 50);
    expect(result.amount).to.equal(5000); // In cents
    expect(result.destination).to.equal(user2.stripeAccountId);
  });

  it('should reject transfer with insufficient balance', async () => {
    await expect(
      transferMoney(user1.id, user2.id, 10000)
    ).to.be.rejectedWith('Insufficient balance');
  });
});
```

## Common Issues & Solutions

### Issue: "Account not enabled"
**Solution**: User needs to complete Stripe onboarding

### Issue: "Insufficient balance"
**Solution**: User needs to add funds first

### Issue: "Invalid account"
**Solution**: Verify Stripe account ID is correct

### Issue: "Rate limit exceeded"
**Solution**: Implement exponential backoff

## Resources

- [Stripe Connect Docs](https://stripe.com/docs/connect)
- [Express Accounts](https://stripe.com/docs/connect/express-accounts)
- [Testing Guide](https://stripe.com/docs/testing)
- [Webhook Best Practices](https://stripe.com/docs/webhooks/best-practices)

---

Need help? Check the main README or Stripe documentation.
