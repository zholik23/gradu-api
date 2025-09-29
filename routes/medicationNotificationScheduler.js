// medicationNotificationScheduler.js
const schedule = require('node-schedule');
const express = require('express');
const sql = require('mssql');
const admin = require('firebase-admin');
const config = require('../config/config');
const router = express.Router();

const ruleHandlers = require('../utils/ruleHandlers.js');
const { formatTime } = require('../utils/taskSchedulerUtils.js');

// Fetch user meal times (same as tasks)
async function getMealTimes(userId) {
    // TODO: Replace with actual DB fetch
    return { breakfast: "08:00", lunch: "13:00", dinner: "19:00" };
}

// Determine if a medication task should notify
async function shouldNotifyMedication(task, now) {
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

// Schedule FCM notifications
const scheduleMedicationNotifications = () => {
    schedule.scheduleJob('*/1 * * * *', async () => {
        console.log(`[${new Date().toISOString()}] Checking medication notifications...`);
        let pool;
        try {
            pool = await sql.connect(config);
            const now = new Date();

            const query = `
                SELECT mt.med_task_id, mt.medication_id, mt.name, mt.assignee_id, u.FCMToken,
                       r.rule_id, r.rule_type, r.count, r.start_time, r.interval_hours, r.duration_days, r.extras,
                       mt.created_at
                FROM medication_tasks mt
                JOIN medication_task_rules r ON mt.med_task_id = r.med_task_id
                JOIN Users u ON mt.assignee_id = u.UserID
                WHERE mt.status = 'active'
                  AND (mt.valid_until IS NULL OR mt.valid_until >= GETDATE())
                  AND u.FCMToken IS NOT NULL AND u.FCMToken <> ''
            `;

            const result = await pool.request().query(query);

            for (const med of result.recordset) {
                if (await shouldNotifyMedication(med, now)) {
                    const message = {
                        notification: {
                            title: `Medication Reminder: ${med.name}`,
                            body: `Time to take your medication: ${med.name}`,
                        },
                        token: med.FCMToken,
                    };
                    try {
                        await admin.messaging().send(message);
                        console.log(`Notification sent to user ${med.assignee_id} for medication ${med.name}`);
                    } catch (err) {
                        console.error('Error sending FCM notification:', err);
                    }
                }
            }
        } catch (err) {
            console.error('Error running medication notification scheduler:', err);
        } finally {
            if (pool) pool.close();
        }
    });
};

module.exports = router;
