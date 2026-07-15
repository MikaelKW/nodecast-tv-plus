const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const { withBasePath } = require('./config/basePath');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const { Strategy: LocalStrategy } = require('passport-local');
const securityConfig = require('./config/security');
const { resolveOidcEndpoints } = require('./services/oidcDiscovery');

/**
 * Authentication and Authorization Module
 * Handles user authentication, session management, and role-based access control
 * Using Passport.js with JWT tokens
 */

const JWT_SECRET = securityConfig.jwtSecret;
const JWT_EXPIRY = '24h';

function parseCookies(req) {
    const header = req?.headers?.cookie;
    if (!header) return {};

    return header.split(';').reduce((cookies, part) => {
        const separator = part.indexOf('=');
        if (separator === -1) return cookies;

        const key = part.slice(0, separator).trim();
        const rawValue = part.slice(separator + 1).trim();
        try {
            cookies[key] = decodeURIComponent(rawValue);
        } catch {
            cookies[key] = rawValue;
        }
        return cookies;
    }, {});
}

function extractJwtFromCookie(req) {
    return parseCookies(req)[securityConfig.authCookieName] || null;
}

function useSecureCookie(req) {
    if (process.env.AUTH_COOKIE_SECURE === 'true') return true;
    if (process.env.AUTH_COOKIE_SECURE === 'false') return false;
    return Boolean(req.secure);
}

function getAuthCookieOptions(req) {
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: useSecureCookie(req),
        maxAge: securityConfig.authCookieMaxAgeMs,
        path: '/'
    };
}

function setAuthCookie(req, res, token) {
    res.cookie(securityConfig.authCookieName, token, getAuthCookieOptions(req));
}

function clearAuthCookie(req, res) {
    const options = getAuthCookieOptions(req);
    delete options.maxAge;
    res.clearCookie(securityConfig.authCookieName, options);
}

/**
 * Hash password using bcrypt
 */
async function hashPassword(password) {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
}

/**
 * Verify password against hash
 */
async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}

/**
 * Generate JWT token
 */
function generateToken(user) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            role: user.role
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
    );
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }
}

/**
 * Configure Passport Local Strategy for username/password authentication
 */
function configureLocalStrategy(getUserByUsername, verifyUserPassword) {
    passport.use(new LocalStrategy(
        async (username, password, done) => {
            try {
                const user = await getUserByUsername(username);

                if (!user) {
                    return done(null, false, { message: 'Invalid credentials' });
                }

                const isValid = await verifyUserPassword(password, user.passwordHash);

                if (!isValid) {
                    return done(null, false, { message: 'Invalid credentials' });
                }

                return done(null, user);
            } catch (err) {
                return done(err);
            }
        }
    ));
}

/**
 * Configure Passport JWT Strategy for token-based authentication
 */
function configureJwtStrategy(getUserById) {
    const options = {
        jwtFromRequest: ExtractJwt.fromExtractors([
            ExtractJwt.fromAuthHeaderAsBearerToken(),
            extractJwtFromCookie
        ]),
        secretOrKey: JWT_SECRET
    };

    passport.use(new JwtStrategy(options, async (payload, done) => {
        try {
            const user = await getUserById(payload.id);

            if (!user) {
                return done(null, false);
            }

            return done(null, {
                id: user.id,
                username: user.username,
                role: user.role
            });
        } catch (err) {
            return done(err, false);
        }
    }));
}

/**
 * Configure Passport session serialization
 * Required for OIDC flow which uses sessions
 */
function configureSessionSerialization(getUserById) {
    passport.serializeUser((user, done) => {
        done(null, user.id);
    });

    passport.deserializeUser(async (id, done) => {
        try {
            const user = await getUserById(id);
            done(null, user);
        } catch (err) {
            done(err, null);
        }
    });
}

/**
 * Configure Passport OpenID Connect Strategy
 */
