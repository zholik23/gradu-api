const express = require('express');
const router = express.Router();
const sql = require('mssql');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const config = require('../config/config');
// Import the encryption utility from the path you provided
const { encrypt } = require('../utils/encryption');

// --- 1. CONFIGURATION ---

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const rulesPath = path.join(__dirname, '..', 'python', 'rules.json');
const rulesRaw = fs.readFileSync(rulesPath);
const rulesArray = JSON.parse(rulesRaw);
const rulesMap = new Map(rulesArray.map(rule => [rule.intent, rule]));

const CHATBOT_UUID = '00000000-0000-0000-0000-000000000001';

const pool = new sql.ConnectionPool(config);
const poolConnect = pool.connect();


// --- 2. THE CHATBOT ROUTE ---

router.post('/query', async (req, res) => {
    const { query, user_uuid } = req.body;

    if (!query || !user_uuid) {
        return res.status(400).json({ success: false, message: 'Missing "query" or "user_uuid".' });
    }

    const transaction = new sql.Transaction(pool);

    try {
        await poolConnect;
        await transaction.begin();

        // --- STEP 1: Find or create the chat between user and chatbot ---
        const user1_uuid = user_uuid < CHATBOT_UUID ? user_uuid : CHATBOT_UUID;
        const user2_uuid = user_uuid > CHATBOT_UUID ? user_uuid : CHATBOT_UUID;

        const chatRequest = transaction.request();
        chatRequest.input('user1_uuid', sql.UniqueIdentifier, user1_uuid);
        chatRequest.input('user2_uuid', sql.UniqueIdentifier, user2_uuid);

        let chatResult = await chatRequest.query(`
            SELECT chat_uuid FROM chats WHERE user1_uuid = @user1_uuid AND user2_uuid = @user2_uuid;
        `);

        let chat_uuid;
        if (chatResult.recordset.length > 0) {
            chat_uuid = chatResult.recordset[0].chat_uuid;
        } else {
            const newChat = await chatRequest.query(`
                INSERT INTO chats (user1_uuid, user2_uuid) OUTPUT INSERTED.chat_uuid VALUES (@user1_uuid, @user2_uuid);
            `);
            chat_uuid = newChat.recordset[0].chat_uuid;
        }

        // --- STEP 2: Encrypt and save the user's message to the database ---
        const encryptedUserQuery = encrypt(query); // Encrypt the content
        const userMessageRequest = transaction.request();
        userMessageRequest.input('chat_uuid', sql.UniqueIdentifier, chat_uuid);
        userMessageRequest.input('sender_uuid', sql.UniqueIdentifier, user_uuid);
        userMessageRequest.input('content', sql.NVarChar, encryptedUserQuery);
        await userMessageRequest.query(`
            INSERT INTO messages (chat_uuid, sender_uuid, content) VALUES (@chat_uuid, @sender_uuid, @content);
        `);

        // --- STEP 3: Get the intent and generate the AI response (using the original, unencrypted query) ---
        const intentResult = await getIntentFromPython(query);
        const { intent } = intentResult;

        let finalResponseText;

        if (intent === 'FALLBACK' || !intent) {
            finalResponseText = await generateFinalResponse(query, 'FALLBACK', 'No data found.', 'The chatbot could not understand the request.');
        } else {
            const rule = rulesMap.get(intent);
            if (!rule || !rule.template) {
                throw new Error(`No SQL template found for intent: ${intent}`);
            }
            const dbRequest = pool.request();
            dbRequest.input('user_uuid', sql.UniqueIdentifier, user_uuid);
            const sqlResult = await dbRequest.query(rule.template);
            finalResponseText = await generateFinalResponse(query, intent, JSON.stringify(sqlResult.recordset, null, 2), rule.response_template);
        }

        // --- STEP 4: Encrypt and save the chatbot's response to the database ---
        const encryptedBotResponse = encrypt(finalResponseText); // Encrypt the content
        const botMessageRequest = transaction.request();
        botMessageRequest.input('chat_uuid', sql.UniqueIdentifier, chat_uuid);
        botMessageRequest.input('sender_uuid', sql.UniqueIdentifier, CHATBOT_UUID);
        botMessageRequest.input('content', sql.NVarChar, encryptedBotResponse);
        const finalMessageResult = await botMessageRequest.query(`
             INSERT INTO messages (chat_uuid, sender_uuid, content, status) 
             OUTPUT INSERTED.id
             VALUES (@chat_uuid, @sender_uuid, @content, 0);
        `);

        // --- STEP 5: Update the 'last_message_id' in the chats table ---
        const lastMessageId = finalMessageResult.recordset[0].id;
        const updateChatReq = transaction.request();
        updateChatReq.input('chat_uuid', sql.UniqueIdentifier, chat_uuid);
        updateChatReq.input('lastMessageId', sql.BigInt, lastMessageId);
        await updateChatReq.query(`
            UPDATE chats SET last_message_id = @lastMessageId, updated_at = GETDATE() WHERE chat_uuid = @chat_uuid;
        `);

        await transaction.commit();

        // Return the plain-text response to the app for immediate display if needed
        res.status(200).json({ success: true, response: finalResponseText });

    } catch (error) {
        if (transaction._aborted === false && transaction._finished === false) {
            await transaction.rollback();
        }
        console.error('[Server] Chatbot pipeline error:', error);
        res.status(500).json({ success: false, message: 'An error occurred in the chatbot pipeline.' });
    }
});


