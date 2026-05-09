/**
 * Extract deadline from text content
 * Returns: string - formatted deadline, "expired deadline", or "Rolling"
 */

function extractDeadlineData(text) {
    if (!text || typeof text !== 'string') {
        return "Rolling";
    }

    // Current date for comparison
    const currentDate = new Date();

    // Define month mapping for parsing
    const months = {
        'january': 0, 'jan': 0,
        'february': 1, 'feb': 1,
        'march': 2, 'mar': 2,
        'april': 3, 'apr': 3,
        'may': 4,
        'june': 5, 'jun': 5,
        'july': 6, 'jul': 6,
        'august': 7, 'aug': 7,
        'september': 8, 'sep': 8, 'sept': 8,
        'october': 9, 'oct': 9,
        'november': 10, 'nov': 10,
        'december': 11, 'dec': 11
    };

    // Pattern 1: Full date format: Month DD, YYYY (e.g., "May 31, 2026" or "December 19, 2025")
    const fullDatePattern = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\b/gi;

    // Pattern 2: Month and day only: Month DD (e.g., "May 18" or "December 22")
    const monthDayPattern = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})\b(?!,?\s+\d{4})/gi;

    let foundDates = [];

    // Extract full dates (Month DD, YYYY)
    let fullDateMatch;
    while ((fullDateMatch = fullDatePattern.exec(text)) !== null) {
        const monthName = fullDateMatch[1].toLowerCase();
        const day = parseInt(fullDateMatch[2], 10);
        const year = parseInt(fullDateMatch[3], 10);

        // Validate day range (1-31)
        if (day >= 1 && day <= 31) {
            const month = months[monthName];
            if (month !== undefined) {
                const dateObj = new Date(year, month, day);
                // Check if date is valid
                if (dateObj.getMonth() === month && dateObj.getDate() === day) {
                    foundDates.push({
                        date: dateObj,
                        original: fullDateMatch[0],
                        formatted: formatDate(dateObj)
                    });
                }
            }
        }
    }

    // Extract month-day only (for recurring or unspecified year)
    let monthDayMatch;
    while ((monthDayMatch = monthDayPattern.exec(text)) !== null) {
        const monthName = monthDayMatch[1].toLowerCase();
        const day = parseInt(monthDayMatch[2], 10);

        // Validate day range (1-31)
        if (day >= 1 && day <= 31) {
            const month = months[monthName];
            if (month !== undefined) {
                // Assume current year, but if that date has passed, use next year
                let year = currentDate.getFullYear();
                let dateObj = new Date(year, month, day);

                // If this year's date has passed, use next year
                if (dateObj < currentDate) {
                    dateObj = new Date(year + 1, month, day);
                }

                foundDates.push({
                    date: dateObj,
                    original: monthDayMatch[0],
                    formatted: formatDate(dateObj)
                });
            }
        }
    }

    // If no dates found at all
    if (foundDates.length === 0) {
        return "Rolling";
    }

    // Sort by date (earliest to latest)
    foundDates.sort((a, b) => a.date - b.date);

    // Get the earliest future date
    const futureDates = foundDates.filter(d => d.date >= currentDate);

    if (futureDates.length === 0) {
        return "expired deadline";
    }

    // Return the earliest future deadline
    return futureDates[0].formatted;
}

// Helper function to format date consistently
function formatDate(date) {
    const options = { year: 'numeric', month: 'long', day: 'numeric' };
    return date.toLocaleDateString('en-US', options);
}

module.exports = { extractDeadlineData };