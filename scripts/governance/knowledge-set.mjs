import { compareCodePoints } from '../lib/deterministic-order.mjs';
import { isSafeReference } from '../lib/reference-safety.mjs';

const ID = /^[a-z][a-z0-9-]*$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const FIELDS = ['constraints', 'domains', 'facts', 'ownerships', 'topologyEdges'];
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
const orderedIds = (values, field) => {
  if (!Array.isArray(values) || new Set(values).size !== values.length || values.some((id) => !ID.test(id))) {
    throw new TypeError(`Invalid semantic ${field} set.`);
  }
  return [...values].sort(compareCodePoints);
};
const orderedFacts = (facts) => {
  if (!Array.isArray(facts)) throw new TypeError('Invalid semantic fact set.');
  const seen = new Set();
  const normalized = facts.map((fact) => {
    if (fact === null || typeof fact !== 'object' || Array.isArray(fact)
      || Object.keys(fact).sort().join('\0') !== [
        'changeKind', 'evidenceRefs', 'evidenceRevision', 'factId', 'ownerDomainId', 'valueHash',
      ].join('\0')
      || !ID.test(fact.factId ?? '') || seen.has(fact.factId)
      || !ID.test(fact.ownerDomainId ?? '') || !HASH.test(fact.valueHash ?? '')
      || !isSafeReference(fact.evidenceRevision)
      || !['EVIDENCE_REFRESH', 'VALUE'].includes(fact.changeKind)
      || !Array.isArray(fact.evidenceRefs) || new Set(fact.evidenceRefs).size !== fact.evidenceRefs.length
      || fact.evidenceRefs.some((ref) => !isSafeReference(ref))) {
      throw new TypeError('Invalid semantic fact entry.');
    }
    seen.add(fact.factId);
    return { ...fact, evidenceRefs: [...fact.evidenceRefs].sort(compareCodePoints) };
  });
  return normalized.sort((left, right) => compareCodePoints(left.factId, right.factId));
};

export function createKnowledgeSet({ domains = [], facts = [], constraints = [], topologyEdges = [], ownerships = [] } = {}) {
  return deepFreeze({
    domains: orderedIds(domains, 'domain'),
    facts: orderedFacts(facts),
    constraints: orderedIds(constraints, 'constraint'),
    topologyEdges: orderedIds(topologyEdges, 'topology'),
    ownerships: orderedIds(ownerships, 'ownership'),
  });
}

export function isKnowledgeSet(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...FIELDS].sort().join('\0')) return false;
    const normalized = createKnowledgeSet(value);
    return JSON.stringify(normalized) === JSON.stringify(value);
  } catch {
    return false;
  }
}

export function knowledgeSetFromDiff(diff, { facts = [], constraints = [], topologyEdges = [], ownerships = [] } = {}) {
  const factIds = new Set(facts.map(({ factId }) => factId));
  const operated = diff?.operations?.flatMap(({ fact_id: id, successor_fact_id: successor }) => [id, ...(successor ? [successor] : [])]) ?? [];
  if (operated.some((id) => !factIds.has(id))) throw new TypeError('Every operated fact requires an exact semantic outcome.');
  const relationshipRefs = diff?.domain_changes?.flatMap(({ relationship_refs: refs = [] }) => refs) ?? [];
  return createKnowledgeSet({
    domains: diff?.domain_changes?.map(({ domain_id: id }) => id) ?? [],
    facts,
    constraints: [...constraints, ...relationshipRefs.filter((ref) => ref.startsWith('constraint:')).map((ref) => ref.slice(11))],
    topologyEdges: [...topologyEdges, ...relationshipRefs.filter((ref) => ref.startsWith('topology:')).map((ref) => ref.slice(9))],
    ownerships: [...ownerships, ...relationshipRefs.filter((ref) => ref.startsWith('owner:')).map((ref) => ref.slice(6))],
  });
}
