// server/routes/auth.js
const express = require('express');
const sql = require('mssql');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();
const config = require('../config/config');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-that-should-be-long-and-random';

// Register a new user
router.post('/register', async (req, res) => {
    const { username, email, displayName, password, role } = req.body;
    if (!username || !email || !password || role === undefined) {
        return res.status(400).json({ success: false, message: 'All required fields must be provided.' });
    }

    const transaction = new sql.Transaction();
    try {
        await transaction.begin();
        let request = new sql.Request(transaction);
        const userCheck = await request.input('email', sql.NVarChar, email)
            .query('SELECT 1 FROM Users WHERE Email = @email');

        if (userCheck.recordset.length > 0) {
            await transaction.rollback();
            return res.status(409).json({ success: false, message: 'User with this email already exists.' });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        
        request = new sql.Request(transaction);
        request.input('username', sql.NVarChar, username);
        request.input('email', sql.NVarChar, email);
        request.input('displayName', sql.NVarChar, displayName || username);
        request.input('passwordHash', sql.NVarChar, passwordHash);
        request.input('authProvider', sql.NVarChar, 'local');
        request.input('role', sql.Int, role);

        const result = await request.query(`
            INSERT INTO Users (Username, Email, DisplayName, AuthProvider, PasswordHash, Role) 
            OUTPUT INSERTED.user_uuid
            VALUES (@username, @email, @displayName, @authProvider, @passwordHash, @role);
        `);
        
        const newUserUuid = result.recordset[0].user_uuid;
        
        // FIX: Changed payload key to snake_case 'user_uuid'
        const payload = { user_uuid: newUserUuid, role: role };
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

        await transaction.commit();
        res.status(201).json({
            success: true,
            message: 'Registration successful!',
            token: token,
            user: {
                // FIX: Changed response key to snake_case 'user_uuid'
                user_uuid: newUserUuid,
                displayName: displayName || username,
                role: role
            }
        });

    } catch (err) {
        if (transaction.active) {
            await transaction.rollback();
        }
        console.error('Registration error:', err);
        res.status(500).json({ success: false, message: 'Server error. Please try again later.' });
    }
});

// Google Login
router.post('/google-login', async (req, res) => {
    const { providerUserId } = req.body;
    if (!providerUserId) {
        return res.status(400).json({ success: false, message: 'Provider User ID is required.' });
    }
    try {
        await sql.connect(config);
        const request = new sql.Request();
        const userResult = await request
            .input('providerUserId', sql.NVarChar, providerUserId)
            .query('SELECT user_uuid, DisplayName, Role FROM Users WHERE ProviderUserID = @providerUserId AND AuthProvider = \'google\'');

        if (userResult.recordset.length > 0) {
            const user = userResult.recordset[0];
            // FIX: Changed payload key to snake_case 'user_uuid'
            const payload = { user_uuid: user.user_uuid, role: user.Role };
            const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

            return res.status(200).json({
                success: true,
                message: 'Login successful!',
                token: token,
                user: {
                    // FIX: Changed response key to snake_case 'user_uuid'
                    user_uuid: user.user_uuid,
                    displayName: user.DisplayName,
                    role: user.Role
                }
            });
        } else {
            return res.status(404).json({ success: false, message: 'User not registered.' });
        }
    } catch (err) {
        console.error('Google login error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});


// Google Registration
router.post('/google-register', async (req, res) => {
    const { email, displayName, providerUserId, role, username } = req.body;
    if (!email || !providerUserId || role === undefined || !username) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }
    try {
        await sql.connect(config);
        let request = new sql.Request();
        const userResult = await request.input('providerUserId', sql.NVarChar, providerUserId)
            .query('SELECT user_uuid, DisplayName, Role FROM Users WHERE ProviderUserID = @providerUserId AND AuthProvider = \'google\'');

        if (userResult.recordset.length > 0) {
            const user = userResult.recordset[0];
            // FIX: Changed payload key to snake_case 'user_uuid'
            const payload = { user_uuid: user.user_uuid, role: user.Role };
            const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
            return res.status(200).json({
                success: true,
                message: 'Google login successful!',
                token: token,
                user: { 
                    // FIX: Changed response key to snake_case 'user_uuid'
                    user_uuid: user.user_uuid, 
                    displayName: user.DisplayName, 
                    role: user.Role 
                }
            });
        }

        request = new sql.Request();
        request.input('username', sql.NVarChar, username);
        request.input('email', sql.NVarChar, email);
        request.input('displayName', sql.NVarChar, displayName || email);
        request.input('authProvider', sql.NVarChar, 'google');
        request.input('providerUserId', sql.NVarChar, providerUserId);
        request.input('role', sql.Int, role);

        const result = await request.query(`
            INSERT INTO Users (Username, Email, DisplayName, AuthProvider, ProviderUserID, Role) 
            OUTPUT INSERTED.user_uuid
            VALUES (@username, @email, @displayName, @authProvider, @providerUserId, @role);
        `);
        
        const newUserUuid = result.recordset[0].user_uuid;
        
        // FIX: Changed payload key to snake_case 'user_uuid'
        const payload = { user_uuid: newUserUuid, role: role };
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

        res.status(201).json({
            success: true,
            message: 'Google registration successful!',
            token: token,
            user: { 
                // FIX: Changed response key to snake_case 'user_uuid'
                user_uuid: newUserUuid, 
                displayName: displayName, 
                role: role 
            }
        });

    } catch (err) {
        console.error('Google auth error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});


// Local Login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }
    try {
        await sql.connect(config);
        const request = new sql.Request();
        const userResult = await request.input('email', sql.NVarChar, email)
            .query('SELECT user_uuid, PasswordHash, DisplayName, Role FROM Users WHERE Email = @email');

        if (userResult.recordset.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid email or password.' });
        }
        const user = userResult.recordset[0];
        const isMatch = await bcrypt.compare(password, user.PasswordHash);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid email or password.' });
        }
        
        // FIX: Changed payload key to snake_case 'user_uuid'
        const payload = { user_uuid: user.user_uuid, role: user.Role };
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });

        res.status(200).json({
            success: true,
            message: 'Login successful!',
            token: token,
            user: {
                // FIX: Changed response key to snake_case 'user_uuid'
                user_uuid: user.user_uuid,
                displayName: user.DisplayName,
                role: user.Role
            }
        });

    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Verify Token
router.get('/verify', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        await sql.connect(config);
        const request = new sql.Request();
        // FIX: Read 'user_uuid' from the decoded token
        const userResult = await request.input('userUuid', sql.UniqueIdentifier, decoded.user_uuid)
            .query('SELECT user_uuid, DisplayName, Role FROM Users WHERE user_uuid = @userUuid');

        if (userResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        const user = userResult.recordset[0];
        res.status(200).json({
            success: true,
            user: {
                // FIX: Changed response key to snake_case 'user_uuid'
                user_uuid: user.user_uuid,
                displayName: user.DisplayName,
                role: user.Role
            }
        });
    } catch (err) {
        if (err instanceof jwt.JsonWebTokenError) {
            return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
        }
        console.error('Token verification error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// Check Username Availability
router.get('/check-username/:username', async (req, res) => {
    try {
        await sql.connect(config);
        const request = new sql.Request();
        const result = await request.input('username', sql.NVarChar, req.params.username)
            .query('SELECT 1 FROM Users WHERE Username = @username');
        res.json({ isTaken: result.recordset.length > 0 });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
