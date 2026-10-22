function normalizeSubmittedUrl(value = '') {
    const candidate = String(value || '').trim();
    if (!/^https?:\/\//i.test(candidate)) return null;

    // Browsers and official CMS links occasionally expose literal spaces in a
    // path. Encode only those spaces: encodeURI() would re-encode valid %XX
    // query parameters used by document-viewer URLs.
    try {
        const encoded = candidate.replace(/ /g, '%20');
        // Validate without rewriting valid submitted URL formatting.
        new URL(encoded);
        return encoded;
    } catch (_) {
        return null;
    }
}

function stripTrailingUrlWrapper(value = '') {
    let candidate = String(value || '').trim();

    // A URL copied from Markdown commonly ends in the closing `)` of the
    // link wrapper. Keep parentheses that are actually part of the URL.
    while (candidate.endsWith(')')) {
        const opens = (candidate.match(/\(/g) || []).length;
        const closes = (candidate.match(/\)/g) || []).length;
        if (closes <= opens) break;
        candidate = candidate.slice(0, -1);
    }

    return candidate.replace(/[.,;:!?]+$/, '');
}

function collectHttpUrlCandidates(rawInput = '') {
    const source = String(rawInput || '');
    const candidates = [];
    const markdownLinkRanges = [];
    const markdownLinkPattern = /\]\(\s*(https?:\/\/[^\s<>"')]+)\s*\)/gi;
    let markdownMatch;

    // Extract Markdown destinations first so their labels and closing wrapper
    // never become part of the URL being validated.
    while ((markdownMatch = markdownLinkPattern.exec(source))) {
        const raw = stripTrailingUrlWrapper(markdownMatch[1]);
        // The label can itself be the URL. Mark the destination at the end of
        // the Markdown match so it is not parsed a second time below.
        const urlOffset = markdownMatch[0].lastIndexOf(markdownMatch[1]);
        const start = markdownMatch.index + Math.max(0, urlOffset);
        candidates.push({ start, raw });
        const linkStart = source.lastIndexOf('[', markdownMatch.index);
        markdownLinkRanges.push({
            start: linkStart >= 0 ? linkStart : markdownMatch.index,
            end: markdownMatch.index + markdownMatch[0].length
        });
    }

    const isInsideMarkdownLink = (position) => markdownLinkRanges.some(range => (
        position >= range.start && position < range.end
    ));

    let offset = 0;
    for (const line of source.split(/\r?\n/)) {
        const lineStart = offset;
        const lineHasMarkdownDestination = markdownLinkRanges.some(range => (
            range.start >= lineStart && range.start < lineStart + line.length
        ));
        const allStarts = [...line.matchAll(/https?:\/\//gi)]
            .map(match => match.index)
            .filter(index => !isInsideMarkdownLink(lineStart + index));
        const starts = allStarts.filter((start, index) => {
            if (index === 0) return true;
            const previousStart = allStarts[index - 1];
            const betweenProtocols = line.slice(previousStart, start);

            // Official redirect/share URLs sometimes carry an unencoded URL as
            // a query value (`?url=https://...`). That inner protocol belongs
            // to the same submitted URL, not to a second input row. Restrict
            // this to a preceding HTTP URL and a contiguous query assignment
            // so two normal URLs on one line remain separate candidates.
            const isNestedQueryUrl = !/[\s,]/.test(betweenProtocols)
                && /[?&][^=?&\s]+=$/.test(betweenProtocols);
            const isNestedFragmentUrl = !/[\s,]/.test(betweenProtocols)
                && /#[^#\s]*(?:=|:)[^#\s]*$/.test(betweenProtocols);
            return !(isNestedQueryUrl || isNestedFragmentUrl);
        });

        starts.forEach((start, index) => {
            const before = line.slice(0, start).trim();
            const nextStart = starts[index + 1];
            let raw;

            // Retain the legacy support for official paths containing literal
            // spaces when the line is a single plain URL. Otherwise, a token
            // boundary prevents surrounding prose from being absorbed.
            if (!lineHasMarkdownDestination && starts.length === 1 && !before) {
                raw = line.slice(start);
            } else {
                raw = line.slice(start, nextStart).match(/^https?:\/\/[^\s<>"']*/i)?.[0] || '';
            }

            candidates.push({ start: lineStart + start, raw: stripTrailingUrlWrapper(raw) });
        });

        const nextOffset = offset + line.length;
        const lineBreakLength = source.startsWith('\r\n', nextOffset)
            ? 2
            : (source.startsWith('\n', nextOffset) ? 1 : 0);
        offset = nextOffset + lineBreakLength;
    }

    return candidates
        .filter(candidate => candidate.raw)
        .sort((a, b) => a.start - b.start);
}

function extractSubmittedUrlCandidates(rawInput = '') {
    return collectHttpUrlCandidates(rawInput)
        .map(candidate => candidate.raw);
}

function parseSubmittedUrlEntries(rawInput = '') {
    const source = String(rawInput || '');
    const candidates = collectHttpUrlCandidates(source);
    let offset = 0;

    // The manifest is an audit record, not a best-effort URL list. A non-empty
    // submitted line with no HTTP candidate must remain visible as a skipped row
    // instead of disappearing before the mission is created.
    for (const line of source.split(/\r?\n/)) {
        const raw = line.trim();
        const lineEnd = offset + line.length;
        const hasHttpCandidate = candidates.some(candidate => (
            candidate.start >= offset && candidate.start <= lineEnd
        ));
        if (raw && !hasHttpCandidate) {
            candidates.push({ start: offset, raw, unrecognized: true });
        }
        const nextOffset = offset + line.length;
        const lineBreakLength = source.startsWith('\r\n', nextOffset)
            ? 2
            : (source.startsWith('\n', nextOffset) ? 1 : 0);
        offset = nextOffset + lineBreakLength;
    }

    return candidates
        .sort((left, right) => left.start - right.start)
        .map((candidate, index) => {
        const raw = candidate.raw;
        const url = normalizeSubmittedUrl(raw);
        return {
            inputIndex: index + 1,
            raw,
            url,
            reason: url
                ? null
                : (candidate.unrecognized
                    ? 'No http:// or https:// URL was recognised on this submitted line; it was not navigated.'
                    : 'Invalid URL syntax; it was not navigated.')
        };
    });
}

function normalizeSubmittedUrlEntries(urls = []) {
    return (Array.isArray(urls) ? urls : []).map((value, index) => {
        const raw = String(value || '').trim();
        const url = normalizeSubmittedUrl(raw);
        return {
            inputIndex: index + 1,
            raw,
            url,
            reason: url ? null : 'Invalid URL syntax; it was not navigated.'
        };
    });
}

function parseSubmittedUrls(rawInput = '') {
    return parseSubmittedUrlEntries(rawInput)
        .map(entry => entry.url)
        .filter(Boolean);
}

function normalizeSubmittedUrls(urls = []) {
    return normalizeSubmittedUrlEntries(urls)
        .map(entry => entry.url)
        .filter(Boolean);
}

module.exports = {
    normalizeSubmittedUrl,
    extractSubmittedUrlCandidates,
    normalizeSubmittedUrls,
    normalizeSubmittedUrlEntries,
    parseSubmittedUrls,
    parseSubmittedUrlEntries
};
