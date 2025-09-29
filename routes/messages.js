const express = require('express');
const sql = require('mssql');
const router = express.Router();
const config = require('../config/config');

// ⭐ MODIFIED: Use a connection pool for better performance and consistency.
const pool = new sql.ConnectionPool(config);
const poolConnect = pool.connect();

// GET messages of a chat
// ⭐ MODIFIED: Endpoint now uses chat_uuid
router.get('/:chat_uuid', async (req, res) => {
    const { chat_uuid } = req.params;
    try {
        await poolConnect;
        const request = pool.request();
        // ⭐ MODIFIED: Input is now a UniqueIdentifier
        request.input('chat_uuid', sql.UniqueIdentifier, chat_uuid);

        // ⭐ MODIFIED: Query selects UUIDs and filters by chat_uuid
        const result = await request.query(`
            SELECT message_uuid, sender_uuid, content, sent_at, status
            FROM messages
            WHERE chat_uuid = @chat_uuid
            ORDER BY sent_at ASC
        `);

        res.status(200).json(result.recordset);
    } catch (err) {
        console.error('Error fetching messages:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST new message
router.post('/', async (req, res) => {
    // ⭐ MODIFIED: Expecting chat_uuid and sender_uuid
    const { chat_uuid, sender_uuid, content } = req.body;
    if (!chat_uuid || !sender_uuid || !content) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    try {
        await poolConnect;
        const request = pool.request();
        // ⭐ MODIFIED: Inputs are now UniqueIdentifiers
        request.input('chat_uuid', sql.UniqueIdentifier, chat_uuid);
        request.input('sender_uuid', sql.UniqueIdentifier, sender_uuid);
        request.input('content', sql.NVarChar, content);

        // ⭐ MODIFIED: Query inserts UUIDs and uses OUTPUT to get the new message_uuid
        const result = await request.query(`
            INSERT INTO messages (chat_uuid, sender_uuid, content)
            OUTPUT INSERTED.message_uuid
            VALUES (@chat_uuid, @sender_uuid, @content);
        `);

        res.status(201).json({ success: true, message_uuid: result.recordset[0].message_uuid });
    } catch (err) {
        console.error('Error sending message:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;