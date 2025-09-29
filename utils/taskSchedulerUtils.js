// utils/taskSchedulerUtils.js
/**
 * Parse extras JSON safely
 */
function parseExtras(extras) {
    if (!extras) return {};
    try {
        return typeof extras === 'string' ? JSON.parse(extras) : extras;
    } catch (e) {
        console.error('Invalid extras JSON:', extras);
        return {};
    }
}

/**
 * Convert Date to HH:MM string
 */
function formatTime(date) {
    return date.toTimeString().slice(0, 5);
}

/**
 * Add hours to a Date object
 */
function addHours(date, hours) {
    const newDate = new Date(date);
    newDate.setHours(newDate.getHours() + hours);
    return newDate;
}

/**
 * Check if a given time string matches now
 */
function isTimeMatch(timeStr, now) {
    return timeStr === formatTime(now);
}

module.exports = { parseExtras, formatTime, addHours, isTimeMatch };