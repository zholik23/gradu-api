// server/routes/chats.js
const express = require('express');
const sql = require('mssql');
const router = express.Router();
const config = require('../config/config');
const { encrypt, decrypt } = require('../utils/encryption');
const admin = require('firebase-admin');

const pool = new sql.ConnectionPool(config);
const poolConnect = pool.connect();

// --- Search for users by username (nickname) ---
router.get('/search', async (req, res) => {
    // ⭐ MODIFIED: Using actor_uuid instead of actor_id
    const { username, actor_uuid } = req.query;
    if (!username || !actor_uuid) {
        return res.status(400).json({ success: false, message: 'Username and actor_uuid are required.' });
    }
    try {
        await poolConnect;
        const request = pool.request();
        request.input('username', sql.NVarChar, `%${username}%`);
        // ⭐ MODIFIED: Input type is now UniqueIdentifier
        request.input('actor_uuid', sql.UniqueIdentifier, actor_uuid);

        // ⭐ MODIFIED: Query now uses user_uuid and joins on UUIDs
        const result = await request.query(`
            SELECT u.user_uuid, u.Username, u.DisplayName, p.avatar_url
            FROM Users u
            LEFT JOIN user_avatars p ON u.user_uuid = p.user_uuid
            WHERE u.Username LIKE @username 
            AND u.user_uuid != @actor_uuid
            AND u.user_uuid != '00000000-0000-0000-0000-000000000001'; -- <-- ADD THIS LINE
        `);
        res.status(200).json({ success: true, users: result.recordset });
    } catch (err) {
        console.error('User search error:', err);
        res.status(500).json({ success: false, message: 'Server error during user search.' });
    }
});

