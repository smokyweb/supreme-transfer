# Supreme Transfer - P2P Payment App

A modern cash app built with Stripe Connect that enables peer-to-peer payments, similar to Cash App or Venmo.

## Features

✅ **User Authentication** - Sign up and login functionality
✅ **Stripe Connect Integration** - Each user gets a Stripe Connect Express account
✅ **Send Money** - Transfer funds to other users via email/username
✅ **Request Money** - Request payments from other users
✅ **Add Funds** - Top up your balance via debit/credit card
✅ **Transaction History** - View all your past transactions
✅ **Real-time Balance** - See your current balance
✅ **Progressive Web App (PWA)** - Install on mobile devices
✅ **Responsive Design** - Works on desktop and mobile

## Technology Stack

### Frontend
- **React 18** - UI framework
- **Tailwind CSS** - Styling
- **Lucide Icons** - Icon library
- **PWA** - Progressive Web App capabilities

### Backend
- **Node.js + Express** - API server
- **Stripe Connect** - Payment processing
- **Stripe API** - Transfers, payouts, and payment intents

## Architecture Overview

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   Frontend  │────────▶│   Backend   │────────▶│   Stripe    │
│   (React)   │         │  (Express)  │         │   Connect   │
└─────────────┘         └─────────────┘         └─────────────┘
      │                        │                        │
      │                        │                        │
      ▼                        ▼                        ▼
  PWA/Browser          User Database           Payment Processing
```

## Setup Instructions

### Prerequisites
- Node.js 16+ installed
- Stripe account (free test account works)
- Basic understanding of JavaScript

### 1. Clone/Download the Project

```bash
# Navigate to the project directory
cd supreme-transfer-app
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Stripe

1. **Create a Stripe Account** at https://stripe.com
2. **Get your API keys** from https://dashboard.stripe.com/test/apikeys
3. **Create a `.env` file** in the root directory:

```bash
cp .env.example .env
```

4. **Update `.env` with your keys:**

```env
STRIPE_SECRET_KEY=sk_test_YOUR_SECRET_KEY
STRIPE_PUBLISHABLE_KEY=pk_test_YOUR_PUBLISHABLE_KEY
STRIPE_WEBHOOK_SECRET=whsec_YOUR_WEBHOOK_SECRET
```

### 4. Start the Backend Server

```bash
# Start the API server
npm start

# Or for development with auto-reload
npm run dev
```

The server will start on http://localhost:3000

### 5. Start the Frontend

Open a new terminal:

```bash
# Install a simple HTTP server if you don't have one
npm install -g http-server

# Serve the frontend files
http-server -p 8000
```

The app will be available at http://localhost:8000

### 6. Test the Application

1. Open http://localhost:8000 in your browser
2. Sign up for a new account
3. Complete Stripe Connect onboarding
4. Add funds to your account
5. Send money to another user (create a second account to test)

## Stripe Connect Flow

