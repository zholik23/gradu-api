// utils/ruleHandlers.js
const { parseExtras, formatTime } = require('./taskSchedulerUtils');

function handleOnce(rule, now) {
    if (!rule.start_time) return false;
    const taskTime = formatTime(rule.start_time);
    return taskTime === formatTime(now);
}

function handleNTimes(rule, now) {
    const extras = parseExtras(rule.extras);
    if (extras.strict_times && extras.strict_times.length > 0) {
        return extras.strict_times.includes(formatTime(now));
    }
    if (rule.start_time && rule.interval_hours && rule.count) {
        const start = new Date();
        start.setHours(rule.start_time.getHours(), rule.start_time.getMinutes(), 0, 0);
        const diffHours = Math.floor((now - start) / (1000 * 60 * 60));
        return diffHours >= 0 && diffHours % rule.interval_hours === 0 && diffHours / rule.interval_hours < rule.count;
    }
    return false;
}

function handleInterval(rule, now) {
    if (!rule.start_time || !rule.interval_hours) return false;
    const start = new Date();
    start.setHours(rule.start_time.getHours(), rule.start_time.getMinutes(), 0, 0);
    const diffHours = Math.floor((now - start) / (1000 * 60 * 60));
    return diffHours >= 0 && diffHours % rule.interval_hours === 0;
}

function handleMealBased(rule, now, getMealTimes) {
    const extras = parseExtras(rule.extras);
    if (!extras.meals || !extras.relation) return false;
    const mealTimes = getMealTimes(rule.assignee_id); // dynamic user meals
    return extras.meals.some(meal => isTimeMatch(mealTimes[meal], now));
}

function handleBedtime(rule, now) {
    const extras = parseExtras(rule.extras);
    const bedtime = extras.bedtime_time || "22:00";
    return formatTime(now) === bedtime;
}

function handleDuration(rule, now) {
    const extras = parseExtras(rule.extras);
    if (!rule.duration_days || !extras.strict_times) return false;
    const created = new Date(rule.created_at);
    const endDate = new Date(created);
    endDate.setDate(created.getDate() + rule.duration_days);
    if (now > endDate) return false;
    return extras.strict_times.includes(formatTime(now));
}

module.exports = {
    handleOnce,
    handleNTimes,
    handleInterval,
    handleMealBased,
    handleBedtime,
    handleDuration
};