// --- Get all chats for a user ---
router.get('/', async (req, res) => {
    // ⭐ MODIFIED: Using user_uuid instead of userId
    const { user_uuid } = req.query;
    if (!user_uuid) return res.status(400).json({ success: false, message: 'user_uuid is required.' });
    try {
        await poolConnect;
        const request = pool.request();
        // ⭐ MODIFIED: Input type is now UniqueIdentifier
        request.input('user_uuid', sql.UniqueIdentifier, user_uuid);

        // ⭐ MODIFIED: Query now joins on UUIDs and selects UUIDs
        const result = await request.query(`
            SELECT 
                c.chat_uuid,
                c.user1_uuid, u1.DisplayName as user1_display_name, p1.avatar_url as user1_avatar_url,
                c.user2_uuid, u2.DisplayName as user2_display_name, p2.avatar_url as user2_avatar_url,
                m.content as last_message_content,
                m.sent_at as last_message_sent_at,
                m.sender_uuid as last_message_sender_uuid,
                m.status as last_message_status
            FROM chats c
            -- NOTE: This join remains on the integer ID, as per your schema (chats.last_message_id -> messages.id)
            INNER JOIN messages m ON c.last_message_id = m.id
            LEFT JOIN Users u1 ON c.user1_uuid = u1.user_uuid
            LEFT JOIN Users u2 ON c.user2_uuid = u2.user_uuid
            LEFT JOIN user_avatars p1 ON c.user1_uuid = p1.user_uuid
            LEFT JOIN user_avatars p2 ON c.user2_uuid = p2.user_uuid
            WHERE (c.user1_uuid = @user_uuid OR c.user2_uuid = @user_uuid)
            ORDER BY m.sent_at DESC;
        `);

        const chats = result.recordset.map(chat => {
            if (chat.last_message_content) {
                chat.last_message_content = decrypt(chat.last_message_content);
            }
            return chat;
        });

        res.status(200).json({ success: true, chats });
    } catch (err) {
        console.error('Error fetching chats:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// --- Get all messages for a specific chat ---
router.get('/:chat_uuid/messages', async (req, res) => {
    // ⭐ MODIFIED: Using chat_uuid and user_uuid
    const { chat_uuid } = req.params;
    const { user_uuid } = req.query;
    if (chat_uuid === 'placeholder-chat-uuid') {
        return res.status(200).json({ success: true, messages: [] });
    }

    if (!user_uuid) return res.status(400).json({ success: false, message: 'user_uuid is required.' });
    try {
        await poolConnect;
        const request = pool.request();
        // ⭐ MODIFIED: Input types are now UniqueIdentifier
        request.input('chat_uuid', sql.UniqueIdentifier, chat_uuid);
        request.input('user_uuid', sql.UniqueIdentifier, user_uuid);

        const chatCheck = await request.query(`
            SELECT 1 FROM chats WHERE chat_uuid = @chat_uuid AND (user1_uuid = @user_uuid OR user2_uuid = @user_uuid)
        `);
        if (chatCheck.recordset.length === 0) {
            return res.status(403).json({ success: false, message: 'Access denied.' });
        }

        const updateRequest = pool.request();
        updateRequest.input('chat_uuid', sql.UniqueIdentifier, chat_uuid);
        updateRequest.input('user_uuid', sql.UniqueIdentifier, user_uuid);

        // ⭐ MODIFIED: Update uses UUIDs to identify the chat and sender
        await updateRequest.query(`
            UPDATE messages 
            SET status = 2 -- 2 for 'read'
            WHERE chat_uuid = @chat_uuid AND sender_uuid != @user_uuid AND status < 2;
        `);

        const messageResult = await request.query(`
            SELECT message_uuid, chat_uuid, sender_uuid, content, sent_at, status 
            FROM messages 
            WHERE chat_uuid = @chat_uuid
            ORDER BY sent_at ASC;
        `);

        const messages = messageResult.recordset.map(msg => {
            msg.content = decrypt(msg.content);
            return msg;
        });
        res.status(200).json({ success: true, messages });
    } catch (err) {
        console.error('Error fetching messages:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// --- Send a message ---
router.post('/messages', async (req, res) => {
    // ⭐ MODIFIED: Expecting sender_uuid and recipient_uuid
    const { sender_uuid, recipient_uuid, content } = req.body;
    if (!sender_uuid || !recipient_uuid || !content) {
        return res.status(400).json({ success: false, message: 'Sender, recipient, and content are required.' });
    }

    const transaction = new sql.Transaction(pool);
    try {
        await poolConnect;
        await transaction.begin();
        const request = transaction.request();

        // ⭐ NEW LOGIC: Sort UUIDs lexicographically to ensure a consistent chat record between two users
        const user1_uuid = sender_uuid < recipient_uuid ? sender_uuid : recipient_uuid;
        const user2_uuid = sender_uuid > recipient_uuid ? sender_uuid : recipient_uuid;

        request.input('user1_uuid', sql.UniqueIdentifier, user1_uuid);
        request.input('user2_uuid', sql.UniqueIdentifier, user2_uuid);

        let chatResult = await request.query(`
            SELECT chat_uuid FROM chats WHERE user1_uuid = @user1_uuid AND user2_uuid = @user2_uuid;
        `);

        let chat_uuid;
        if (chatResult.recordset.length > 0) {
            chat_uuid = chatResult.recordset[0].chat_uuid;
        } else {
            const newChat = await request.query(`
                INSERT INTO chats (user1_uuid, user2_uuid) OUTPUT INSERTED.chat_uuid VALUES (@user1_uuid, @user2_uuid);
            `);
            chat_uuid = newChat.recordset[0].chat_uuid;
        }

        const encryptedContent = encrypt(content);
        const messageRequest = transaction.request();
        messageRequest.input('chat_uuid', sql.UniqueIdentifier, chat_uuid);
        messageRequest.input('sender_uuid', sql.UniqueIdentifier, sender_uuid);
        messageRequest.input('content', sql.NVarChar, encryptedContent);

        const newMessage = await messageRequest.query(`
            INSERT INTO messages (chat_uuid, sender_uuid, content, status) 
            OUTPUT INSERTED.id, INSERTED.message_uuid, INSERTED.sent_at
            VALUES (@chat_uuid, @sender_uuid, @content, 0);
        `);

        // This remains an integer ID for the last_message_id column
        const newMessageId = newMessage.recordset[0].id;
        const newMessageUuid = newMessage.recordset[0].message_uuid;
        const newSentAt = newMessage.recordset[0].sent_at;

        const updateChatReq = transaction.request();
        updateChatReq.input('chat_uuid', sql.UniqueIdentifier, chat_uuid);
        updateChatReq.input('lastMessageId', sql.BigInt, newMessageId);
        await updateChatReq.query(`
            UPDATE chats SET last_message_id = @lastMessageId, updated_at = GETDATE() WHERE chat_uuid = @chat_uuid;
        `);

        await transaction.commit();

        const userRequest = pool.request();
        const userInfo = await userRequest
            .input('recipient_uuid', sql.UniqueIdentifier, recipient_uuid)
            .input('sender_uuid', sql.UniqueIdentifier, sender_uuid)
            .query(`
                SELECT 
                    (SELECT FCMToken FROM Users WHERE user_uuid = @recipient_uuid) as recipientToken,
                    (SELECT DisplayName FROM Users WHERE user_uuid = @sender_uuid) as senderName
            `);

        const recipientToken = userInfo.recordset[0].recipientToken;
        const senderName = userInfo.recordset[0].senderName;

        if (recipientToken) {
            const messagePayload = {
                notification: { title: ` ${senderName}`, body: content },
                token: recipientToken,
                android: { priority: 'high' },
                data: { chat_uuid: chat_uuid.toString() }
            };
            await admin.messaging().send(messagePayload);
            console.log('Successfully sent push notification.');
        }


        res.status(201).json({
            success: true,
            message: 'Message sent.',
            newMessage: {
                id: newMessageId, // Still useful for legacy or ordering
                message_uuid: newMessageUuid,
                chat_uuid: chat_uuid,
                sender_uuid: sender_uuid,
                content: content,
                sent_at: newSentAt,
                status: 0
            }
        });

    } catch (err) {
        if (transaction._aborted === false && transaction._finished === false) {
            await transaction.rollback();
        }
        console.error('Error sending message:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;