// --- 3. HELPER FUNCTIONS (No changes here) ---

function getIntentFromPython(userQuery) {
    return new Promise((resolve, reject) => {
        const pythonDir = path.join(__dirname, '..', 'python');
        const pythonScriptPath = path.join(pythonDir, 'chatbot.py');
        const pythonExecutableName = process.platform === 'win32' ? 'python.exe' : 'python';
        const pythonVenvPath = process.platform === 'win32' ? 'Scripts' : 'bin';
        const pythonExecutable = path.join(pythonDir, 'venv', pythonVenvPath, pythonExecutableName);


        if (!fs.existsSync(pythonExecutable)) {
            return reject(new Error(`Python executable not found at ${pythonExecutable}`));
        }

        const pythonProcess = spawn(pythonExecutable, [pythonScriptPath, userQuery], { cwd: pythonDir });

        let jsonData = '';
        let errorData = '';

        pythonProcess.stdout.on('data', (data) => { jsonData += data.toString(); });
        pythonProcess.stderr.on('data', (data) => { errorData += data.toString(); });

        pythonProcess.on('close', (code) => {
            if (code === 0) {
                try {
                    const parsedJson = JSON.parse(jsonData);
                    resolve(parsedJson);
                } catch (e) {
                    console.error("[Server] Failed to parse JSON from Python. Raw output:", jsonData);
                    reject(new Error('Failed to parse script output.'));
                }
            } else {
                console.error(`[Server] Python script exited with error code ${code}. Details:`, errorData);
                reject(new Error('Python intent classifier failed.'));
            }
        });
    });
}

async function generateFinalResponse(originalQuery, intent, data, responseTemplate) {
    const prompt = `
        You are a friendly and helpful AI assistant. Your task is to create a natural, conversational response based on the user's query and the data retrieved from a database.

        **User's Original Question:**
        "${originalQuery}"

        **System Information:**
        - Identified Intent: "${intent}"
        - Data Retrieved from Database (in JSON format):
        \`\`\`json
        ${data}
        \`\`\`

        **Instructions:**
        - Analyze the "Data Retrieved from Database".
        - Formulate a response that directly answers the user's question in a clear and friendly tone.
        - **Do NOT just repeat the JSON data.** Summarize it or present it conversationally.
        - If the data is an empty array \`[]\`, it means no information was found. Respond by saying something like, "I looked, but I couldn't find any information about that."
        - If the intent is "FALLBACK", it means you didn't understand. Apologize and ask the user to rephrase their question.
        - Use the following template as a general guide for the tone and structure of your answer: "${responseTemplate}"
    `;

    try {
        const result = await geminiModel.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error("Error calling Gemini for final response:", error);
        return "I'm sorry, I had trouble formulating a response.";
    }
}


module.exports = router;