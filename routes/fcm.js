const express = require('express');
const sql = require('mssql');
const router = express.Router();
const config = require('../config/config');

const pool = new sql.ConnectionPool(config);
const poolConnect = pool.connect();

// POST /api/fcm-token
router.post('/fcm-token', async (req, res) => {
    // ⭐ FIX: Changed from 'userId' to 'user_uuid' to match the Flutter app's request.
    const { user_uuid, fcmToken } = req.body;

    if (!user_uuid || !fcmToken) {
        return res.status(400).json({ success: false, message: 'user_uuid and fcmToken are required.' });
    }

    try {
        await poolConnect;
        const request = pool.request();

        await request
            .input('user_uuid', sql.UniqueIdentifier, user_uuid)
            .input('fcmToken', sql.NVarChar, fcmToken)
            .query('UPDATE Users SET FCMToken = @fcmToken WHERE user_uuid = @user_uuid');

        res.status(200).json({ success: true, message: 'FCM token updated successfully.' });
    } catch (err) {
        console.error('Error saving FCM token:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
