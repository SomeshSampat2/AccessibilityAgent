export const WEB_RULES = `
Predefined accessibility rules for Web:
1) Prefer semantic HTML elements; only use ARIA when semantics are missing.
2) All interactive elements must be keyboard accessible and have visible focus.
3) Headings must follow a logical structure; titles should announce as headings.
4) Images require meaningful alt text unless purely decorative (then use empty alt or aria-hidden).
5) Associate labels with form controls using <label for> or aria-label/aria-labelledby.
6) Manage focus on dialogs and dynamic content updates.
7) Provide literal strings for labels/alt in the example output; do not reference external resource files.`;


