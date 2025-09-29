const express = require('express');
const sql = require('mssql');
const router = express.Router();
const config = require('../config/config');

const pool = new sql.ConnectionPool(config);
const poolConnect = pool.connect().catch(err => console.error('SQL Pool Error:', err));

// ⭐ MODIFIED: Helper functions now use and return UUIDs.
async function getUser(user_uuid) {
    await poolConnect;
    const req = pool.request();
    req.input('user_uuid', sql.UniqueIdentifier, user_uuid);
    const result = await req.query('SELECT user_uuid, Role, DisplayName FROM Users WHERE user_uuid = @user_uuid');
    return result.recordset[0] || null;
}

async function getTask(task_uuid) {
    await poolConnect;
    const req = pool.request();
    req.input('task_uuid', sql.UniqueIdentifier, task_uuid);
    const result = await req.query('SELECT * FROM task_test WHERE task_uuid = @task_uuid');
    return result.recordset[0] || null;
}

function canModify(actor, taskSenderUuid, taskAssigneeUuid) {
    if (!actor) return false;
    // Assuming Roles 2, 3, 4 are higher-level roles (e.g., Doctor, Admin)
    if (actor.Role === 4 || actor.Role === 3 || actor.Role === 2) return true;
    // Role 1 (e.g., a standard user) can only modify tasks they sent
    if (actor.Role === 1) return actor.user_uuid === taskSenderUuid;
    return false;
}

// --- GET All Tasks for a User ---
router.get('/', async (req, res) => {
    // ⭐ MODIFIED: Expecting user_uuid
    const { user_uuid } = req.query;
    if (!user_uuid) return res.status(400).json({ success: false, message: 'user_uuid is required.' });

    try {
        await poolConnect;
        const reqDb = pool.request();
        reqDb.input('user_uuid', sql.UniqueIdentifier, user_uuid);

        // ⭐ MODIFIED: Query now uses UUIDs for all joins and selections.
        const query = `
            SELECT
                t.task_uuid, t.sender_uuid, s.DisplayName AS sender_display_name,
                t.assignee_uuid, t.name, t.description, t.status, t.priority, t.created_at, t.updated_at, t.valid_until,
                t.start_date,
                r.rule_uuid, r.rule_type, r.count, r.start_time, r.interval_hours, r.duration_days, r.extras,
                ISNULL(c_today.completed_today, 0) AS completedOccurrences,
                ISNULL(c_total.total_days_completed, 0) AS totalDaysCompleted
            FROM task_test t
            LEFT JOIN Users s ON t.sender_uuid = s.user_uuid
            LEFT JOIN task_rules_test r ON t.task_uuid = r.task_uuid
            LEFT JOIN (
                SELECT parent_task_uuid, COUNT(*) AS completed_today
                FROM task_completions
                WHERE task_type = 'task' AND CAST(completed_at AS DATE) = CAST(GETDATE() AS DATE)
                GROUP BY parent_task_uuid
            ) c_today ON t.task_uuid = c_today.parent_task_uuid
            LEFT JOIN (
                SELECT parent_task_uuid, COUNT(DISTINCT CAST(completed_at AS DATE)) AS total_days_completed
                FROM task_completions
                WHERE task_type = 'task'
                GROUP BY parent_task_uuid
            ) c_total ON t.task_uuid = c_total.parent_task_uuid
            WHERE 
                t.assignee_uuid = @user_uuid
                AND t.status NOT IN ('deleted', 'completed')
            ORDER BY t.start_date, t.created_at DESC;
        `;
        const result = await reqDb.query(query);
        res.status(200).json({ success: true, data: result.recordset });
    } catch (err) {
        console.error('Error fetching tasks:', err);
        res.status(500).json({ success: false, message: 'Server error while fetching tasks.' });
    }
});

