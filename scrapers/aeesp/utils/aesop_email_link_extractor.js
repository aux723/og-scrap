/**
 * Generic extractor that handles:
 * - Emails in any position
 * - URLs in any position
 * - Multiple emails/URLs (returns first of each)
 * - Trailing punctuation
 * - Line breaks and spaces
 */

function extractContactInfo(text) {
    if (!text || typeof text !== 'string') {
        return { email: null, link: null };
    }

    let email = null;
    let link = null;

    // Email pattern - matches standard email formats
    const emailPattern = /[a-zA-Z0-9][a-zA-Z0-9._%+-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}/;
    const emailResult = text.match(emailPattern);
    if (emailResult) {
        email = emailResult[0];
    }

    // URL pattern - matches http:// or https:// URLs
    // Stops at whitespace, end of string, or common URL-terminating characters
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+/;
    const urlResult = text.match(urlPattern);

    if (urlResult) {
        let rawUrl = urlResult[0];
        // Remove trailing punctuation that might be part of the sentence, not the URL
        // But preserve valid URL characters like / . ? = & -
        rawUrl = rawUrl.replace(/[.,;:!?'"()<>\[\]{}]+$/, '');

        // Basic validation
        if (rawUrl.startsWith('http') && rawUrl.length > 10) {
            link = rawUrl;
        }
    }

    // Edge case: Some texts might have URLs without protocol (www.example.com)
    // But since most modern sites use https, this is optional
    if (!link) {
        const noProtocolUrl = text.match(/www\.[^\s<>"{}|\\^`[\]]+\.[a-zA-Z]{2,}[^\s]*/);
        if (noProtocolUrl) {
            let rawUrl = noProtocolUrl[0];
            rawUrl = rawUrl.replace(/[.,;:!?'"()<>\[\]{}]+$/, '');
            if (rawUrl.length > 5) {
                link = 'https://' + rawUrl;
            }
        }
    }

    return { email, link };
}

module.exports = { extractContactInfo };