const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../auth');
const authenticationConfig = require('../config/authentication');
const { requestBasePath, withBasePath } = require('../config/basePath');
const totpService = require('../services/totpService');
const twoFactorAuth = require('../services/twoFactorAuth');
const {
    passwordIdentityLimiter,
    passwordIpLimiter
} = require('../services/authRateLimiter');

function userMutationErrorStatus(error) {
    return error?.code === 'USERNAME_EXISTS' ? 409 : 500;
}

function loginIpKey(req) {
    return req.socket?.remoteAddress || 'unknown';
}

function loginIdentityKey(req) {
    const username = String(req.body?.username || '').trim().toLowerCase();
    return `${loginIpKey(req)}:${username}`;
}

function rejectRateLimited(res, states) {
    const blocked = states.filter(state => !state.allowed);
    if (blocked.length === 0) return false;
    const retryAfterMs = Math.max(...blocked.map(state => state.retryAfterMs));
    res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    res.status(429).json({ error: 'Too many authentication attempts. Try again later.' });
    return true;
}

// Configure Passport strategies
auth.configureLocalStrategy(
    async (username) => await db.users.getByUsername(username),
    async (password, hash) => await auth.verifyPassword(password, hash)
);

auth.configureJwtStrategy(
    async (id) => await db.users.getById(id)
);

// Configure Passport session serialization (required for OIDC)
auth.configureSessionSerialization(
    async (id) => await db.users.getById(id)
);

// Configure OIDC Strategy. Discovery can require a network request, so OIDC
// routes wait for this promise before asking Passport to authenticate.
const oidcReady = auth.configureOidcStrategy(
    async (oidcId) => await db.users.getByOidcId(oidcId),
    async (email) => await db.users.getByEmail(email),
    async (userData) => await db.users.create(userData)
);

oidcReady.then(enabled => {
    if (!authenticationConfig.localAuthEnabled && !enabled) {
        console.error('[Auth] Local sign-in is disabled, but single sign-on is unavailable. Check the OIDC configuration before ending the bootstrap administrator session.');
    }
}).catch(() => {
    if (!authenticationConfig.localAuthEnabled) {
        console.error('[Auth] Local sign-in is disabled, but single sign-on could not be initialized.');
    }
});

function authenticateOidc(options) {
    return async (req, res, next) => {
        try {
            const enabled = await oidcReady;
            if (!enabled) {
                return res.status(503).json({ error: 'Single sign-on is not available.' });
            }
            return auth.passport.authenticate('openidconnect', options)(req, res, next);
        } catch (error) {
            console.error('[OIDC] Authentication initialization failed:', error.message);
            return res.status(503).json({ error: 'Single sign-on is not available.' });
        }
    };
}

/**
 * Report the public sign-in methods. This deliberately exposes only booleans
 * so the login page never receives provider credentials or internal details.
 */
router.get('/oidc/status', async (req, res) => {
    try {
        res.json(authenticationConfig.publicLoginOptions(await oidcReady));
    } catch {
        res.json(authenticationConfig.publicLoginOptions(false));
    }
});

/**
 * Start OIDC Login
 * GET /api/auth/oidc/login
 */
router.get('/oidc/login', authenticateOidc());

/**
 * OIDC Callback
 * GET /api/auth/oidc/callback
 */
router.get('/oidc/callback',
    authenticateOidc({ session: false, failureRedirect: withBasePath('/login.html?error=SSO+Failed') }),
    async (req, res) => {
        try {
            if (twoFactorAuth.hasEnabledTotp(req.user)) {
                if (!totpService.isAvailable()) {
                    return res.status(503).send('Two-factor authentication is temporarily unavailable.');
                }
                auth.clearAuthCookie(req, res);
                await twoFactorAuth.beginChallenge(req, req.user);
                return res.redirect(withBasePath('/login.html', requestBasePath(req)));
            }

            // Successful authentication
            const token = auth.generateToken(req.user);
            auth.setAuthCookie(req, res, token);

            // The HttpOnly cookie authenticates the app without exposing the token in the URL.
            res.redirect(withBasePath('/', requestBasePath(req)));
        } catch {
            res.status(500).send('Authentication could not be completed.');
        }
    }
);

/**
 * Check if initial setup is required
 * GET /api/auth/setup-required
 */
