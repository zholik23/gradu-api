// notificationScheduler.js
const schedule = require('node-schedule');
const sql = require('mssql');
const express = require('express');
const admin = require('firebase-admin');
const config = require('../config/config');
const router = express.Router();


const ruleHandlers = require('../utils/ruleHandlers.js');
const { formatTime } = require('../utils/taskSchedulerUtils.js');

// Fetch meal times for user
async function getMealTimes(userId) {
    // TODO: Replace with DB query to fetch user meal schedule
    return { breakfast: "08:00", lunch: "13:00", dinner: "19:00" };
}

// Determine if a task needs notification
async function shouldNotify(task, now) {
    const handlers = ruleHandlers;
    switch (task.rule_type) {
        case 'once': return handlers.handleOnce(task, now);
        case 'n_times': return handlers.handleNTimes(task, now);
        case 'interval': return handlers.handleInterval(task, now);
        case 'meal_based': return handlers.handleMealBased(task, now, getMealTimes);
        case 'bedtime': return handlers.handleBedtime(task, now);
        case 'duration': return handlers.handleDuration(task, now);
        default: return false;
    }
}

const scheduleNotifications = () => {
    schedule.scheduleJob('*/1 * * * *', async () => {
        console.log(`[${new Date().toISOString()}] Checking scheduled task notifications...`);
        let pool;
        try {
            pool = await sql.connect(config);
            const now = new Date();

            const query = `
                SELECT t.task_id, t.name AS task_name, t.assignee_id, t.status, t.created_at,
                       r.rule_id, r.rule_type, r.count, r.start_time, r.interval_hours, r.duration_days, r.extras,
                       u.FCMToken
                FROM task_test t
                JOIN task_rules_test r ON t.task_id = r.task_id
                JOIN Users u ON t.assignee_id = u.UserID
                WHERE t.status = 'active'
                  AND (t.valid_until IS NULL OR t.valid_until >= GETDATE())
                  AND u.FCMToken IS NOT NULL AND u.FCMToken <> ''
            `;

            const result = await pool.request().query(query);

            for (const task of result.recordset) {
                if (await shouldNotify(task, now)) {
                    const message = {
                        notification: {
                            title: `Task Reminder: ${task.task_name}`,
                            body: `You have a scheduled task: "${task.task_name}"`,
                        },
                        token: task.FCMToken,
                    };
                    try {
                        await admin.messaging().send(message);
                        console.log(`Notification sent to user ${task.assignee_id} for task ${task.task_name}`);
                    } catch (error) {
                        console.error('Error sending notification:', error);
                    }
                }
            }
        } catch (err) {
            console.error('Error running task notification scheduler:', err);
        } finally {
            if (pool) pool.close();
        }
    });
};

module.exports = router;
