const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../auth');

/**
 * Get all users (admin only)
 * GET /api/users
 */
router.get('/', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const data = await db.loadDb();
        const users = (data.users || []).map(u => ({
            id: u.id,
            username: u.username,
            role: u.role,
            createdAt: u.createdAt
        }));
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Create user (admin only)
 * POST /api/users
 */
router.post('/', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { username, password, role } = req.body;
        
        if (!username || !password || !role) {
            return res.status(400).json({ error: 'Username, password, and role required' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        
        if (!['admin', 'viewer'].includes(role)) {
            return res.status(400).json({ error: 'Role must be admin or viewer' });
        }
        
        const passwordHash = await auth.hashPassword(password);
        const newUser = await db.users.create({ username, passwordHash, role });
        res.json(newUser);
    } catch (err) {
        if (err.code === 'USERNAME_EXISTS') {
            return res.status(400).json({ error: 'Username already exists' });
        }
        console.error('Create user error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Update user (admin only)
 * PUT /api/users/:id
 */
router.put('/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const { username, password, role } = req.body;
        
        if (password && password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        if (role && !['admin', 'viewer'].includes(role)) {
            return res.status(400).json({ error: 'Role must be admin or viewer' });
        }
        const passwordHash = password ? await auth.hashPassword(password) : null;
        const outcome = await db.mutateDb(data => {
            const user = data.users.find(u => u.id === userId);
            if (!user) return { changed: false, result: { status: 404, error: 'User not found' } };
            if (username && username !== user.username && data.users.some(u => u.username === username && u.id !== userId)) {
                return { changed: false, result: { status: 400, error: 'Username already exists' } };
            }
            if (role && user.role === 'admin' && role !== 'admin' && data.users.filter(u => u.role === 'admin').length <= 1) {
                return { changed: false, result: { status: 400, error: 'Cannot remove last admin user' } };
            }
            if (username) user.username = username;
            if (passwordHash) user.passwordHash = passwordHash;
            if (role) user.role = role;
            return { result: { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt } };
        });
        if (outcome.status) return res.status(outcome.status).json({ error: outcome.error });
        res.json(outcome);
    } catch (err) {
        console.error('Update user error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Delete user (admin only)
 * DELETE /api/users/:id
 */
router.delete('/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        
        const outcome = await db.mutateDb(data => {
            const userIndex = data.users.findIndex(u => u.id === userId);
            if (userIndex === -1) return { changed: false, result: { status: 404, error: 'User not found' } };
            const user = data.users[userIndex];
            if (user.id === req.session.userId) {
                return { changed: false, result: { status: 400, error: 'Cannot delete your own account' } };
            }
            if (user.role === 'admin' && data.users.filter(u => u.role === 'admin').length <= 1) {
                return { changed: false, result: { status: 400, error: 'Cannot delete last admin user' } };
            }
            data.users.splice(userIndex, 1);
            return { result: { success: true } };
        });
        if (outcome.status) return res.status(outcome.status).json({ error: outcome.error });
        res.json({ success: true });
    } catch (err) {
        console.error('Delete user error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
