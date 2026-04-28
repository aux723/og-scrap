/**
 * Get current Nigerian time (UTC+1)
 * Uses the IANA timezone database for accurate time conversion
 * @returns {Date} Current time in Nigerian timezone
 */
function getNigerianTime() {
  return new Date(new Date().toLocaleString('en-US', {
    timeZone: 'Africa/Lagos'
  }));
}

/**
 * Format the current Nigerian time into a readable string
 * @returns {string} Formatted date string like "Monday, 8 October 2025, 14:30:45"
 */
function formatNigerianTime() {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                 'July', 'August', 'September', 'October', 'November', 'December'];

  const now = getNigerianTime();
  const day = days[now.getDay()];
  const date = now.getDate();
  const month = months[now.getMonth()];
  const year = now.getFullYear();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');

  return `${day}, ${date} ${month} ${year}, ${hours}:${minutes}:${seconds}`;
}

/**
 * Get current Lagos time in a specific format
 * @returns {string} Formatted date-time string in en-US format
 */
function getCurrentLagosTime() {
  return new Date().toLocaleString("en-US", {
    timeZone: "Africa/Lagos",
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

/**
 * Format the current date for database storage
 * @returns {string} Formatted date string in British format (e.g., "15th October 2025")
 */
function formatDateForDB() {
  const now = getNigerianTime(); // Reusing your existing helper for consistency

  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                 'July', 'August', 'September', 'October', 'November', 'December'];

  const dayName = days[now.getDay()];
  const dayOfMonth = now.getDate();
  const monthName = months[now.getMonth()];
  const year = now.getFullYear();

  // Logic for ordinal suffixes (1st, 2nd, 3rd, 4th...)
  const getOrdinal = (n) => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  return `${dayName} ${getOrdinal(dayOfMonth)} ${monthName}, ${year}`;
}

/**
 * Check if a job deadline is still valid
 * @param {string} deadline - The job deadline date string
 * @returns {boolean} True if deadline is valid or not specified
 */
function isJobDeadlineValid(deadline) {
  if (deadline === "Not specified") {
    return true; // Include jobs with no specified deadline
  }
  const jobDate = new Date(deadline);
  const now = new Date();
  return jobDate > now;
}

module.exports = {
  getNigerianTime,
  formatNigerianTime,
  getCurrentLagosTime,
  formatDateForDB,
  isJobDeadlineValid
};
