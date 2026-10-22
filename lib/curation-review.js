const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { normalizeUrl } = require('./navigator');
const {
    reviewSourceId,
    buildReviewQualityProfiles,
    jaccardSimilarity
} = require('./review-quality');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const REVIEWS_DIR = path.join(DATA_DIR, 'reviews');

function safeMissionId(value = '') {
    const id = String(value || '').trim();
    if (!id || /(\.\.|[\\/])/.test(id)) return null;
    return id;
}

function combinedReviewId(missionIds = []) {
    const ids = (Array.isArray(missionIds) ? missionIds : [])
        .map(safeMissionId)
        .filter(Boolean);
    if (ids.length !== 2 || new Set(ids).size !== 2) return null;
    const digest = crypto.createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 24);
    return `combined_${digest}`;
}

function reviewPath(userId, batchId) {
    const safeId = safeMissionId(batchId);
    if (!safeId) return null;
    return path.join(REVIEWS_DIR, String(userId), `${safeId}.json`);
}

async function loadReviewState(userId, batchId) {
    const target = reviewPath(userId, batchId);
    if (!target || !(await fs.pathExists(target))) {
        return { version: 2, batchId: String(batchId || ''), revision: 0, groups: {} };
    }

    const state = await fs.readJson(target).catch(() => null);
    return {
        version: Number(state?.version || 1),
        batchId: String(batchId || ''),
        revision: Number(state?.revision || 0),
        groups: state && typeof state.groups === 'object' && state.groups ? state.groups : {}
    };
}

async function saveReviewState(userId, batchId, state) {
    const target = reviewPath(userId, batchId);
    if (!target) throw new Error('Invalid mission id');
    await fs.ensureDir(path.dirname(target));
    const tempTarget = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
        await fs.writeJson(tempTarget, {
            version: 2,
            batchId: String(batchId),
            revision: Number(state.revision || 0) + 1,
            updatedAt: new Date().toISOString(),
            groups: state.groups || {}
        }, { spaces: 2 });
        await fs.move(tempTarget, target, { overwrite: true });
    } catch (error) {
        await fs.remove(tempTarget).catch(() => {});
        throw error;
    }
}

function logicalHost(url = '') {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch (_) {
        return '';
    }
}

function reviewTitle(detail = {}) {
    const directTitle = String(detail.reviewTitle || detail.artifacts?.title || '').trim();
    if (directTitle) return directTitle;

    const files = detail.filesSaved || detail.artifacts?.files || {};
    const filename = files.txt || files.md || files.pdf || '';
    const baseName = path.basename(filename).replace(/\.(?:txt|md|pdf)$/i, '');
    const domain = detail.artifacts?.storageDomain || (() => {
        try { return new URL(detail.url || '').hostname.replace(/[^a-z0-9]/gi, '_'); } catch (_) { return ''; }
    })();
    const suffix = new RegExp(`_${domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_[a-f0-9]{16}$`, 'i');
    return baseName.replace(suffix, '').replace(/_+/g, ' ').trim();
}