router.get('/setup-required', async (req, res) => {
    try {
        const userCount = await db.users.count();
        res.json({ setupRequired: userCount === 0 });
    } catch (err) {
        console.error('Error in /setup-required:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Initial setup - Create admin user
 * POST /api/auth/setup
 */
router.post('/setup', async (req, res) => {
    try {
        const userCount = await db.users.count();

        // Check if setup already done
        if (userCount > 0) {
            return res.status(400).json({ error: 'Setup already completed' });
        }

        const { username, password, passwordConfirmation } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        if (!passwordConfirmation) {
            return res.status(400).json({ error: 'Password confirmation required' });
        }

        if (password !== passwordConfirmation) {
            return res.status(400).json({ error: 'Passwords do not match' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        // Create admin user
        const passwordHash = await auth.hashPassword(password);
        const adminUser = await db.users.create({
            username,
            passwordHash,
            role: 'admin'
        });

        // Generate token for immediate login
        const token = auth.generateToken(adminUser);
        auth.setAuthCookie(req, res, token);

        res.status(201).json({
            message: 'Admin user created successfully',
            user: adminUser
        });
    } catch (err) {
        console.error('Error in /setup:', err);
        res.status(userMutationErrorStatus(err)).json({ error: err.message || 'Server error' });
    }
});

/**
 * Login with Passport Local Strategy
 * POST /api/auth/login
 */
router.post('/login', (req, res, next) => {
    if (!authenticationConfig.localAuthEnabled) {
        return res.status(403).json({ error: 'Local sign-in is disabled. Use single sign-on.' });
    }

    const identityKey = loginIdentityKey(req);
    const ipKey = loginIpKey(req);
    if (rejectRateLimited(res, [
        passwordIdentityLimiter.check(identityKey),
        passwordIpLimiter.check(ipKey)
    ])) return;

    auth.passport.authenticate('local', { session: false }, async (err, user, info) => {
        try {
            if (err) {
                console.error('Login error:', err);
                return res.status(500).json({ error: 'Server error' });
            }

            if (!user) {
                passwordIdentityLimiter.recordFailure(identityKey);
                passwordIpLimiter.recordFailure(ipKey);
                return res.status(401).json({ error: info?.message || 'Invalid credentials' });
            }

            passwordIdentityLimiter.reset(identityKey);
            passwordIpLimiter.reset(ipKey);

            if (twoFactorAuth.hasEnabledTotp(user)) {
                if (!totpService.isAvailable()) {
                    return res.status(503).json({ error: 'Two-factor authentication is temporarily unavailable.' });
                }
                auth.clearAuthCookie(req, res);
                await twoFactorAuth.beginChallenge(req, user);
                return res.json({ requiresTwoFactor: true });
            }

            // Generate JWT token
            const token = auth.generateToken(user);
            auth.setAuthCookie(req, res, token);

            res.json({ user: db.users.toPublic(user) });
        } catch {
            if (!res.headersSent) res.status(500).json({ error: 'Authentication could not be completed.' });
        }
    })(req, res, next);
});

/**
 * Logout (client-side handles token removal)
 * POST /api/auth/logout
 */
router.post('/logout', (req, res) => {
    auth.clearAuthCookie(req, res);
    if (req.session) delete req.session.twoFactorChallenge;
    res.json({ success: true, message: 'Logged out successfully' });
});

/**
 * Get current user
 * GET /api/auth/me
 */
router.get('/me', auth.requireAuth, async (req, res) => {
    try {
        const user = await db.users.getById(req.user.id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Seamlessly migrate existing installations from localStorage-only tokens.
        const bearerToken = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
        if (bearerToken) {
            auth.setAuthCookie(req, res, bearerToken);
        }

        res.json(db.users.toPublic(user));
    } catch (err) {
        console.error('Error in /me:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Get all users (admin only)
 * GET /api/auth/users
 */
router.get('/users', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const allUsers = await db.users.getAll();

        res.json(allUsers.map(db.users.toPublic));
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Create a new user (admin only)
 * POST /api/auth/users
 */
router.post('/users', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { username, password, passwordConfirmation, role } = req.body;

        if (!username || !password || !role) {
            return res.status(400).json({ error: 'Username, password, and role are required' });
        }

        if (!passwordConfirmation) {
            return res.status(400).json({ error: 'Password confirmation required' });
        }

        if (password !== passwordConfirmation) {
            return res.status(400).json({ error: 'Passwords do not match' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        if (!['admin', 'viewer'].includes(role)) {
            return res.status(400).json({ error: 'Role must be either "admin" or "viewer"' });
        }

        const passwordHash = await auth.hashPassword(password);
        const newUser = await db.users.create({
            username,
            passwordHash,
            role
        });

        res.status(201).json(newUser);
    } catch (err) {
        console.error('Error creating user:', err);
        res.status(userMutationErrorStatus(err)).json({ error: err.message || 'Server error' });
    }
});

/**
 * Update a user (admin only)
 * PUT /api/auth/users/:id
 */
router.put('/users/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { username, password, role } = req.body;

        const updates = {};

        if (username) {
            updates.username = username;
        }

        if (password) {
            if (password.length < 6) {
                return res.status(400).json({ error: 'Password must be at least 6 characters' });
            }
            updates.passwordHash = await auth.hashPassword(password);
        }

        if (role) {
            if (!['admin', 'viewer'].includes(role)) {
                return res.status(400).json({ error: 'Role must be either "admin" or "viewer"' });
            }

            // Prevent removing admin role from the last admin
            const user = await db.users.getById(id);
            if (user && user.role === 'admin' && role !== 'admin') {
                const allUsers = await db.users.getAll();
                const adminCount = allUsers.filter(u => u.role === 'admin').length;
                if (adminCount <= 1) {
                    return res.status(400).json({ error: 'Cannot remove admin role from the last admin user' });
                }
            }

            updates.role = role;
        }

        const updatedUser = await db.users.update(id, updates);
        res.json(updatedUser);
    } catch (err) {
        console.error('Error updating user:', err);
        res.status(userMutationErrorStatus(err)).json({ error: err.message || 'Server error' });
    }
});

/**
 * Delete a user (admin only)
 * DELETE /api/auth/users/:id
 */
router.delete('/users/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Prevent deleting yourself
        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        await db.users.delete(id);
        res.json({ success: true, message: 'User deleted successfully' });
    } catch (err) {
        console.error('Error deleting user:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

router.use('/2fa', require('./totp'));

module.exports = router;