async function configureOidcStrategy(findUserByOidcId, findUserByEmail, createUser) {
    if (!process.env.OIDC_ISSUER_URL || !process.env.OIDC_CLIENT_ID || !process.env.OIDC_CLIENT_SECRET) {
        console.warn('OIDC configuration missing - SSO disabled');
        return false;
    }

    const { Strategy: OpenIDConnectStrategy } = require('passport-openidconnect');

    let endpoints;
    try {
        endpoints = await resolveOidcEndpoints({
            issuerUrl: process.env.OIDC_ISSUER_URL,
            authorizationUrl: process.env.OIDC_AUTH_URL,
            tokenUrl: process.env.OIDC_TOKEN_URL,
            userInfoUrl: process.env.OIDC_USERINFO_URL
        });
    } catch (error) {
        console.error(`[OIDC] Configuration failed - SSO disabled: ${error.message}`);
        return false;
    }

    passport.use(new OpenIDConnectStrategy({
        issuer: process.env.OIDC_ISSUER_URL,
        authorizationURL: endpoints.authorizationURL,
        tokenURL: endpoints.tokenURL,
        userInfoURL: endpoints.userInfoURL,
        clientID: process.env.OIDC_CLIENT_ID,
        clientSecret: process.env.OIDC_CLIENT_SECRET,
        callbackURL: process.env.OIDC_CALLBACK_URL || withBasePath('/api/auth/oidc/callback'),
        scope: ['openid', 'profile', 'email']
    },
        async (...args) => {
            // The done callback is always the last argument
            const done = args[args.length - 1];

            // Map known arguments
            // Standard: issuer, sub, profile, accessToken, refreshToken, done
            // Some versions: issuer, sub, profile, accessToken, refreshToken, params, done

            let issuer, sub, profile;

            if (args.length === 3) {
                // Scenario: (issuer, profile, done)
                const arg0 = args[0];
                const arg1 = args[1];

                if (typeof arg1 === 'object' && arg1.id) {
                    issuer = arg0;
                    profile = arg1;
                    sub = profile.id;
                } else if (typeof arg0 === 'string' && typeof arg1 === 'string') {
                    issuer = arg0;
                    sub = arg1;
                    profile = { id: sub, displayName: 'Unknown' };
                }
            } else if (args.length >= 4) {
                // Assume standard: iss, sub, profile...
                issuer = args[0];
                sub = args[1];
                profile = args[2];
            }

            if (!sub && profile && profile.id) sub = profile.id;

            if (!sub) {
                return done(new Error('Could not identify OIDC Subject (sub) from arguments'));
            }

            try {
                // 1. Try to find by OIDC ID (sub)
                let user = await findUserByOidcId(sub);

                // 2. If not found, try to match by email
                // Extract email - handle both profile.emails[] (Google) and profile.email (others)
                const email = profile.emails?.[0]?.value || profile.email || profile._json?.email;

                if (!user && email) {
                    user = await findUserByEmail(email);

                    // If found by email but no OIDC ID, link them
                    if (user && !user.oidcId) {
                        // We don't have a direct update method for specific fields without full user object in this context
                        // Ideally we'd update the user here. For now, we'll just log in.
                        // Future: Update user with oidcId
                    }
                }

                // 3. If still not found, create new user (JIT Provisioning)
                if (!user) {
                    const username = profile.username || profile.displayName || (email ? email.split('@')[0] : `user_${sub.substring(0, 8)}`);

                    user = await createUser({
                        username: username,
                        role: 'viewer', // Default role for SSO users
                        oidcId: sub,
                        email: email || null
                    });
                }

                return done(null, user);
            } catch (err) {
                return done(err);
            }
        }));

    console.log(`[OIDC] Strategy configured using ${endpoints.source} endpoints`);
    return true;
}

/**
 * Middleware: Require authentication using Passport JWT
 */
const requireAuth = passport.authenticate('jwt', { session: false });

/**
 * Middleware: Require admin role
 */
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden - Admin access required' });
    }
    next();
}

/**
 * Block cross-site browser requests that could otherwise reuse the auth cookie.
 * Requests without browser origin headers remain available to trusted API clients.
 */
function requireSameOrigin(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const fetchSite = req.get('sec-fetch-site');
    const origin = req.get('origin');
    if (!origin) {
        return fetchSite === 'cross-site'
            ? res.status(403).json({ error: 'Cross-site request blocked' })
            : next();
    }

    try {
        const requestOrigin = new URL(origin).origin.toLowerCase();
        const forwardedHost = req.get('x-forwarded-host')?.split(',')[0].trim().toLowerCase();
        const requestHost = req.get('host')?.toLowerCase();
        const configuredOrigin = process.env.APP_ORIGIN
            ? new URL(process.env.APP_ORIGIN).origin.toLowerCase()
            : null;
        const allowedOrigins = [forwardedHost, requestHost]
            .filter(Boolean)
            .map(host => `${req.protocol}://${host}`.toLowerCase());
        if (configuredOrigin) allowedOrigins.push(configuredOrigin);

        if (allowedOrigins.includes(requestOrigin)) return next();
    } catch {
        // Invalid origins are rejected below.
    }

    return res.status(403).json({ error: 'Cross-site request blocked' });
}

/**
 * Middleware: Check for specific role
 */
function requireRole(role) {
    return (req, res, next) => {
        if (!req.user || req.user.role !== role) {
            return res.status(403).json({ error: `Forbidden - ${role} access required` });
        }
        next();
    };
}

module.exports = {
    passport,
    hashPassword,
    verifyPassword,
    generateToken,
    verifyToken,
    setAuthCookie,
    clearAuthCookie,
    configureLocalStrategy,
    configureJwtStrategy,
    configureSessionSerialization,
    configureOidcStrategy,
    requireAuth,
    requireAdmin,
    requireSameOrigin,
    requireRole
};