function normalizeReviewTitle(value = '') {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[_\-]+/g, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function isSpecificReviewTitle(value = '') {
    const compact = normalizeReviewTitle(value);
    const words = compact.split(' ').filter(Boolean);
    return compact.length >= 20 && words.length >= 3 && !/^(?:home|homepage|contact|news|document|page|untitled)$/i.test(compact);
}

function savedDecisionForMember(saved = {}, member = {}) {
    const decisions = saved.decisions || {};
    const sourceId = reviewSourceId(member);
    return decisions[sourceId] ?? decisions[member.url] ?? decisions[normalizeUrl(member.url)] ?? 'undecided';
}

function canonicalRecommendation(members = [], profiles = new Map()) {
    return members
        .map((member, index) => ({
            sourceId: reviewSourceId(member),
            index,
            score: profiles.get(reviewSourceId(member))?.qualityScore || 0
        }))
        .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.sourceId || null;
}

function makeGroup(id, members, state, { matchType, confidence, reason, title = '', category = 'duplicate', profiles = new Map(), similarity = null }) {
    const saved = state.groups?.[id] || {};
    const sourceUrls = { ...(saved.sourceUrls || {}) };
    for (const member of members) sourceUrls[reviewSourceId(member)] = member.url || '';
    const distinctTitles = new Set(members.map(reviewTitle).map(normalizeReviewTitle).filter(Boolean));
    const highRiskMembers = members.filter(member => (
        profiles.get(reviewSourceId(member))?.signals?.some(signal => signal.severity === 'high')
    ));
    const qualityWarning = highRiskMembers.length > 0
        ? `${highRiskMembers.length}/${members.length} source(s) show a high-risk extraction-quality signal. Treat this as possible bad extraction, not proof of duplication.`
        : (matchType.startsWith('Exact') && members.length >= 3 && distinctTitles.size > 1
            ? 'Identical text appears under multiple titles. This often indicates a shared template or failed extraction; inspect before selecting a canonical source.'
            : '');
    return {
        id,
        category,
        matchType,
        confidence,
        reason,
        title,
        canonicalUrl: saved.canonicalUrl || null,
        canonicalSourceId: saved.canonicalSourceId || null,
        recommendedCanonicalSourceId: canonicalRecommendation(members, profiles),
        qualityWarning,
        similarity,
        members: members.map(detail => {
            const files = detail.filesSaved || detail.artifacts?.files || {};
            const sourceId = reviewSourceId(detail);
            const profile = profiles.get(sourceId) || null;
            return {
                sourceId,
                url: detail.url || '',
                title: reviewTitle(detail),
                level: detail.level ?? detail.lvl ?? detail.depth ?? '',
                inputIndex: detail.inputIndex ?? null,
                missionId: detail.reviewMissionId || detail.missionId || '',
                missionTimestamp: detail.reviewMissionTimestamp || '',
                missionOrder: detail.reviewMissionOrder ?? null,
                missionInputIndex: detail.reviewMissionInputIndex ?? detail.inputIndex ?? null,
                decision: savedDecisionForMember(saved, detail),
                domain: detail.artifacts?.storageDomain || (() => {
                    try { return new URL(detail.url).hostname.replace(/[^a-z0-9]/gi, '_'); } catch (_) { return ''; }
                })(),
                quality: profile ? {
                    semanticChars: profile.semanticChars,
                    words: profile.words,
                    sentences: profile.sentences,
                    uniqueChars: profile.uniqueChars,
                    boilerplateRatio: profile.boilerplateRatio,
                    qualityScore: profile.qualityScore,
                    pdfKind: profile.pdfKind,
                    signals: profile.signals
                } : null,
                sourceKind: detail.sourceKind || detail.artifacts?.sourceKind || null,
                sourceDetail: detail.sourceDetail || detail.artifacts?.sourceDetail || null,
                files: {
                    md: files.md || '',
                    txt: files.txt || '',
                    pdf: files.pdf || '',
                    json: files.json || ''
                }
            };
        }),
        sourceUrls
    };
}

function buildExactTextReviewGroups(details = [], state = { groups: {} }, profiles = buildReviewQualityProfiles(details)) {
    const grouped = new Map();
    for (const detail of details) {
        if (detail.status !== 'success' || !detail.contentFingerprint) continue;
        const group = grouped.get(detail.contentFingerprint) || [];
        group.push(detail);
        grouped.set(detail.contentFingerprint, group);
    }

    return Array.from(grouped.entries())
        .filter(([, members]) => members.length > 1)
        .map(([fingerprint, members]) => makeGroup(fingerprint, members, state, {
            matchType: 'Exact stored TXT after normalization',
            confidence: 'Review required',
            reason: 'The stored text is byte-for-byte equal after line-ending normalization. This is not proof that the original official sources are the same, so no artifact was suppressed.',
            profiles
        }))
        .sort((a, b) => b.members.length - a.members.length);
}

function buildTitleReviewGroups(details = [], state = { groups: {} }, exactGroups = [], profiles = buildReviewQualityProfiles(details)) {
    const exactMemberSourceIds = new Set(exactGroups.flatMap(group => group.members.map(member => member.sourceId)));
    const grouped = new Map();

    for (const detail of details) {
        if (detail.status !== 'success' || exactMemberSourceIds.has(reviewSourceId(detail))) continue;
        const title = reviewTitle(detail);
        if (!isSpecificReviewTitle(title)) continue;
        const host = logicalHost(detail.url);
        if (!host) continue;
        const key = `${host}\n${normalizeReviewTitle(title)}`;
        const group = grouped.get(key) || [];
        group.push(detail);
        grouped.set(key, group);
    }

    return Array.from(grouped.entries())
        .filter(([, members]) => members.length > 1)
        .map(([key, members]) => {
            const id = `title:${crypto.createHash('sha256').update(key).digest('hex')}`;
            return makeGroup(id, members, state, {
                matchType: 'Matching source title / filename',
                confidence: 'Title candidate - review required',
                title: reviewTitle(members[0]),
                reason: 'These sources share the same specific stored title or filename on the same logical host. Their document text may still differ, so no artifact was suppressed.',
                profiles
            });
        })
        .sort((a, b) => b.members.length - a.members.length || a.title.localeCompare(b.title));
}

function buildQualityAnomalyGroups(details = [], state = { groups: {} }, excludedSourceIds = new Set(), profiles = buildReviewQualityProfiles(details)) {
    const grouped = new Map();
    const priority = { high: 3, medium: 2, info: 1 };
    for (const detail of details) {
        const sourceId = reviewSourceId(detail);
        if (detail.status !== 'success' || excludedSourceIds.has(sourceId)) continue;
        const profile = profiles.get(sourceId);
        const signal = profile?.signals
            ?.filter(item => item.severity !== 'info')
            .sort((a, b) => (priority[b.severity] || 0) - (priority[a.severity] || 0))[0];
        if (!signal) continue;
        const key = `${profile.host}\n${signal.code}`;
        const entry = grouped.get(key) || { members: [], signal };
        entry.members.push(detail);
        grouped.set(key, entry);
    }

    return Array.from(grouped.entries()).map(([key, entry]) => {
        const id = `quality:${crypto.createHash('sha256').update(key).digest('hex')}`;
        return makeGroup(id, entry.members, state, {
            category: 'quality',
            matchType: `Quality anomaly: ${entry.signal.label}`,
            confidence: 'Manual corpus review required',
            reason: 'This is a quality signal, not a duplicate claim. Keep, mark irrelevant, or send the source to the re-scrape queue after inspecting its saved text.',
            title: entry.signal.label,
            profiles
        });
    }).sort((a, b) => b.members.length - a.members.length || a.title.localeCompare(b.title));
}

function hash32(value = '') {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function minhashSignature(shingles = new Set(), size = 6) {
    const minimums = new Array(size).fill(0xffffffff);
    for (const shingle of shingles) {
        const base = hash32(shingle);
        for (let index = 0; index < size; index++) {
            const mixed = (Math.imul(base ^ ((index + 1) * 0x9e3779b9), 0x85ebca6b) + (index * 0xc2b2ae35)) >>> 0;
            if (mixed < minimums[index]) minimums[index] = mixed;
        }
    }
    return minimums;
}

function minhashCandidatePairs(candidates = []) {
    const buckets = new Map();
    const pairs = new Set();
    candidates.forEach((candidate, candidateIndex) => {
        minhashSignature(candidate.profile.shingles).forEach((value, signatureIndex) => {
            const key = `${signatureIndex}:${value}`;
            const previous = buckets.get(key) || [];
            for (const previousIndex of previous) {
                const first = Math.min(previousIndex, candidateIndex);
                const second = Math.max(previousIndex, candidateIndex);
                pairs.add(`${first}:${second}`);
            }
            previous.push(candidateIndex);
            buckets.set(key, previous);
        });
    });
    return pairs;
}

function buildNearDuplicateReviewGroups(details = [], state = { groups: {} }, excludedSourceIds = new Set(), profiles = buildReviewQualityProfiles(details)) {
    const candidatesByHost = new Map();
    for (const detail of details) {
        const sourceId = reviewSourceId(detail);
        const profile = profiles.get(sourceId);
        if (detail.status !== 'success' || excludedSourceIds.has(sourceId) || !profile || profile.semanticChars < 500 || profile.shingles.size < 40) continue;
        const list = candidatesByHost.get(profile.host) || [];
        list.push({ detail, sourceId, profile });
        candidatesByHost.set(profile.host, list);
    }

    const groups = [];
    for (const candidates of candidatesByHost.values()) {
        const parent = candidates.map((_, index) => index);
        const similarities = new Map();
        const find = index => {
            while (parent[index] !== index) {
                parent[index] = parent[parent[index]];
                index = parent[index];
            }
            return index;
        };
        const union = (first, second) => {
            const rootA = find(first);
            const rootB = find(second);
            if (rootA !== rootB) parent[rootB] = rootA;
        };

        for (const pair of minhashCandidatePairs(candidates)) {
            const [first, second] = pair.split(':').map(Number);
            const similarity = jaccardSimilarity(candidates[first].profile.shingles, candidates[second].profile.shingles);
            if (similarity < 0.94) continue;
            similarities.set(pair, similarity);
            union(first, second);
        }

        const components = new Map();
        candidates.forEach((candidate, index) => {
            const root = find(index);
            const component = components.get(root) || [];
            component.push({ ...candidate, originalIndex: index });
            components.set(root, component);
        });

        for (const component of components.values()) {
            if (component.length < 2) continue;
            const sourceIds = component.map(item => item.sourceId).sort();
            const scores = [];
            for (let first = 0; first < component.length; first++) {
                for (let second = first + 1; second < component.length; second++) {
                    const keyA = `${component[first].originalIndex}:${component[second].originalIndex}`;
                    const keyB = `${component[second].originalIndex}:${component[first].originalIndex}`;
                    const score = similarities.get(keyA) ?? similarities.get(keyB);
                    if (score !== undefined) scores.push(score);
                }
            }
            const similarity = scores.length > 0 ? Math.min(...scores) : 0.94;
            const id = `near:${crypto.createHash('sha256').update(sourceIds.join('\n')).digest('hex')}`;
            groups.push(makeGroup(id, component.map(item => item.detail), state, {
                category: 'near_duplicate',
                matchType: 'Possible near-duplicate source text',
                confidence: `${Math.round(similarity * 100)}%+ similarity after shared boilerplate removal`,
                reason: 'The substantive text is highly similar, but it may represent another language, edition, amendment, or valid related source. Review only; nothing was suppressed.',
                profiles,
                similarity: Number(similarity.toFixed(3))
            }));
        }
    }
    return groups.sort((a, b) => b.members.length - a.members.length || b.similarity - a.similarity);
}

function buildReviewGroups(details = [], state = { groups: {} }) {
    const profiles = buildReviewQualityProfiles(details);
    const exactGroups = buildExactTextReviewGroups(details, state, profiles);
    // Title groups deliberately exclude exact-group members. This keeps every
    // source in one review group only, avoiding conflicting curated decisions.
    const titleGroups = buildTitleReviewGroups(details, state, exactGroups, profiles);
    const groupedSourceIds = new Set(
        [...exactGroups, ...titleGroups].flatMap(group => group.members.map(member => member.sourceId))
    );
    const qualityGroups = buildQualityAnomalyGroups(details, state, groupedSourceIds, profiles);
    for (const group of qualityGroups) for (const member of group.members) groupedSourceIds.add(member.sourceId);
    const nearGroups = buildNearDuplicateReviewGroups(details, state, groupedSourceIds, profiles);
    return [...exactGroups, ...titleGroups, ...qualityGroups, ...nearGroups];
}

async function deleteReviewState(userId, batchId) {
    const target = reviewPath(userId, batchId);
    if (target) await fs.remove(target);
}

module.exports = {
    REVIEWS_DIR,
    safeMissionId,
    combinedReviewId,
    loadReviewState,
    saveReviewState,
    buildExactTextReviewGroups,
    buildTitleReviewGroups,
    buildQualityAnomalyGroups,
    buildNearDuplicateReviewGroups,
    buildReviewGroups,
    deleteReviewState
};
