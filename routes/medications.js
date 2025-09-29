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

async function getMedTask(med_task_uuid) {
    await poolConnect;
    const req = pool.request();
    req.input('med_task_uuid', sql.UniqueIdentifier, med_task_uuid);
    const result = await req.query('SELECT * FROM medication_tasks WHERE med_task_uuid = @med_task_uuid');
    return result.recordset[0] || null;
}

function canModifyMed(actor, medTaskAssigneeUuid) {
    if (!actor) return false;
    if (actor.Role === 3) return true; // Role 3 is a doctor/admin
    return actor.user_uuid === medTaskAssigneeUuid;
}

// --- GET All Medication Tasks for a User ---
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
                mt.med_task_uuid, mt.medication_id, mt.assignee_uuid, mt.name, mt.description,
                mt.status, mt.priority, mt.created_at, mt.updated_at, mt.valid_until,
                mt.start_date,
                r.rule_uuid, r.rule_type, r.count, r.start_time, r.interval_hours, r.duration_days, r.extras,
                ISNULL(c_today.completed_today, 0) AS completedOccurrences,
                ISNULL(c_total.total_days_completed, 0) AS totalDaysCompleted
            FROM medication_tasks mt
            LEFT JOIN medication_task_rules r ON mt.med_task_uuid = r.med_task_uuid
            LEFT JOIN (
                SELECT parent_task_uuid, COUNT(*) AS completed_today
                FROM task_completions
                WHERE task_type = 'medication' AND CAST(completed_at AS DATE) = CAST(GETDATE() AS DATE)
                GROUP BY parent_task_uuid
            ) c_today ON mt.med_task_uuid = c_today.parent_task_uuid
            LEFT JOIN (
                SELECT parent_task_uuid, COUNT(DISTINCT CAST(completed_at AS DATE)) AS total_days_completed
                FROM task_completions
                WHERE task_type = 'medication'
                GROUP BY parent_task_uuid
            ) c_total ON mt.med_task_uuid = c_total.parent_task_uuid
            WHERE 
                mt.assignee_uuid = @user_uuid
                AND mt.status NOT IN ('deleted', 'completed')
            ORDER BY mt.start_date, mt.created_at DESC;
        `;
        const result = await reqDb.query(query);
        res.status(200).json({ success: true, data: result.recordset });
    } catch (err) {
        console.error('Error fetching medication tasks:', err);
        res.status(500).json({ success: false, message: 'Server error while fetching medication tasks.' });
    }
});

// --- Create a New Medication Task ---
router.post('/', async (req, res) => {
    // ⭐ MODIFIED: Expecting assignee_uuid and actor_uuid
    let { medication_id, name, description, priority = 2, status = 'active', valid_until, start_date, assignee_uuid, rules, actor_uuid } = req.body;
    if (!medication_id || !name || !assignee_uuid || !rules || !Array.isArray(rules) || !actor_uuid) {
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
        if (assignee_uuid !== actor.user_uuid && actor.Role !== 3) {
            await transaction.rollback();
            return res.status(403).json({ success: false, message: 'Only doctors can assign medications to others.' });
        }
        const medReq = transaction.request();
        medReq.input('medication_id', sql.Int, medication_id); // This might still be an external integer ID
        medReq.input('name', sql.NVarChar, name);
        medReq.input('description', sql.NVarChar, description || '');
        medReq.input('priority', sql.SmallInt, priority);
        medReq.input('status', sql.NVarChar, status);
        medReq.input('valid_until', sql.Date, valid_until || null);
        medReq.input('start_date', sql.Date, start_date || null);
        medReq.input('assignee_uuid', sql.UniqueIdentifier, assignee_uuid);

        const insertRes = await medReq.query(`
            INSERT INTO medication_tasks (medication_id, name, description, priority, status, valid_until, start_date, assignee_uuid)
            OUTPUT INSERTED.med_task_uuid
            VALUES (@medication_id, @name, @description, @priority, @status, @valid_until, @start_date, @assignee_uuid);
        `);
        const newMedTaskUuid = insertRes.recordset[0].med_task_uuid;

        for (const r of rules) {
            const rReq = transaction.request();
            rReq.input('med_task_uuid', sql.UniqueIdentifier, newMedTaskUuid); // Use new UUID
            rReq.input('rule_type', sql.NVarChar, r.rule_type);
            rReq.input('count', sql.Int, r.count || null);
            const startTime = r.start_time ? new Date(`1970-01-01T${r.start_time}`) : null;
            rReq.input('start_time', sql.Time, startTime);
            rReq.input('interval_hours', sql.Int, r.interval_hours || null);
            rReq.input('duration_days', sql.Int, r.duration_days || null);
            const extrasString = (typeof r.extras === 'string') ? r.extras : JSON.stringify(r.extras);
            rReq.input('extras', sql.NVarChar, r.extras ? extrasString : null);
            await rReq.query(`INSERT INTO medication_task_rules (med_task_uuid, rule_type, count, start_time, interval_hours, duration_days, extras) VALUES (@med_task_uuid, @rule_type, @count, @start_time, @interval_hours, @duration_days, @extras)`);
        }
        await transaction.commit();
        res.status(201).json({ success: true, message: 'Medication task added successfully!', medTaskUuid: newMedTaskUuid });
    } catch (err) {
        if (transaction.rolledBack === false) {
            await transaction.rollback();
        }
        console.error('Error creating medication task:', err);
        res.status(500).json({ success: false, message: 'Server error while adding medication task.' });
    }
});

// --- Update a Medication Task ---
router.patch('/:med_task_uuid', async (req, res) => {
    // ⭐ MODIFIED: Expecting med_task_uuid in URL
    const { med_task_uuid } = req.params;
    const { name, description, priority, status, valid_until, start_date, actor_uuid } = req.body;
    if (!actor_uuid) return res.status(400).json({ success: false, message: 'Actor UUID is required.' });

    const transaction = new sql.Transaction(pool);
    try {
        await poolConnect;
        await transaction.begin();
        const actor = await getUser(actor_uuid);
        const medTask = await getMedTask(med_task_uuid);

        if (!actor || !medTask) {
            await transaction.rollback();
            return res.status(404).json({ success: false, message: 'Actor or medication task not found.' });
        }
        if (!canModifyMed(actor, medTask.assignee_uuid)) {
            await transaction.rollback();
            return res.status(403).json({ success: false, message: 'Permission denied.' });
        }

        const updateFields = [];
        const medReq = transaction.request();
        medReq.input('med_task_uuid', sql.UniqueIdentifier, med_task_uuid);
        if (name) { updateFields.push('name = @name'); medReq.input('name', sql.NVarChar, name); }
        if (description) { updateFields.push('description = @description'); medReq.input('description', sql.NVarChar, description); }
        if (priority) { updateFields.push('priority = @priority'); medReq.input('priority', sql.SmallInt, priority); }
        if (status) { updateFields.push('status = @status'); medReq.input('status', sql.NVarChar, status); }
        if (valid_until) { updateFields.push('valid_until = @valid_until'); medReq.input('valid_until', sql.Date, valid_until); }
        if (start_date) { updateFields.push('start_date = @start_date'); medReq.input('start_date', sql.Date, start_date); }

        if (updateFields.length > 0) {
            await medReq.query(`
                UPDATE medication_tasks
                SET ${updateFields.join(', ')}, updated_at = GETDATE()
                WHERE med_task_uuid = @med_task_uuid
            `);
        }
        if (rules && Array.isArray(rules) && rules.length > 0) {
            // First, delete the old rule
            const deleteReq = transaction.request();
            deleteReq.input('med_task_uuid', sql.UniqueIdentifier, med_task_uuid);
            await deleteReq.query(`DELETE FROM medication_task_rules WHERE med_task_uuid = @med_task_uuid`);

            // Then, insert the new rule
            const newRule = rules[0];
            const rReq = transaction.request();
            rReq.input('med_task_uuid', sql.UniqueIdentifier, med_task_uuid);
            rReq.input('rule_type', sql.NVarChar, newRule.rule_type);
            rReq.input('count', sql.Int, newRule.count || null);
            const startTime = newRule.start_time ? new Date(`1970-01-01T${newRule.start_time}`) : null;
            rReq.input('start_time', sql.Time, startTime);
            rReq.input('interval_hours', sql.Int, newRule.interval_hours || null);
            rReq.input('duration_days', sql.Int, newRule.duration_days || null);
            const extrasString = (typeof newRule.extras === 'string') ? newRule.extras : JSON.stringify(newRule.extras);
            rReq.input('extras', sql.NVarChar, newRule.extras ? extrasString : null);
            await rReq.query(`INSERT INTO medication_task_rules (med_task_uuid, rule_type, count, start_time, interval_hours, duration_days, extras) VALUES (@med_task_uuid, @rule_type, @count, @start_time, @interval_hours, @duration_days, @extras)`);
        }

        await transaction.commit();
        res.status(200).json({ success: true, message: 'Medication task updated successfully!' });
    } catch (err) {
        if (transaction.rolledBack === false) {
            await transaction.rollback();
        }
        console.error('Error updating medication task:', err);
        res.status(500).json({ success: false, message: 'Server error while updating medication task.' });
    }
});

// --- Delete a Medication Task ---
router.delete('/:med_task_uuid', async (req, res) => {
    // ⭐ MODIFIED: Expecting med_task_uuid in URL
    const { med_task_uuid } = req.params;
    const { actor_uuid } = req.body;
    if (!actor_uuid) return res.status(400).json({ success: false, message: 'Actor UUID is required.' });

    try {
        await poolConnect;
        const actor = await getUser(actor_uuid);
        const medTask = await getMedTask(med_task_uuid);
        if (!actor || !medTask) {
            return res.status(404).json({ success: false, message: 'Actor or medication task not found.' });
        }
        if (!canModifyMed(actor, medTask.assignee_uuid)) {
            return res.status(403).json({ success: false, message: 'Permission denied.' });
        }

        const reqDb = pool.request();
        reqDb.input('med_task_uuid', sql.UniqueIdentifier, med_task_uuid);
        const result = await reqDb.query(`UPDATE medication_tasks SET status = 'deleted', updated_at = GETDATE() WHERE med_task_uuid = @med_task_uuid`);
        if (result.rowsAffected[0] === 0) return res.status(404).json({ success: false, message: 'Medication task not found.' });

        res.status(200).json({ success: true, message: 'Medication task marked as deleted successfully.' });
    } catch (err) {
        console.error('Error deleting medication task:', err);
        res.status(500).json({ success: false, message: 'Server error while deleting medication task.' });
    }
});
// --- Update a Medication Task's Status ---
router.patch('/:med_task_uuid/status', async (req, res) => {
    const { med_task_uuid } = req.params;
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
        const medTask = await getMedTask(med_task_uuid);

        // --- Authorization ---
        if (!actor || !medTask) {
            return res.status(404).json({ success: false, message: 'Actor or medication task not found.' });
        }
        if (!canModifyMed(actor, medTask.assignee_uuid)) {
            return res.status(403).json({ success: false, message: 'Permission denied.' });
        }

        // --- Database Update ---
        const reqDb = pool.request();
        reqDb.input('med_task_uuid', sql.UniqueIdentifier, med_task_uuid);
        reqDb.input('status', sql.NVarChar, status);

        const result = await reqDb.query(`
            UPDATE medication_tasks 
            SET status = @status
            WHERE med_task_uuid = @med_task_uuid
        `);

        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ success: false, message: 'Medication task not found for status update.' });
        }

        res.status(200).json({ success: true, message: 'Medication task status updated successfully.' });

    } catch (err) {
        console.error('Error updating medication task status:', err);
        res.status(500).json({ success: false, message: 'Server error while updating status.' });
    }
});

module.exports = router;