### 1. Account Creation
```javascript
// When user signs up, create a Stripe Connect Express account
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

### 2. Onboarding
```javascript
// Generate an account link for user to complete onboarding
const accountLink = await stripe.accountLinks.create({
  account: account.id,
  refresh_url: 'http://localhost:3000/reauth',
  return_url: 'http://localhost:3000/dashboard',
  type: 'account_onboarding',
});
```

### 3. P2P Transfers
```javascript
// Transfer money between connected accounts
const transfer = await stripe.transfers.create({
  amount: amount * 100,
  currency: 'usd',
  destination: recipientStripeAccountId,
});
```

### 4. Add Funds
```javascript
// Charge customer and transfer to their connected account
const paymentIntent = await stripe.paymentIntents.create({
  amount: amount * 100,
  currency: 'usd',
  payment_method: paymentMethodId,
  transfer_data: {
    destination: userStripeAccountId,
  },
});
```

## API Endpoints

### Authentication
- `POST /api/auth/signup` - Create new user account
- `POST /api/auth/login` - Login user

### Balance & Transactions
- `GET /api/balance/:userId` - Get user balance
- `GET /api/transactions/:userId` - Get transaction history

### Transfers
- `POST /api/transfer/send` - Send money to another user

### Funds Management
- `POST /api/funds/add` - Add funds via card
- `POST /api/funds/create-intent` - Create payment intent
- `POST /api/payout/withdraw` - Withdraw to bank

### Payment Methods
- `POST /api/payment-methods/add` - Add payment method
- `GET /api/payment-methods/:userId` - List payment methods

### Account
- `GET /api/account/status/:userId` - Check account verification status

### Webhooks
- `POST /api/webhooks/stripe` - Stripe webhook handler

## Important Considerations

### 🚨 Security (For Production)

1. **Never store passwords in plain text** - Use bcrypt or similar
2. **Implement proper authentication** - Use JWT tokens or sessions
3. **Validate all inputs** - Prevent SQL injection, XSS attacks
4. **Use HTTPS only** - Never transmit sensitive data over HTTP
5. **Implement rate limiting** - Prevent abuse
6. **Add CSRF protection** - Protect against cross-site requests

### 💰 Compliance & Regulations

1. **Money Transmitter License** - Required in most US states
2. **KYC/AML Requirements** - Know Your Customer and Anti-Money Laundering
3. **PCI Compliance** - Required for handling card data
4. **Privacy Laws** - GDPR, CCPA compliance
5. **Terms of Service** - Clear user agreements

### 💵 Stripe Fees (as of 2024)

- **Card payments**: 2.9% + $0.30 per transaction
- **Connect transfers**: No additional fee
- **Payouts**: $0.25 per payout (varies by country)
- **Express accounts**: Free

### 🔧 Production Improvements

1. **Use a real database** (PostgreSQL, MongoDB)
2. **Implement proper error handling**
3. **Add logging and monitoring** (Sentry, LogRocket)
4. **Set up CI/CD pipeline**
5. **Add comprehensive testing** (Jest, Cypress)
6. **Implement email notifications**
7. **Add SMS verification** (Twilio)
8. **Create admin dashboard**
9. **Implement fraud detection**
10. **Add customer support chat**

## Testing

### Test Credit Cards

Use these test cards in development:

- **Success**: 4242 4242 4242 4242
- **Decline**: 4000 0000 0000 0002
- **Requires authentication**: 4000 0025 0000 3155

Any future expiration date and any 3-digit CVC work.

### Webhook Testing

Use Stripe CLI to test webhooks locally:

```bash
# Install Stripe CLI
brew install stripe/stripe-cli/stripe

# Listen for webhooks
stripe listen --forward-to localhost:3000/api/webhooks/stripe

# Trigger test events
stripe trigger payment_intent.succeeded
```

## Deployment

### Backend (Heroku, Railway, or Render)

```bash
# Set environment variables
heroku config:set STRIPE_SECRET_KEY=sk_live_...
heroku config:set STRIPE_WEBHOOK_SECRET=whsec_...

# Deploy
git push heroku main
```

### Frontend (Vercel, Netlify, or Cloudflare Pages)

```bash
# Build and deploy
npm run build
vercel deploy
```

## Common Issues & Solutions

### Issue: Transfers failing
- **Solution**: Ensure both accounts have completed Stripe onboarding
- Check that transfers capability is enabled

### Issue: Webhook not receiving events
- **Solution**: Update webhook endpoint URL in Stripe Dashboard
- Verify webhook secret is correct

### Issue: Payment declined
- **Solution**: Use test card numbers from Stripe docs
- Check account has sufficient test balance

## Resources

- [Stripe Connect Documentation](https://stripe.com/docs/connect)
- [Stripe API Reference](https://stripe.com/docs/api)
- [Connect Express Accounts](https://stripe.com/docs/connect/express-accounts)
- [Testing Stripe](https://stripe.com/docs/testing)

## License

MIT License - feel free to use this for learning or commercial projects.

## Support

For issues or questions:
1. Check Stripe documentation
2. Review API error messages
3. Test with Stripe's test mode first
4. Check webhook logs in Stripe Dashboard

## Next Steps

1. ✅ Set up Stripe account
2. ✅ Install dependencies
3. ✅ Configure environment variables
4. ✅ Start backend server
5. ✅ Start frontend server
6. ✅ Test basic functionality
7. 🔄 Add database integration
8. 🔄 Implement proper authentication
9. 🔄 Add email notifications
10. 🔄 Deploy to production

---

Built with ❤️ using Stripe Connect
