/**
 * Extract ONE email and ONE link from post_body
 * Works whether body has only email, only link, or both
 */

function extractContactInfo(text) {
    if (!text) return { emails: [], links: [] };

    // 1. Email Regex
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

    // 2. Improved URL Regex
    // This looks for the start of a URL and captures until it hits a space or newline
    const urlRegex = /https?:\/\/[^\s\n\r]+/gi;

    const rawEmails = text.match(emailRegex) || [];
    const rawLinks = text.match(urlRegex) || [];

    // 3. Cleanup Phase: Strip "Required", punctuation, or trailing junk
    const cleanLinks = rawLinks.map(link => {
      return link
        .replace(/(Required|Optional|Apply|Details)$/i, '') // Remove specific trailing words
        .replace(/[.,;:]+$/, '')                            // Remove trailing punctuation
        .trim();
    }).filter(link => link.length > 10); // Filter out any broken fragments

    return {
      email: [...new Set(rawEmails)][0],
      link: [...new Set(cleanLinks)][0]
    };
  }

module.exports =  {extractContactInfo};