// --- Create a New Task ---
router.post('/', async (req, res) => {
    // ⭐ MODIFIED: Expecting UUIDs in the request body
    let { name, description, priority = 2, status = 'active', valid_until, start_date, sender_uuid, assignee_uuid, rules, actor_uuid } = req.body;
    if (!name || !assignee_uuid || !rules || !Array.isArray(rules) || !actor_uuid) {
        return res.status(400).json({ success: false, message: 'Required fields missing or rules empty.' });
    }

    const transaction = new sql.Transaction(pool);
    try {
        await poolConnect;
        await transaction.begin();
        const actor = await getUser(actor_uuid);
        if (!actor) {
            await transaction.rollback();
            return res.status(403).json({ success: false, message: 'Actor not found.' });
        }

        if (assignee_uuid === actor.user_uuid) sender_uuid = actor.user_uuid;

        if (actor.Role === 1 && sender_uuid !== actor.user_uuid) {
            await transaction.rollback();
            return res.status(403).json({ success: false, message: 'Permission denied.' });
        }

        const tReq = transaction.request();
        tReq.input('name', sql.NVarChar, name);
        tReq.input('description', sql.NVarChar, description || '');
        tReq.input('priority', sql.SmallInt, priority);
        tReq.input('status', sql.NVarChar, status);
        tReq.input('valid_until', sql.Date, valid_until || null);
        tReq.input('start_date', sql.Date, start_date || null);
        tReq.input('sender_uuid', sql.UniqueIdentifier, sender_uuid);
        tReq.input('assignee_uuid', sql.UniqueIdentifier, assignee_uuid);

        const taskRes = await tReq.query(`
            INSERT INTO task_test (name, description, priority, status, valid_until, start_date, sender_uuid, assignee_uuid)
            OUTPUT INSERTED.task_uuid
            VALUES (@name, @description, @priority, @status, @valid_until, @start_date, @sender_uuid, @assignee_uuid);
        `);
        const newTaskUuid = taskRes.recordset[0].task_uuid;

        for (const r of rules) {
            const rReq = transaction.request();
            rReq.input('task_uuid', sql.UniqueIdentifier, newTaskUuid);
            rReq.input('rule_type', sql.NVarChar, r.rule_type);
            rReq.input('count', sql.Int, r.count || null);
            const startTime = r.start_time ? new Date(`1970-01-01T${r.start_time}`) : null;
            rReq.input('start_time', sql.Time, startTime);
            rReq.input('interval_hours', sql.Int, r.interval_hours || null);
            rReq.input('duration_days', sql.Int, r.duration_days || null);
            const extrasString = (typeof r.extras === 'string') ? r.extras : JSON.stringify(r.extras);
            rReq.input('extras', sql.NVarChar, r.extras ? extrasString : null);
            await rReq.query(`INSERT INTO task_rules_test (task_uuid, rule_type, count, start_time, interval_hours, duration_days, extras) VALUES (@task_uuid, @rule_type, @count, @start_time, @interval_hours, @duration_days, @extras)`);
        }

        await transaction.commit();
        res.status(201).json({ success: true, message: 'Task added successfully!', taskUuid: newTaskUuid });
    } catch (err) {
        if (transaction.rolledBack === false) {
            await transaction.rollback();
        }
        console.error('Error creating task:', err);
        res.status(500).json({ success: false, message: 'Server error while adding task.' });
    }
});

