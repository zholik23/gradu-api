const express = require('express');
const sql = require('mssql');
const router = express.Router();
const config = require('../config/config');
const admin = require('firebase-admin');

const pool = new sql.ConnectionPool(config);
const poolConnect = pool.connect();

// NEW: POST /api/task_requests/batch - Create multiple task requests in a single call
router.post('/batch', async (req, res) => {
    const { sender_uuid, assignee_uuid, tasks } = req.body;
    if (!sender_uuid || !assignee_uuid || !Array.isArray(tasks) || tasks.length === 0) {
        return res.status(400).json({ success: false, message: 'sender_uuid, assignee_uuid, and a non-empty tasks array are required.' });
    }

    const transaction = new sql.Transaction(pool);
    try {
        await poolConnect;
        await transaction.begin();

        for (const task of tasks) {
            const { task_type, task_data } = task;
            if (!task_type || !task_data) {
                // If any task is invalid, roll back the entire transaction
                await transaction.rollback();
                return res.status(400).json({ success: false, message: 'Each task in the array must have a task_type and task_data.' });
            }

            // FIX: Create a new request object for each iteration of the loop.
            const request = transaction.request(); 
            request.input('sender_uuid', sql.UniqueIdentifier, sender_uuid);
            request.input('assignee_uuid', sql.UniqueIdentifier, assignee_uuid);
            request.input('task_type', sql.VarChar, task_type);
            request.input('task_data', sql.NVarChar, JSON.stringify(task_data));

            await request.query(`
                INSERT INTO pending_tasks (sender_uuid, assignee_uuid, task_type, task_data)
                VALUES (@sender_uuid, @assignee_uuid, @task_type, @task_data);
            `);
        }
        
        await transaction.commit();

        // --- Send a single consolidated notification ---
        const userRequest = pool.request();
        userRequest.input('p_sender_uuid', sql.UniqueIdentifier, sender_uuid);
        userRequest.input('p_assignee_uuid', sql.UniqueIdentifier, assignee_uuid);

        const userInfo = await userRequest.query(`
            SELECT 
                (SELECT DisplayName FROM users WHERE user_uuid = @p_sender_uuid) as senderName,
                (SELECT FCMToken FROM Users WHERE user_uuid = @p_assignee_uuid) as recipientToken;
        `);

        if (userInfo.recordset.length > 0) {
            const { recipientToken, senderName } = userInfo.recordset[0];
            const taskCount = tasks.length;
            const notificationBody = taskCount === 1 
                ? (tasks[0].task_data.name || 'A new task') 
                : `${taskCount} new tasks have been assigned to you.`;

            if (recipientToken) {
                const messagePayload = {
                    notification: {
                        title: `Tasks from ${senderName}`,
                        body: notificationBody
                    },
                    token: recipientToken,
                    android: { priority: 'high' },
                };

                try {
                    await admin.messaging().send(messagePayload);
                    console.log('Successfully sent batch task notification.');
                } catch (notificationError) {
                    console.error('Error sending batch push notification:', notificationError);
                }
            }
        }
        
        res.status(201).json({ success: true, message: 'Task requests sent successfully.' });

    } catch (err) {
        // Ensure rollback on error
        if (transaction && !transaction.rolledBack) {
            await transaction.rollback();
        }
        console.error('Error creating batch task requests:', err);
        res.status(500).json({ success: false, message: 'Server error during batch creation.' });
    }
});


