export const ANDROID_RULES = `
Predefined accessibility rules for Android:
1) Every clickable element must have an appropriate role (e.g., Button) and be reachable via TalkBack.
2) Every title or screen header should be announced as a heading.
3) Provide meaningful contentDescription for non-decorative images and actionable icons.
4) For Compose: use Semantics, roles, and contentDescription; ensure minimum touch target sizes.
5) For XML: use importantForAccessibility, focusable, labelFor where applicable; mark decorative images as not important for accessibility.
6) Do not reference strings from a resource file in the output; use the literal string needed for contentDescription/labels in the updated code sample.
7) Maintain existing behavior; do not change logic beyond adding accessibility improvements.`;


