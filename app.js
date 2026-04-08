const { useState, useEffect } = React;

// Stripe configuration - Get key from meta tag set by server
const getStripeKey = () => {
    const metaTag = document.querySelector('meta[name="stripe-key"]');
    if (metaTag) {
        return metaTag.getAttribute('content');
    }
    // Fallback for development
    return window.location.hostname === 'localhost'
        ? 'pk_live_51Nx9phC0nWrQWJerNgf0bfKE5TbLxraQQwocwsOpzry5bIyRqx6ygkoEB6fFknBaOR5jnVIZvem5kTsBg2fCrTgp00EPdNWxqJ'
        : null;
};

const STRIPE_PUBLISHABLE_KEY = getStripeKey();

// Initialize Stripe
const stripe = window.Stripe && STRIPE_PUBLISHABLE_KEY ? window.Stripe(STRIPE_PUBLISHABLE_KEY) : null;

// API configuration - automatically uses correct URL
const API_BASE = window.location.hostname === 'localhost' 
    ? 'http://localhost:3000/api'
    : window.location.origin + '/api';

const api = {
    // User authentication
    async login(email, password) {
        try {
            const response = await fetch(`${API_BASE}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            return await response.json();
        } catch (error) {
            console.error('Login error:', error);
            return { success: false, error: error.message };
        }
    },
    
    async signup(name, email, password) {
        try {
            const response = await fetch(`${API_BASE}/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, email, password })
            });
            const data = await response.json();
            if (data.requiresVerification) {
                return data; // { requiresVerification: true, email }
            }
            if (data.onboardingUrl) {
                // Redirect to Stripe onboarding
                window.location.href = data.onboardingUrl;
            }
            return data;
        } catch (error) {
            console.error('Signup error:', error);
            return { success: false, error: error.message };
        }
    },
    
    // Get user balance
    async getBalance(userId) {
        try {
            const response = await fetch(`${API_BASE}/balance/${userId}`);
            return await response.json();
        } catch (error) {
            console.error('Balance error:', error);
            return { balance: 0, currency: 'usd' };
        }
    },
    
    // Get transactions
    async getTransactions(userId) {
        try {
            const response = await fetch(`${API_BASE}/transactions/${userId}`);
            const data = await response.json();
            return data.transactions || [];
        } catch (error) {
            console.error('Transactions error:', error);
            return [];
        }
    },
    
    // Send money
    async sendMoney(fromUserId, toEmail, amount, note) {
        try {
            const response = await fetch(`${API_BASE}/transfer/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fromUserId, toEmail, amount, note })
            });
            return await response.json();
        } catch (error) {
            console.error('Send money error:', error);
            return { success: false, error: error.message };
        }
    },
    
    // Request money
    async requestMoney(from, amount, note) {
        // This endpoint needs to be implemented in backend
        return { success: true, requestId: 'req_' + Date.now() };
    },
    
    // Add payment method
    async addPaymentMethod(userId, paymentMethodId) {
        try {
            const response = await fetch(`${API_BASE}/payment-methods/add`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, paymentMethodId })
            });
            return await response.json();
        } catch (error) {
            console.error('Add payment method error:', error);
            return { success: false, error: error.message };
        }
    }
};

// Main App Component
function App() {
    const [currentView, setCurrentView] = useState('login');
    const [user, setUser] = useState(null);
    const [balance, setBalance] = useState(0);
    const [pendingBalance, setPendingBalance] = useState(0);
    const [transactions, setTransactions] = useState([]);
    const [pendingEmail, setPendingEmail] = useState('');

    useEffect(() => {
        if (user) {
            loadBalance();
            loadTransactions();
        }
    }, [user]);

    const loadBalance = async () => {
        if (user && user.id) {
            const data = await api.getBalance(user.id);
            setBalance(data.balance || 0);
            setPendingBalance(data.pendingBalance || 0);
        }
    };

    const loadTransactions = async () => {
        if (user && user.id) {
            const data = await api.getTransactions(user.id);
            setTransactions(data);
        }
    };

    const handleLogin = async (email, password) => {
        const result = await api.login(email, password);
        if (result.success && result.user) {
            setUser(result.user);
            setBalance(result.user.balance || 0);
            setCurrentView('dashboard');
        } else {
            alert(result.error || 'Login failed');
        }
    };

    const handleLogout = () => {
        setUser(null);
        setCurrentView('login');
    };

    // Route to different views
    const renderView = () => {
        switch (currentView) {
            case 'login':
                return <LoginView onLogin={handleLogin} onSignup={() => setCurrentView('signup')} />;
            case 'signup':
                return <SignupView onBack={() => setCurrentView('login')} onVerificationRequired={(email) => { setPendingEmail(email); setCurrentView('verify-email'); }} />;
            case 'verify-email':
                return <EmailVerificationView email={pendingEmail} onBack={() => setCurrentView('signup')} onVerified={(data) => { if (data.token) { localStorage.setItem('auth_token', data.token); setUser(data.user); setCurrentView('dashboard'); } }} />;
            case 'dashboard':
                return <Dashboard 
                    user={user} 
                    balance={balance}
                    pendingBalance={pendingBalance}
                    transactions={transactions}
                    onNavigate={setCurrentView}
                    onLogout={handleLogout}
                />;
            case 'send':
                return <SendMoney 
                    user={user}
                    onBack={() => setCurrentView('dashboard')}
                    onComplete={() => {
                        loadBalance();
                        loadTransactions();
                        setCurrentView('dashboard');
                    }}
                />;
            case 'request':
                return <RequestMoney 
                    onBack={() => setCurrentView('dashboard')}
                    onComplete={() => setCurrentView('dashboard')}
                />;
            case 'add-funds':
                return <AddFunds 
                    user={user}
                    onBack={() => setCurrentView('dashboard')}
                    onComplete={() => {
                        loadBalance();
                        setCurrentView('dashboard');
                    }}
                />;
            case 'cash-out':
                return <CashOut 
                    user={user}
                    balance={balance}
                    onBack={() => setCurrentView('dashboard')}
                    onComplete={() => {
                        loadBalance();
                        loadTransactions();
                        setCurrentView('dashboard');
                    }}
                />;
            default:
                return <Dashboard user={user} balance={balance} transactions={transactions} onNavigate={setCurrentView} />;
        }
    };

    return (
        <div className="min-h-screen bg-gray-50">
            {renderView()}
        </div>
    );
}

// Login View
function LoginView({ onLogin, onSignup }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        onLogin(email, password);
    };

    return (
        <div className="min-h-screen gradient-bg flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
                <div className="text-center mb-8">
                    <div className="inline-block p-4 bg-indigo-100 rounded-full mb-4">
                        <i data-lucide="wallet" className="w-12 h-12 text-indigo-600"></i>
                    </div>
                    <h1 className="text-3xl font-bold text-gray-900">Supreme Transfer</h1>
                    <p className="text-gray-600 mt-2">Send money instantly to anyone</p>
                </div>

                <form onSubmit={handleSubmit}>
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                                placeholder="you@example.com"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Password</label>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                                placeholder="••••••••"
                                required
                            />
                        </div>
                    </div>

                    <button
                        type="submit"
                        className="w-full mt-6 bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 transition"
                    >
                        Sign In
                    </button>
                </form>

                <div className="mt-6 text-center">
                    <button
                        onClick={onSignup}
                        className="text-indigo-600 hover:text-indigo-700 font-medium"
                    >
                        Don't have an account? Sign up
                    </button>
                </div>
            </div>
        </div>
    );
}

// Signup View
// Password strength checker
function getPasswordStrength(password) {
    const checks = {
        length: password.length >= 8,
        uppercase: /[A-Z]/.test(password),
        lowercase: /[a-z]/.test(password),
        number: /\d/.test(password),
        special: /[^a-zA-Z0-9]/.test(password)
    };
    const score = Object.values(checks).filter(Boolean).length;
    return { checks, score, isStrong: score === 5 };
}

function PasswordStrengthIndicator({ password }) {
    const { checks, score } = getPasswordStrength(password);
    if (!password) return null;
    const colors = ['bg-red-500', 'bg-red-400', 'bg-yellow-400', 'bg-yellow-500', 'bg-green-500'];
    const labels = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong'];
    return (
        <div className="mt-2">
            <div className="flex gap-1 mb-1">
                {[1,2,3,4,5].map(i => (
                    <div key={i} className={`h-1.5 flex-1 rounded-full transition-all ${i <= score ? colors[score-1] : 'bg-gray-200'}`}></div>
                ))}
            </div>
            <p className={`text-xs ${score <= 2 ? 'text-red-600' : score <= 3 ? 'text-yellow-600' : 'text-green-600'}`}>
                {labels[score-1] || 'Enter a password'}
            </p>
            <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5">
                {[
                    { key: 'length', label: '8+ characters' },
                    { key: 'uppercase', label: 'Uppercase letter' },
                    { key: 'lowercase', label: 'Lowercase letter' },
                    { key: 'number', label: 'Number' },
                    { key: 'special', label: 'Special character' }
                ].map(({key, label}) => (
                    <div key={key} className={`text-xs flex items-center gap-1 ${checks[key] ? 'text-green-600' : 'text-gray-400'}`}>
                        <span>{checks[key] ? '✓' : '○'}</span>{label}
                    </div>
                ))}
            </div>
        </div>
    );
}

function SignupView({ onBack, onVerificationRequired }) {
    const [formData, setFormData] = useState({
        name: '',
        email: '',
        password: '',
        confirmPassword: ''
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const { isStrong } = getPasswordStrength(formData.password);

    const handleSubmit = async (e) => {
        e.preventDefault();
        
        if (formData.password !== formData.confirmPassword) {
            setError('Passwords do not match');
            return;
        }

        if (!isStrong) {
            setError('Please choose a stronger password that meets all requirements.');
            return;
        }
        
        setLoading(true);
        setError('');
        
        try {
            const result = await api.signup(formData.name, formData.email, formData.password);
            
            if (result.requiresVerification) {
                onVerificationRequired(result.email);
            } else if (result.onboardingUrl) {
                window.location.href = result.onboardingUrl;
            } else if (result.success) {
                alert('Account created! Redirecting to complete setup...');
            } else {
                setError(result.error || 'Signup failed. Please try again.');
            }
        } catch (err) {
            setError('An error occurred. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen gradient-bg flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
                <button onClick={onBack} className="mb-4 text-gray-600 hover:text-gray-900">
                    <i data-lucide="arrow-left" className="w-5 h-5 inline"></i> Back
                </button>

                <div className="text-center mb-8">
                    <h1 className="text-3xl font-bold text-gray-900">Create Account</h1>
                    <p className="text-gray-600 mt-2">Join Supreme Transfer today</p>
                </div>

                <form onSubmit={handleSubmit}>
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Full Name</label>
                            <input
                                type="text"
                                value={formData.name}
                                onChange={(e) => setFormData({...formData, name: e.target.value})}
                                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Email</label>
                            <input
                                type="email"
                                value={formData.email}
                                onChange={(e) => setFormData({...formData, email: e.target.value})}
                                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Password</label>
                            <input
                                type="password"
                                value={formData.password}
                                onChange={(e) => setFormData({...formData, password: e.target.value})}
                                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                required
                            />
                            <PasswordStrengthIndicator password={formData.password} />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Confirm Password</label>
                            <input
                                type="password"
                                value={formData.confirmPassword}
                                onChange={(e) => setFormData({...formData, confirmPassword: e.target.value})}
                                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                required
                            />
                        </div>
                    </div>

                    {error && (
                        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
                            {error}
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={loading || !isStrong}
                        className="w-full mt-6 bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {loading ? 'Creating Account...' : 'Create Account'}
                    </button>
                </form>
            </div>
        </div>
    );
}

// Email Verification View
function EmailVerificationView({ email, onVerified, onBack }) {
    const [code, setCode] = useState('');
    const [loading, setLoading] = useState(false);
    const [resending, setResending] = useState(false);
    const [error, setError] = useState('');
    const [successMsg, setSuccessMsg] = useState('');

    const handleVerify = async (e) => {
        e.preventDefault();
        if (code.length !== 6) { setError('Enter the 6-digit code'); return; }
        setLoading(true);
        setError('');
        try {
            const response = await fetch(`${API_BASE}/auth/verify-email`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, code })
            });
            const data = await response.json();
            if (response.ok && data.token) {
                onVerified(data);
            } else {
                setError(data.error || 'Invalid code. Please try again.');
            }
        } catch (err) {
            setError('An error occurred. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    const handleResend = async () => {
        setResending(true);
        setError('');
        setSuccessMsg('');
        try {
            const response = await fetch(`${API_BASE}/auth/resend-verification`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            const data = await response.json();
            if (response.ok) {
                setSuccessMsg('A new code has been sent to your email.');
            } else {
                setError(data.error || 'Failed to resend. Please try again.');
            }
        } catch (err) {
            setError('An error occurred.');
        } finally {
            setResending(false);
        }
    };

    return (
        <div className="min-h-screen gradient-bg flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
                <button onClick={onBack} className="mb-4 text-gray-600 hover:text-gray-900">
                    <i data-lucide="arrow-left" className="w-5 h-5 inline"></i> Back
                </button>
                <div className="text-center mb-8">
                    <div className="text-5xl mb-4">📧</div>
                    <h1 className="text-2xl font-bold text-gray-900">Check your email</h1>
                    <p className="text-gray-600 mt-2">We sent a 6-digit code to</p>
                    <p className="font-semibold text-indigo-600">{email}</p>
                </div>

                <form onSubmit={handleVerify}>
                    <div className="mb-4">
                        <label className="block text-sm font-medium text-gray-700 mb-2">Verification Code</label>
                        <input
                            type="text"
                            inputMode="numeric"
                            maxLength={6}
                            value={code}
                            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                            className="w-full px-4 py-4 border-2 border-gray-300 rounded-lg text-center text-2xl font-bold tracking-widest focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                            placeholder="000000"
                            required
                        />
                    </div>

                    {error && (
                        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
                            {error}
                        </div>
                    )}
                    {successMsg && (
                        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-800 text-sm">
                            {successMsg}
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={loading || code.length !== 6}
                        className="w-full bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-700 transition disabled:opacity-50"
                    >
                        {loading ? 'Verifying...' : 'Verify Email'}
                    </button>
                </form>

                <div className="mt-4 text-center">
                    <button onClick={handleResend} disabled={resending}
                        className="text-sm text-indigo-600 hover:text-indigo-800 underline disabled:opacity-50">
                        {resending ? 'Sending...' : "Didn't get it? Resend code"}
                    </button>
                </div>
            </div>
        </div>
    );
}

// Dashboard View
function Dashboard({ user, balance, pendingBalance, transactions, onNavigate, onLogout }) {
    useEffect(() => {
        lucide.createIcons();
    }, []);

    return (
        <div className="min-h-screen bg-gray-50">
            {/* Header */}
            <header className="gradient-bg text-white p-6">
                <div className="max-w-4xl mx-auto">
                    <div className="flex justify-between items-center mb-6">
                        <h1 className="text-2xl font-bold">Supreme Transfer</h1>
                        <button onClick={onLogout} className="text-white hover:text-gray-200">
                            <i data-lucide="log-out" className="w-6 h-6"></i>
                        </button>
                    </div>
                    
                    {/* Balance Card */}
                    <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6">
                        <p className="text-white/80 text-sm mb-2">Your Balance</p>
                        <h2 className="text-4xl font-bold mb-3">${balance.toFixed(2)}</h2>
                        {pendingBalance > 0 && (
                            <div className="flex items-center gap-2 text-yellow-200">
                                <i data-lucide="clock" className="w-4 h-4"></i>
                                <span className="text-sm">Pending: ${pendingBalance.toFixed(2)}</span>
                            </div>
                        )}
                    </div>
                </div>
            </header>

            <div className="max-w-4xl mx-auto p-6">
                {/* Quick Actions */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
                    <button
                        onClick={() => onNavigate('send')}
                        className="bg-white card-shadow rounded-xl p-6 text-center hover:shadow-lg transition"
                    >
                        <div className="inline-block p-3 bg-indigo-100 rounded-full mb-3">
                            <i data-lucide="send" className="w-6 h-6 text-indigo-600"></i>
                        </div>
                        <p className="font-semibold text-gray-900">Send</p>
                    </button>

                    <button
                        onClick={() => onNavigate('request')}
                        className="bg-white card-shadow rounded-xl p-6 text-center hover:shadow-lg transition"
                    >
                        <div className="inline-block p-3 bg-green-100 rounded-full mb-3">
                            <i data-lucide="download" className="w-6 h-6 text-green-600"></i>
                        </div>
                        <p className="font-semibold text-gray-900">Request</p>
                    </button>

                    <button
                        onClick={() => onNavigate('add-funds')}
                        className="bg-white card-shadow rounded-xl p-6 text-center hover:shadow-lg transition"
                    >
                        <div className="inline-block p-3 bg-blue-100 rounded-full mb-3">
                            <i data-lucide="plus" className="w-6 h-6 text-blue-600"></i>
                        </div>
                        <p className="font-semibold text-gray-900">Add Funds</p>
                    </button>

                    <button
                        onClick={() => onNavigate('cash-out')}
                        className="bg-white card-shadow rounded-xl p-6 text-center hover:shadow-lg transition"
                    >
                        <div className="inline-block p-3 bg-purple-100 rounded-full mb-3">
                            <i data-lucide="banknote" className="w-6 h-6 text-purple-600"></i>
                        </div>
                        <p className="font-semibold text-gray-900">Cash Out</p>
                    </button>
                </div>

                {/* Transactions */}
                <div className="bg-white card-shadow rounded-2xl p-6">
                    <h3 className="text-xl font-bold text-gray-900 mb-4">Recent Activity</h3>
                    
                    <div className="space-y-3">
                        {transactions.map(transaction => (
                            <div key={transaction.id} className="transaction-item flex items-center justify-between p-4 rounded-lg border border-gray-100">
                                <div className="flex items-center space-x-4 flex-1">
                                    <div className={`p-3 rounded-full ${
                                        transaction.type === 'received' ? 'bg-green-100' : 
                                        transaction.type === 'sent' ? 'bg-red-100' : 'bg-blue-100'
                                    }`}>
                                        <i data-lucide={
                                            transaction.type === 'received' ? 'arrow-down' : 
                                            transaction.type === 'sent' ? 'arrow-up' : 'plus'
                                        } 
                                           className={`w-5 h-5 ${
                                               transaction.type === 'received' ? 'text-green-600' : 
                                               transaction.type === 'sent' ? 'text-red-600' : 'text-blue-600'
                                           }`}></i>
                                    </div>
                                    <div className="flex-1">
                                        <div className="flex items-center gap-2">
                                            <p className="font-semibold text-gray-900">
                                                {transaction.type === 'received' ? transaction.from : 
                                                 transaction.type === 'sent' ? transaction.to : 'Add Funds'}
                                            </p>
                                            {/* Status Badge */}
                                            {transaction.status && (
                                                <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                                                    transaction.status === 'completed' ? 'bg-green-100 text-green-700' :
                                                    transaction.status === 'pending' ? 'bg-yellow-100 text-yellow-700' :
                                                    transaction.status === 'failed' ? 'bg-red-100 text-red-700' :
                                                    'bg-gray-100 text-gray-700'
                                                }`}>
                                                    {transaction.status.charAt(0).toUpperCase() + transaction.status.slice(1)}
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-sm text-gray-500">
                                            {new Date(transaction.date).toLocaleDateString()}
                                        </p>
                                    </div>
                                </div>
                                <p className={`font-bold text-lg ${
                                    transaction.type === 'received' ? 'text-green-600' : 
                                    transaction.type === 'sent' ? 'text-red-600' : 'text-blue-600'
                                }`}>
                                    {transaction.type === 'received' ? '+' : transaction.type === 'sent' ? '-' : '+'}${transaction.amount.toFixed(2)}
                                </p>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}

// Send Money View
function SendMoney({ user, onBack, onComplete }) {
    const [recipient, setRecipient] = useState('');
    const [amount, setAmount] = useState('');
    const [note, setNote] = useState('');
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        lucide.createIcons();
    }, []);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        
        try {
            const result = await api.sendMoney(user.id, recipient, parseFloat(amount), note);
            if (result.success) {
                alert('Money sent successfully!');
                onComplete();
            } else {
                alert(result.error || 'Failed to send money. Please try again.');
            }
        } catch (error) {
            alert('Failed to send money. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-gray-50">
            <header className="gradient-bg text-white p-6">
                <div className="max-w-4xl mx-auto">
                    <button onClick={onBack} className="text-white mb-4">
                        <i data-lucide="arrow-left" className="w-6 h-6"></i>
                    </button>
                    <h1 className="text-2xl font-bold">Send Money</h1>
                </div>
            </header>

            <div className="max-w-4xl mx-auto p-6">
                <div className="bg-white card-shadow rounded-2xl p-8">
                    <form onSubmit={handleSubmit}>
                        <div className="space-y-6">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Recipient (Email or Username)
                                </label>
                                <input
                                    type="text"
                                    value={recipient}
                                    onChange={(e) => setRecipient(e.target.value)}
                                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                    placeholder="recipient@example.com"
                                    required
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Amount</label>
                                <div className="relative">
                                    <span className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-500 text-xl">$</span>
                                    <input
                                        type="number"
                                        step="0.01"
                                        value={amount}
                                        onChange={(e) => setAmount(e.target.value)}
                                        className="w-full pl-8 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 text-xl"
                                        placeholder="0.00"
                                        required
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Note (Optional)
                                </label>
                                <textarea
                                    value={note}
                                    onChange={(e) => setNote(e.target.value)}
                                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                    rows="3"
                                    placeholder="What's this for?"
                                />
                            </div>
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full mt-8 bg-indigo-600 text-white py-4 rounded-lg font-semibold text-lg hover:bg-indigo-700 transition disabled:opacity-50"
                        >
                            {loading ? 'Sending...' : 'Send Money'}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}

// Request Money View
function RequestMoney({ onBack, onComplete }) {
    const [from, setFrom] = useState('');
    const [amount, setAmount] = useState('');
    const [note, setNote] = useState('');

    useEffect(() => {
        lucide.createIcons();
    }, []);

    const handleSubmit = async (e) => {
        e.preventDefault();
        await api.requestMoney(from, parseFloat(amount), note);
        alert('Money request sent!');
        onComplete();
    };

    return (
        <div className="min-h-screen bg-gray-50">
            <header className="gradient-bg text-white p-6">
                <div className="max-w-4xl mx-auto">
                    <button onClick={onBack} className="text-white mb-4">
                        <i data-lucide="arrow-left" className="w-6 h-6"></i>
                    </button>
                    <h1 className="text-2xl font-bold">Request Money</h1>
                </div>
            </header>

            <div className="max-w-4xl mx-auto p-6">
                <div className="bg-white card-shadow rounded-2xl p-8">
                    <form onSubmit={handleSubmit}>
                        <div className="space-y-6">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Request From (Email or Username)
                                </label>
                                <input
                                    type="text"
                                    value={from}
                                    onChange={(e) => setFrom(e.target.value)}
                                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                    required
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Amount</label>
                                <div className="relative">
                                    <span className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-500 text-xl">$</span>
                                    <input
                                        type="number"
                                        step="0.01"
                                        value={amount}
                                        onChange={(e) => setAmount(e.target.value)}
                                        className="w-full pl-8 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 text-xl"
                                        required
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Reason</label>
                                <textarea
                                    value={note}
                                    onChange={(e) => setNote(e.target.value)}
                                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                                    rows="3"
                                    required
                                />
                            </div>
                        </div>

                        <button
                            type="submit"
                            className="w-full mt-8 bg-green-600 text-white py-4 rounded-lg font-semibold text-lg hover:bg-green-700 transition"
                        >
                            Send Request
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}

// Add Funds View
function AddFunds({ user, onBack, onComplete }) {
    const [amount, setAmount] = useState('');
    const [clientSecret, setClientSecret] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [paymentElement, setPaymentElement] = useState(null);
    const [elements, setElements] = useState(null);

    useEffect(() => {
        lucide.createIcons();
    }, []);

    // Create payment intent when amount is entered
    const createPaymentIntent = async (amt) => {
        if (!amt || amt <= 0) return;
        
        try {
            setLoading(true);
            setError('');
            
            const response = await fetch(`${API_BASE}/funds/create-intent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    userId: user.id, 
                    amount: parseFloat(amt) 
                })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                // Handle specific errors
                if (data.needsOnboarding) {
                    setError('Please complete your Stripe onboarding first. Check your email for a link, or contact support.');
                } else {
                    setError(data.error || 'Failed to initialize payment');
                }
                return;
            }
            
            if (data.clientSecret) {
                setClientSecret(data.clientSecret);
                
                // Initialize Stripe Elements with bank account support
                if (stripe && !elements) {
                    const newElements = stripe.elements({ 
                        clientSecret: data.clientSecret,
                        appearance: {
                            theme: 'stripe',
                            variables: {
                                colorPrimary: '#6366f1',
                            }
                        }
                    });
                    
                    // Create Payment Element with all payment methods enabled
                    const paymentEl = newElements.create('payment', {
                        layout: 'tabs',
                        paymentMethodOrder: ['card', 'us_bank_account']
                    });
                    paymentEl.mount('#payment-element');
                    
                    setElements(newElements);
                    setPaymentElement(paymentEl);
                }
            } else {
                setError('Failed to initialize payment');
            }
        } catch (err) {
            console.error('Payment intent error:', err);
            setError('Failed to create payment intent. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    const handleAmountChange = (e) => {
        const newAmount = e.target.value;
        setAmount(newAmount);
        
        // Clear existing payment element
        if (paymentElement) {
            paymentElement.unmount();
            setPaymentElement(null);
            setElements(null);
        }
    };

    const handleAmountBlur = () => {
        if (amount && parseFloat(amount) > 0) {
            createPaymentIntent(amount);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        
        if (!stripe || !elements) {
            setError('Stripe not loaded');
            return;
        }
        
        setLoading(true);
        setError('');
        
        try {
            const { error: submitError, paymentIntent } = await stripe.confirmPayment({
                elements,
                confirmParams: {
                    return_url: `${window.location.origin}/?payment=success`,
                },
                redirect: 'if_required'
            });
            
            if (submitError) {
                setError(submitError.message);
            } else if (paymentIntent) {
                // Record the transaction on the backend
                await fetch(`${API_BASE}/transactions/record`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: user.id,
                        type: 'add_funds',
                        amount: parseFloat(amount),
                        status: paymentIntent.status === 'succeeded' ? 'completed' : 'pending',
                        paymentIntentId: paymentIntent.id,
                        paymentMethod: paymentIntent.payment_method_types?.[0] || 'card'
                    })
                });
                
                alert(`Funds ${paymentIntent.status === 'succeeded' ? 'added' : 'pending'}!`);
                onComplete();
            }
        } catch (err) {
            setError('Payment failed. Please try again.');
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-gray-50">
            <header className="gradient-bg text-white p-6">
                <div className="max-w-4xl mx-auto">
                    <button onClick={onBack} className="text-white mb-4">
                        <i data-lucide="arrow-left" className="w-6 h-6"></i>
                    </button>
                    <h1 className="text-2xl font-bold">Add Funds</h1>
                </div>
            </header>

            <div className="max-w-4xl mx-auto p-6">
                <div className="bg-white card-shadow rounded-2xl p-8">
                    <form onSubmit={handleSubmit}>
                        <div className="space-y-6">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Amount to Add
                                </label>
                                <div className="relative">
                                    <span className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-500 text-xl">$</span>
                                    <input
                                        type="number"
                                        step="0.01"
                                        min="1"
                                        value={amount}
                                        onChange={handleAmountChange}
                                        onBlur={handleAmountBlur}
                                        className="w-full pl-8 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 text-xl"
                                        placeholder="0.00"
                                        required
                                    />
                                </div>
                                <p className="text-sm text-gray-500 mt-2">
                                    Enter amount and we'll load payment options
                                </p>
                            </div>

                            {/* Stripe Payment Element */}
                            {clientSecret && (
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        Payment Information
                                    </label>
                                    <div 
                                        id="payment-element" 
                                        className="border border-gray-300 rounded-lg p-4"
                                    >
                                        {/* Stripe Payment Element mounts here */}
                                    </div>
                                </div>
                            )}

                            {error && (
                                <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
                                    {error}
                                </div>
                            )}

                            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                                <p className="text-sm text-blue-800">
                                    <i data-lucide="info" className="w-4 h-4 inline mr-2"></i>
                                    {window.location.hostname === 'localhost' ? (
                                        'Test Mode: Use card 4242 4242 4242 4242'
                                    ) : (
                                        'Live Mode: Real payment information required'
                                    )}
                                </p>
                            </div>
                        </div>

                        <button
                            type="submit"
                            disabled={loading || !clientSecret}
                            className="w-full mt-8 bg-blue-600 text-white py-4 rounded-lg font-semibold text-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {loading ? 'Processing...' : `Add $${amount || '0.00'}`}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}

// Cash Out to Bank
function CashOut({ user, balance, onBack, onComplete }) {
    const [amount, setAmount] = useState('');
    const [method, setMethod] = useState('standard');
    const [loading, setLoading] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    const INSTANT_FEE_PERCENT = 1.5;
    const INSTANT_FEE_MIN = 0.50;

    useEffect(() => {
        lucide.createIcons();
    }, []);

    const calculateFee = () => {
        if (method !== 'instant' || !amount) return 0;
        const amountValue = parseFloat(amount);
        const fee = Math.max(INSTANT_FEE_MIN, amountValue * (INSTANT_FEE_PERCENT / 100));
        return fee;
    };

    const totalDeduction = () => {
        if (!amount) return 0;
        return parseFloat(amount) + calculateFee();
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setShowConfirm(true);
    };

    const handleConfirm = async () => {
        setShowConfirm(false);
        setLoading(true);
        setError('');
        setSuccess('');

        try {
            const token = localStorage.getItem('token');
            if (!token) {
                setError('Please log in to cash out');
                return;
            }

            const response = await fetch(`${API_BASE}/wallet/cash-out`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    amount: Math.round(parseFloat(amount) * 100),
                    instant: method === 'instant'
                })
            });

            const data = await response.json();

            if (response.ok) {
                setSuccess(data.message || `Successfully sent $${amount} to your bank account!`);
                setTimeout(() => {
                    onComplete();
                }, 2000);
            } else {
                setError(data.error || 'Cash out failed');
            }
        } catch (err) {
            setError('Error processing cash out');
        } finally {
            setLoading(false);
        }
    };

    const fee = calculateFee();
    const total = totalDeduction();

    return (
        <div className="min-h-screen bg-gray-50 pb-20">
            {/* Header */}
            <div className="gradient-bg text-white p-6">
                <div className="max-w-4xl mx-auto">
                    <div className="flex items-center mb-6">
                        <button onClick={onBack} className="mr-4">
                            <i data-lucide="arrow-left" className="w-6 h-6"></i>
                        </button>
                        <h1 className="text-2xl font-bold">Cash Out to Bank</h1>
                    </div>
                    
                    {/* Balance Display */}
                    <div className="bg-white/10 backdrop-blur-lg rounded-xl p-4">
                        <p className="text-white/80 text-sm mb-1">Available Balance</p>
                        <h2 className="text-3xl font-bold">${balance.toFixed(2)}</h2>
                    </div>
                </div>
            </div>

            <div className="max-w-4xl mx-auto p-6">
                <div className="bg-white card-shadow rounded-2xl p-6 mb-6">
                    {error && (
                        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
                            {error}
                        </div>
                    )}

                    {success && (
                        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg text-green-800">
                            {success}
                        </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-6">
                        {/* Amount Input */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                Amount ($)
                            </label>
                            <div className="relative">
                                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 text-xl">$</span>
                                <input
                                    type="number"
                                    step="0.01"
                                    min="0.01"
                                    max={balance}
                                    value={amount}
                                    onChange={(e) => setAmount(e.target.value)}
                                    className="w-full pl-8 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 text-xl"
                                    placeholder="0.00"
                                    required
                                />
                            </div>
                            <button
                                type="button"
                                onClick={() => setAmount(balance.toFixed(2))}
                                className="mt-2 text-sm text-purple-600 hover:text-purple-800"
                            >
                                Cash out all (${balance.toFixed(2)})
                            </button>
                        </div>

                        {/* Delivery Method */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-3">
                                Delivery Speed
                            </label>
                            <div className="space-y-3">
                                {/* Standard Option */}
                                <label className={`flex items-start p-4 border-2 rounded-lg cursor-pointer transition ${
                                    method === 'standard' 
                                        ? 'border-purple-500 bg-purple-50' 
                                        : 'border-gray-200 hover:border-gray-300'
                                }`}>
                                    <input
                                        type="radio"
                                        name="method"
                                        value="standard"
                                        checked={method === 'standard'}
                                        onChange={(e) => setMethod(e.target.value)}
                                        className="mt-1"
                                    />
                                    <div className="ml-3 flex-1">
                                        <div className="flex items-center justify-between">
                                            <span className="font-semibold text-gray-900">Standard</span>
                                            <span className="text-green-600 font-bold">FREE</span>
                                        </div>
                                        <p className="text-sm text-gray-600 mt-1">
                                            Standard ACH transfer
                                        </p>
                                    </div>
                                </label>

                                {/* Instant Option */}
                                <label className={`flex items-start p-4 border-2 rounded-lg cursor-pointer transition ${
                                    method === 'instant' 
                                        ? 'border-purple-500 bg-purple-50' 
                                        : 'border-gray-200 hover:border-gray-300'
                                }`}>
                                    <input
                                        type="radio"
                                        name="method"
                                        value="instant"
                                        checked={method === 'instant'}
                                        onChange={(e) => setMethod(e.target.value)}
                                        className="mt-1"
                                    />
                                    <div className="ml-3 flex-1">
                                        <div className="flex items-center justify-between">
                                            <span className="font-semibold text-gray-900">Instant</span>
                                            <span className="text-purple-600 font-bold">{INSTANT_FEE_PERCENT}% fee</span>
                                        </div>
                                        <p className="text-sm text-gray-600 mt-1">
                                            Arrives in approximately 30 minutes
                                        </p>
                                        {amount && method === 'instant' && (
                                            <p className="text-sm text-gray-500 mt-2">
                                                Fee: ${fee.toFixed(2)} (min ${INSTANT_FEE_MIN.toFixed(2)})
                                            </p>
                                        )}
                                    </div>
                                </label>
                            </div>
                        </div>

                        {/* Summary */}
                        {amount && (
                            <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                                <div className="flex justify-between text-sm">
                                    <span className="text-gray-600">Amount</span>
                                    <span className="font-medium">${parseFloat(amount).toFixed(2)}</span>
                                </div>
                                {method === 'instant' && (
                                    <div className="flex justify-between text-sm">
                                        <span className="text-gray-600">Instant fee</span>
                                        <span className="font-medium">${fee.toFixed(2)}</span>
                                    </div>
                                )}
                                <div className="flex justify-between text-base font-bold pt-2 border-t border-gray-200">
                                    <span className="text-gray-900">Total deducted</span>
                                    <span className="text-gray-900">${total.toFixed(2)}</span>
                                </div>
                                <div className="flex justify-between text-sm">
                                    <span className="text-gray-600">You'll receive</span>
                                    <span className="font-semibold text-green-600">${parseFloat(amount).toFixed(2)}</span>
                                </div>
                            </div>
                        )}

                        {total > balance && amount && (
                            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm">
                                Insufficient balance. Available: ${balance.toFixed(2)}
                            </div>
                        )}

                        <button
                            type="submit"
                            disabled={!amount || parseFloat(amount) <= 0 || total > balance || loading}
                            className="w-full bg-purple-600 text-white py-4 rounded-lg font-semibold text-lg hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {loading ? 'Processing...' : `Cash Out ${amount ? `$${parseFloat(amount).toFixed(2)}` : ''}`}
                        </button>
                    </form>
                </div>

                {/* Info Box */}
                <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                    <h3 className="font-semibold text-purple-900 mb-2 flex items-center">
                        <i data-lucide="info" className="w-5 h-5 mr-2"></i>
                        How it works
                    </h3>
                    <ul className="text-sm text-purple-800 space-y-1">
                        <li>• <strong>Standard (Free):</strong> Standard ACH transfer</li>
                        <li>• <strong>Instant ({INSTANT_FEE_PERCENT}% fee):</strong> Get your money in ~30 minutes</li>
                        <li>• Funds are sent directly to your connected bank account</li>
                        <li>• Minimum instant fee: ${INSTANT_FEE_MIN.toFixed(2)}</li>
                    </ul>
                </div>
            </div>

            {/* Confirmation Modal */}
            {showConfirm && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-lg p-6 max-w-md w-full">
                        <h3 className="text-xl font-bold text-gray-900 mb-4">Confirm Cash Out</h3>
                        
                        <div className="space-y-3 mb-6">
                            <div className="flex justify-between">
                                <span className="text-gray-600">Amount</span>
                                <span className="font-semibold">${parseFloat(amount).toFixed(2)}</span>
                            </div>
                            {method === 'instant' && (
                                <div className="flex justify-between">
                                    <span className="text-gray-600">Instant fee</span>
                                    <span className="font-semibold">${fee.toFixed(2)}</span>
                                </div>
                            )}
                            <div className="flex justify-between text-lg font-bold pt-2 border-t">
                                <span>Total</span>
                                <span>${total.toFixed(2)}</span>
                            </div>
                            <div className="bg-gray-50 p-3 rounded">
                                <p className="text-sm text-gray-700">
                                    Delivery: <strong>{method === 'instant' ? '~30 minutes' : 'Standard ACH'}</strong>
                                </p>
                            </div>
                        </div>

                        <div className="flex gap-3">
                            <button
                                onClick={handleConfirm}
                                className="flex-1 px-4 py-3 bg-purple-600 text-white font-semibold rounded-lg hover:bg-purple-700"
                            >
                                Confirm
                            </button>
                            <button
                                onClick={() => setShowConfirm(false)}
                                className="flex-1 px-4 py-3 border border-gray-300 text-gray-700 font-semibold rounded-lg hover:bg-gray-50"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// Render the app
ReactDOM.render(<App />, document.getElementById('root'));

// Initialize Lucide icons
document.addEventListener('DOMContentLoaded', () => {
    lucide.createIcons();
});
