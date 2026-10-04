// The Builder exports rich-text paragraphs as Markdown. Only these observed
// presentation differences are accepted; words, inline spacing and tags remain.
export const normalizePolicyParagraphs = text => text.replace(/\r\n/g, '\n').replace(/\n+/g, '\n').trim();
export const normalizeBuilderPolicy = text => normalizePolicyParagraphs(text.replace(/\\([_<*])/g, '$1'));