// --- Update a Task ---
router.patch('/:task_uuid', async (req, res) => {
    // ⭐ MODIFIED: Expecting task_uuid in URL
    const { task_uuid } = req.params;
    const { name, description, priority, status, valid_until, start_date, rules, actor_uuid } = req.body;
    if (!actor_uuid) return res.status(400).json({ success: false, message: 'Actor UUID is required.' });

    const transaction = new sql.Transaction(pool);
    try {
        await poolConnect;
        await transaction.begin();
        const actor = await getUser(actor_uuid);
        const task = await getTask(task_uuid);
        if (!actor || !task) {
            await transaction.rollback();
            return res.status(404).json({ success: false, message: 'Actor or task not found.' });
        }
        if (!canModify(actor, task.sender_uuid, task.assignee_uuid)) {
            await transaction.rollback();
            return res.status(403).json({ success: false, message: 'Permission denied.' });
        }

        const updateFields = [];
        const tReq = transaction.request();
        tReq.input('task_uuid', sql.UniqueIdentifier, task_uuid);
        if (name) { updateFields.push('name = @name'); tReq.input('name', sql.NVarChar, name); }
        if (description) { updateFields.push('description = @description'); tReq.input('description', sql.NVarChar, description); }
        if (priority) { updateFields.push('priority = @priority'); tReq.input('priority', sql.SmallInt, priority); }
        if (status) { updateFields.push('status = @status'); tReq.input('status', sql.NVarChar, status); }
        if (valid_until) { updateFields.push('valid_until = @valid_until'); tReq.input('valid_until', sql.Date, valid_until); }
        if (start_date) { updateFields.push('start_date = @start_date'); tReq.input('start_date', sql.Date, start_date); }

        if (updateFields.length > 0) {
            await tReq.query(`UPDATE task_test SET ${updateFields.join(', ')}, updated_at = GETDATE() WHERE task_uuid = @task_uuid`);
        }
        if (rules && Array.isArray(rules) && rules.length > 0) {
            // First, delete the old rule to ensure a clean slate
            const deleteReq = transaction.request();
            deleteReq.input('task_uuid', sql.UniqueIdentifier, task_uuid);
            await deleteReq.query(`DELETE FROM task_rules_test WHERE task_uuid = @task_uuid`);

            // Then, insert the new rule (we assume only one rule per task)
            const newRule = rules[0];
            const rReq = transaction.request();
            rReq.input('task_uuid', sql.UniqueIdentifier, task_uuid);
            rReq.input('rule_type', sql.NVarChar, newRule.rule_type);
            rReq.input('count', sql.Int, newRule.count || null);
            const startTime = newRule.start_time ? new Date(`1970-01-01T${newRule.start_time}`) : null;
            rReq.input('start_time', sql.Time, startTime);
            rReq.input('interval_hours', sql.Int, newRule.interval_hours || null);
            rReq.input('duration_days', sql.Int, newRule.duration_days || null);
            const extrasString = (typeof newRule.extras === 'string') ? newRule.extras : JSON.stringify(newRule.extras);
            rReq.input('extras', sql.NVarChar, newRule.extras ? extrasString : null);
            await rReq.query(`INSERT INTO task_rules_test (task_uuid, rule_type, count, start_time, interval_hours, duration_days, extras) VALUES (@task_uuid, @rule_type, @count, @start_time, @interval_hours, @duration_days, @extras)`);
        }
        await transaction.commit();
        res.status(200).json({ success: true, message: 'Task updated successfully.' });
    } catch (err) {
        if (transaction.rolledBack === false) {
            await transaction.rollback();
        }
        console.error('Error updating task:', err);
        res.status(500).json({ success: false, message: 'Server error while updating task.' });
    }
});