// POST /api/task_requests - Create a new pending task request
router.post('/', async (req, res) => {
    const { sender_uuid, assignee_uuid, task_type, task_data } = req.body;
    if (!sender_uuid || !assignee_uuid || !task_type || !task_data) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }
    try {
        await poolConnect;
        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        const request = transaction.request();
        request.input('sender_uuid', sql.UniqueIdentifier, sender_uuid);
        request.input('assignee_uuid', sql.UniqueIdentifier, assignee_uuid);
        request.input('task_type', sql.VarChar, task_type);
        request.input('task_data', sql.NVarChar, JSON.stringify(task_data));

        const result = await request.query(`
            INSERT INTO pending_tasks (sender_uuid, assignee_uuid, task_type, task_data)
            OUTPUT INSERTED.request_uuid
            VALUES (@sender_uuid, @assignee_uuid, @task_type, @task_data);
        `);
        const newRequestUuid = result.recordset[0].request_uuid;


        await transaction.commit();


        const userRequest = pool.request();
        userRequest.input('p_sender_uuid', sql.UniqueIdentifier, sender_uuid);
        userRequest.input('p_assignee_uuid', sql.UniqueIdentifier, assignee_uuid);

        const userInfo = await userRequest.query(`
                SELECT 
                    (SELECT DisplayName FROM users WHERE user_uuid = @p_sender_uuid) as senderName,
                    (SELECT FCMToken FROM Users WHERE user_uuid = @p_assignee_uuid) as recipientToken;
            `);

        if (userInfo.recordset.length > 0) {
            const recipientToken = userInfo.recordset[0].recipientToken;
            const senderName = userInfo.recordset[0].senderName;
            console.log('Recipient Token:', recipientToken);
            const taskName = task_data.name || 'New Task'; // Fallback task name

            if (recipientToken) {
                // Use chat_uuid key in data payload for testing notification delivery
                const messagePayload = {
                    notification: {
                        title: `Task from ${senderName}`,
                        body: taskName
                    },
                    token: recipientToken,
                    android: { priority: 'high' },
                    data: {
                        chat_uuid: newRequestUuid.toString()
                    }
                };

                try {
                    await admin.messaging().send(messagePayload);
                    console.log('Push notification payload:', messagePayload);
                    console.log('Successfully sent push notification for new task request.');
                } catch (notificationError) {
                    console.error('Error sending push notification:', notificationError);
                    // Do not send an error response here as the main operation was successful
                }
            } else {
                console.log('Could not send notification: recipient token or sender name is missing.');
            }
            res.status(201).json({
                success: true,
                message: 'Task request sent successfully.',
                request_uuid: newRequestUuid
            });
        }
    } catch (err) {
        console.error('Error creating task request:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/task_requests - Get pending requests FOR a user
router.get('/', async (req, res) => {
    const { user_uuid } = req.query;
    if (!user_uuid) return res.status(400).json({ success: false, message: 'user_uuid is required.' });
    try {
        await poolConnect;
        const request = pool.request();
        request.input('user_uuid', sql.UniqueIdentifier, user_uuid);

        const result = await request.query(`
            SELECT 
                pr.request_uuid, pr.sender_uuid, u.DisplayName as sender_display_name, 
                pr.task_type, pr.task_data, pr.status, pr.created_at
            FROM pending_tasks pr
            JOIN Users u ON pr.sender_uuid = u.user_uuid
            WHERE pr.assignee_uuid = @user_uuid AND pr.status = 'pending'
            ORDER BY pr.created_at DESC;
        `);
        res.status(200).json({ success: true, requests: result.recordset });
    } catch (err) {
        console.error('Error fetching task requests:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// PATCH /api/task_requests/:request_uuid - Accept or decline a request
router.patch('/:request_uuid', async (req, res) => {
    const { request_uuid } = req.params;
    const { status, actor_uuid } = req.body;

    if (!status || !actor_uuid || !['accepted', 'declined'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Valid status and actor_uuid are required.' });
    }

    const transaction = new sql.Transaction(pool);
    try {
        await poolConnect;
        await transaction.begin();

        const requestReq = transaction.request();
        requestReq.input('request_uuid', sql.UniqueIdentifier, request_uuid);
        requestReq.input('actor_uuid', sql.UniqueIdentifier, actor_uuid);

        const pendingTaskResult = await requestReq.query(`
            SELECT * FROM pending_tasks WHERE request_uuid = @request_uuid AND assignee_uuid = @actor_uuid AND status = 'pending';
        `);
        if (pendingTaskResult.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({ success: false, message: 'Request not found, already actioned, or permission denied.' });
        }
        const pendingTask = pendingTaskResult.recordset[0];

        const updateReq = transaction.request();
        updateReq.input('request_uuid', sql.UniqueIdentifier, request_uuid);
        updateReq.input('status', sql.VarChar, status);
        await updateReq.query(`
            UPDATE pending_tasks SET status = @status, updated_at = GETDATE() WHERE request_uuid = @request_uuid;
        `);

        if (status === 'accepted') {
            const taskData = JSON.parse(pendingTask.task_data);
            const { name, description, priority, valid_until, start_date, rules, medication_id } = taskData;

            let targetTaskTable, targetRuleTable, idField, taskUuidField;
            const createReq = transaction.request();

            if (pendingTask.task_type === 'medication') {
                targetTaskTable = 'medication_tasks';
                targetRuleTable = 'medication_task_rules';
                idField = 'med_task_uuid';
                taskUuidField = 'med_task_uuid'; // Column name in the rules table
                createReq.input('medication_id', sql.Int, medication_id);
            } else {
                targetTaskTable = 'task_test';
                targetRuleTable = 'task_rules_test';
                idField = 'task_uuid';
                taskUuidField = 'task_uuid'; // Column name in the rules table
            }

            createReq.input('name', sql.NVarChar, name);
            createReq.input('description', sql.NVarChar, description || '');
            createReq.input('priority', sql.SmallInt, priority || 2);
            createReq.input('valid_until', sql.Date, valid_until || null);
            createReq.input('start_date', sql.Date, start_date || null);
            createReq.input('sender_uuid', sql.UniqueIdentifier, pendingTask.sender_uuid);
            createReq.input('assignee_uuid', sql.UniqueIdentifier, pendingTask.assignee_uuid);

            const taskRes = await createReq.query(`
                INSERT INTO ${targetTaskTable} (name, description, priority, valid_until, start_date, sender_uuid, assignee_uuid${pendingTask.task_type === 'medication' ? ', medication_id' : ''})
                OUTPUT INSERTED.${idField}
                VALUES (@name, @description, @priority, @valid_until, @start_date, @sender_uuid, @assignee_uuid${pendingTask.task_type === 'medication' ? ', @medication_id' : ''});
            `);
            const newTaskUuid = taskRes.recordset[0][idField];

            if (rules && Array.isArray(rules)) {
                for (const r of rules) {
                    const rReq = transaction.request();
                    rReq.input('task_uuid_param', sql.UniqueIdentifier, newTaskUuid);
                    rReq.input('rule_type', sql.NVarChar, r.rule_type);
                    rReq.input('count', sql.Int, r.count || null);
                    const startTime = r.start_time ? new Date(`1970-01-01T${r.start_time}`) : null;
                    rReq.input('start_time', sql.Time, startTime);
                    rReq.input('interval_hours', sql.Int, r.interval_hours || null);
                    rReq.input('duration_days', sql.Int, r.duration_days || null);
                    const extrasString = (typeof r.extras === 'string') ? r.extras : JSON.stringify(r.extras);
                    rReq.input('extras', sql.NVarChar, r.extras ? extrasString : null);

                    await rReq.query(`
                        INSERT INTO ${targetRuleTable} (${taskUuidField}, rule_type, count, start_time, interval_hours, duration_days, extras) 
                        VALUES (@task_uuid_param, @rule_type, @count, @start_time, @interval_hours, @duration_days, @extras)
                    `);
                }
            }
        }

        await transaction.commit();
        res.status(200).json({ success: true, message: `Request ${status}.` });

    } catch (err) {
        if (transaction.rolledBack === false) {
            await transaction.rollback();
        }
        console.error('Error updating task request:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});


// GET /api/task_requests/sent - Get requests SENT BY a user
router.get('/sent', async (req, res) => {
    const { user_uuid } = req.query;
    if (!user_uuid) return res.status(400).json({ success: false, message: 'user_uuid is required.' });
    try {
        await poolConnect;
        const request = pool.request();
        request.input('user_uuid', sql.UniqueIdentifier, user_uuid);
        const result = await request.query(`
            SELECT 
                pr.request_uuid, pr.assignee_uuid, u.DisplayName as assignee_display_name, 
                pr.task_type, pr.task_data, pr.status, pr.created_at
            FROM pending_tasks pr
            JOIN Users u ON pr.assignee_uuid = u.user_uuid
            WHERE pr.sender_uuid = @user_uuid
            ORDER BY pr.created_at DESC;
        `);
        res.status(200).json({ success: true, requests: result.recordset });
    } catch (err) {
        console.error('Error fetching sent requests:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// DELETE /api/task_requests/:request_uuid - Delete a pending request
router.delete('/:request_uuid', async (req, res) => {
    const { request_uuid } = req.params;
    const { actor_uuid } = req.body;
    if (!actor_uuid) return res.status(400).json({ success: false, message: 'Actor UUID is required.' });
    try {
        await poolConnect;
        const request = pool.request();
        request.input('request_uuid', sql.UniqueIdentifier, request_uuid);
        request.input('actor_uuid', sql.UniqueIdentifier, actor_uuid);
        const result = await request.query(`
            DELETE FROM pending_tasks 
            WHERE request_uuid = @request_uuid AND sender_uuid = @actor_uuid AND status = 'pending';
        `);
        if (result.rowsAffected[0] > 0) {
            res.status(200).json({ success: true, message: 'Request deleted.' });
        } else {
            res.status(404).json({ success: false, message: 'Request not found, or it has already been actioned.' });
        }
    } catch (err) {
        console.error('Error deleting request:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// PUT /api/task_requests/:request_uuid - Modify a pending request
router.put('/:request_uuid', async (req, res) => {
    const { request_uuid } = req.params;
    const { actor_uuid, task_data } = req.body;
    if (!actor_uuid || !task_data) return res.status(400).json({ success: false, message: 'Actor UUID and task data are required.' });
    try {
        await poolConnect;
        const request = pool.request();
        request.input('request_uuid', sql.UniqueIdentifier, request_uuid);
        request.input('actor_uuid', sql.UniqueIdentifier, actor_uuid);
        request.input('task_data', sql.NVarChar, JSON.stringify(task_data));

        const result = await request.query(`
            UPDATE pending_tasks 
            SET task_data = @task_data, updated_at = GETDATE()
            WHERE request_uuid = @request_uuid AND sender_uuid = @actor_uuid AND status = 'pending';
        `);
        if (result.rowsAffected[0] > 0) {
            res.status(200).json({ success: true, message: 'Request updated.' });
        } else {
            res.status(404).json({ success: false, message: 'Request not found, or it has already been actioned.' });
        }
    } catch (err) {
        console.error('Error updating request:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;

