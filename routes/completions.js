// server/routes/completions.js
const express = require('express');
const sql = require('mssql');
const router = express.Router();
const config = require('../config/config');

const pool = new sql.ConnectionPool(config);
const poolConnect = pool.connect();

// POST /api/completions - Marks a task as done for today
router.post('/', async (req, res) => {
    const { task_type, parent_task_uuid } = req.body;
    if (!task_type || !parent_task_uuid) {
        return res.status(400).json({ success: false, message: 'task_type and parent_task_uuid are required.' });
    }
    try {
        await poolConnect;
        const request = pool.request();
        request.input('task_type', sql.NVarChar, task_type);
        request.input('parent_task_uuid', sql.UniqueIdentifier, parent_task_uuid);

        const result = await request.query(`
            INSERT INTO task_completions (task_type, parent_task_uuid)
            OUTPUT INSERTED.completion_uuid
            VALUES (@task_type, @parent_task_uuid);
        `);

        const newCompletionUuid = result.recordset[0].completion_uuid;

        res.status(201).json({ 
            success: true, 
            message: 'Task marked as complete.',
            completion_uuid: newCompletionUuid 
        });
    } catch (err) {
        console.error('Error marking task complete:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// DELETE /api/completions/undo - Removes the most recent completion for a task for today
router.delete('/undo', async (req, res) => {
    const { task_type, parent_task_uuid } = req.body;
    if (!task_type || !parent_task_uuid) {
        return res.status(400).json({ success: false, message: 'task_type and parent_task_uuid are required.' });
    }
    try {
        await poolConnect;
        const request = pool.request();
        request.input('task_type', sql.NVarChar, task_type);
        request.input('parent_task_uuid', sql.UniqueIdentifier, parent_task_uuid);

        const result = await request.query(`
            WITH LatestCompletion AS (
                SELECT TOP 1 completion_id
                FROM task_completions
                WHERE 
                    task_type = @task_type 
                    AND parent_task_uuid = @parent_task_uuid
                    AND CAST(completed_at AS DATE) = CAST(GETDATE() AS DATE)
                ORDER BY completed_at DESC
            )
            DELETE FROM task_completions
            WHERE completion_id IN (SELECT completion_id FROM LatestCompletion);
        `);

        if (result.rowsAffected[0] > 0) {
            res.status(200).json({ success: true, message: 'Last completion for today undone.' });
        } else {
            res.status(404).json({ success: false, message: 'No completion to undo for today.' });
        }
    } catch (err) {
        console.error('Error undoing task completion:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
