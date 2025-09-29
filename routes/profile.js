const express = require('express');
const sql = require('mssql');
const { BlobServiceClient } = require('@azure/storage-blob');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const config = require('../config/config');
require('dotenv').config();

const pool = new sql.ConnectionPool(config);
const poolConnect = pool.connect();

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
if (!AZURE_STORAGE_CONNECTION_STRING) {
    throw Error("Azure Storage Connection string not found.");
}
const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
const containerName = 'avatars';

// --- GET user profile ---
// ⭐ MODIFIED: Endpoint now uses user_uuid
router.get('/:user_uuid', async (req, res) => {
    const { user_uuid } = req.params;
    try {
        await poolConnect;
        const request = pool.request();
        // ⭐ MODIFIED: Input is now a UniqueIdentifier
        request.input('user_uuid', sql.UniqueIdentifier, user_uuid);
        
        // ⭐ MODIFIED: Query selects and joins on UUIDs
        const result = await request.query(`
            SELECT u.user_uuid, u.Username, u.Email, u.DisplayName, p.avatar_url
            FROM Users u
            LEFT JOIN user_avatars p ON u.user_uuid = p.user_uuid
            WHERE u.user_uuid = @user_uuid;
        `);

        if (result.recordset.length > 0) {
            res.status(200).json({ success: true, profile: result.recordset[0] });
        } else {
            res.status(404).json({ success: false, message: 'Profile not found.' });
        }
    } catch (err) {
        console.error('Error fetching profile:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// --- UPDATE user profile ---
// ⭐ MODIFIED: Endpoint now uses user_uuid
router.patch('/:user_uuid', async (req, res) => {
    const { user_uuid } = req.params;
    const { displayName, avatarUrl } = req.body;
    try {
        await poolConnect;
        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        
        if (displayName) {
            const userReq = transaction.request();
            // ⭐ MODIFIED: Use user_uuid to identify the user to update
            userReq.input('user_uuid', sql.UniqueIdentifier, user_uuid);
            userReq.input('displayName', sql.NVarChar, displayName);
            await userReq.query('UPDATE Users SET DisplayName = @displayName WHERE user_uuid = @user_uuid;');
        }

        if (avatarUrl) {
            const profileReq = transaction.request();
            // ⭐ MODIFIED: Use user_uuid for the MERGE operation
            profileReq.input('user_uuid', sql.UniqueIdentifier, user_uuid);
            profileReq.input('avatarUrl', sql.NVarChar, avatarUrl);
            await profileReq.query(`
                MERGE user_avatars AS target
                USING (SELECT @user_uuid AS user_uuid) AS source
                ON (target.user_uuid = source.user_uuid)
                WHEN MATCHED THEN
                    UPDATE SET avatar_url = @avatarUrl, updated_at = GETDATE()
                WHEN NOT MATCHED THEN
                    INSERT (user_uuid, avatar_url) VALUES (@user_uuid, @avatarUrl);
            `);
        }
        
        await transaction.commit();
        res.status(200).json({ success: true, message: 'Profile updated successfully.' });
    } catch (err) {
        console.error('Error updating profile:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});


// --- GET SAS Token for Avatar Upload ---
// (This route is correct as is and requires no changes)
router.get('/avatar/upload-url', async (req, res) => {
    try {
        const containerClient = blobServiceClient.getContainerClient(containerName);
        await containerClient.createIfNotExists();

        const blobName = `${uuidv4()}.jpg`;
        const blobClient = containerClient.getBlockBlobClient(blobName);
        
        const { BlobSASPermissions } = require("@azure/storage-blob");

        const sasOptions = {
            containerName: containerName,
            blobName: blobName,
            startsOn: new Date(),
            expiresOn: new Date(new Date().valueOf() + 3600 * 1000), // 1 hour
            permissions: BlobSASPermissions.parse("racw"), // Read, Add, Create, Write
        };
        
        const sasToken = await blobClient.generateSasUrl(sasOptions);

        res.status(200).json({
            success: true,
            uploadUrl: sasToken,
            blobName: blobName
        });
    } catch (err) {
        console.error('Error generating SAS token:', err);
        res.status(500).json({ success: false, message: 'Server error generating upload URL.' });
    }
});

module.exports = router;