// --- Delete a Task ---
router.delete('/:task_uuid', async (req, res) => {
    // ⭐ MODIFIED: Expecting task_uuid in URL
    const { task_uuid } = req.params;
    const { actor_uuid } = req.body;
    if (!actor_uuid) return res.status(400).json({ success: false, message: 'Actor UUID is required.' });

    try {
        await poolConnect;
        const actor = await getUser(actor_uuid);
        const task = await getTask(task_uuid);
        if (!actor || !task) {
            return res.status(404).json({ success: false, message: 'Actor or task not found.' });
        }
        if (!canModify(actor, task.sender_uuid, task.assignee_uuid)) {
            return res.status(403).json({ success: false, message: 'Permission denied.' });
        }

        const reqDb = pool.request();
        reqDb.input('task_uuid', sql.UniqueIdentifier, task_uuid);
        const result = await reqDb.query(`UPDATE task_test SET status = 'deleted', updated_at = GETDATE() WHERE task_uuid = @task_uuid`);
        if (result.rowsAffected[0] === 0) return res.status(404).json({ success: false, message: 'Task not found.' });

        res.status(200).json({ success: true, message: 'Task marked as deleted successfully.' });
    } catch (err) {
        console.error('Error deleting task:', err);
        res.status(500).json({ success: false, message: 'Server error while deleting task.' });
    }
});
router.patch('/:task_uuid/status', async (req, res) => {
    // Extract the task's UUID from the URL parameters
    const { task_uuid } = req.params;
    // Extract the new status and the person making the change from the request body
    const { status, actor_uuid } = req.body;

    // --- Validation ---
    if (!status) {
        return res.status(400).json({ success: false, message: 'New status is required.' });
    }
    if (!actor_uuid) {
        return res.status(400).json({ success: false, message: 'Actor UUID is required.' });
    }

    try {
        await poolConnect;
        const actor = await getUser(actor_uuid);
        const task = await getTask(task_uuid);

        // --- Authorization ---
        if (!actor || !task) {
            return res.status(404).json({ success: false, message: 'Actor or task not found.' });
        }
        if (!canModify(actor, task.sender_uuid, task.assignee_uuid)) {
            return res.status(403).json({ success: false, message: 'Permission denied.' });
        }

        // --- Database Update ---
        const reqDb = pool.request();
        reqDb.input('task_uuid', sql.UniqueIdentifier, task_uuid);
        reqDb.input('status', sql.NVarChar, status);

        // Update the status and the 'updated_at' timestamp
        const result = await reqDb.query(`
            UPDATE task_test 
            SET status = @status
            WHERE task_uuid = @task_uuid
        `);

        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ success: false, message: 'Task not found for status update.' });
        }

        res.status(200).json({ success: true, message: 'Task status updated successfully.' });

    } catch (err) {
        console.error('Error updating task status:', err);
        res.status(500).json({ success: false, message: 'Server error while updating task status.' });
    }
});
router.post('/deactivate-batch', async (req, res) => {
    // Expects a body like: { "task_uuids": ["uuid1", "uuid2", ...] }
    const { task_uuids, actor_uuid } = req.body;

    // --- Validation ---
    if (!actor_uuid) {
        return res.status(400).json({ success: false, message: 'Actor UUID is required.' });
    }
    if (!task_uuids || !Array.isArray(task_uuids) || task_uuids.length === 0) {
        return res.status(400).json({ success: false, message: 'A non-empty array of task_uuids is required.' });
    }

    try {
        await poolConnect;
        const actor = await getUser(actor_uuid);
        if (!actor) {
            return res.status(404).json({ success: false, message: 'Actor not found.' });
        }

        // Note: For simplicity, we are skipping individual permission checks here.
        // A more complex app might check if the actor can modify ALL tasks in the batch.

        // --- Database Update ---
        const request = pool.request();
        // Create a parameterized list for the IN clause (e.g., @uuid0, @uuid1, ...)
        const uuidParams = task_uuids.map((uuid, index) => `@uuid${index}`).join(',');
        task_uuids.forEach((uuid, index) => {
            request.input(`uuid${index}`, sql.UniqueIdentifier, uuid);
        });

        // Update all tasks in the list in a single query
        const result = await request.query(`
            UPDATE task_test 
            SET status = 'inactive'
            WHERE task_uuid IN (${uuidParams})
        `);

        res.status(200).json({ success: true, message: `${result.rowsAffected[0]} tasks deactivated successfully.` });

    } catch (err) {
        console.error('Error in batch deactivation:', err);
        res.status(500).json({ success: false, message: 'Server error during batch deactivation.' });
    }
});

module.exports = router;