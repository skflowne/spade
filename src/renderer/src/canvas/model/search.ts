// Node search within one canvas (plan §12): by title, type, and status.

export type SearchCandidate = {
  nodeId: string
  title: string
  // The entity's display name, e.g. "Agent".
  typeLabel: string
  // The agent runtime activity where there is one, e.g. "running".
  status: string | null
}

export type SearchResult = SearchCandidate & { score: number }

export const SEARCH_RESULT_LIMIT = 50

const TITLE_EXACT = 100
const TITLE_PREFIX = 60
const TITLE_WORD_PREFIX = 40
const TITLE_SUBSTRING = 25
const FIELD_PREFIX = 15
const FIELD_SUBSTRING = 8

function tokenize(text: string): string[] {
  return text.toLocaleLowerCase().split(/\s+/).filter(Boolean)
}

function scoreField(value: string, token: string): number {
  if (value.startsWith(token)) return FIELD_PREFIX
  return value.includes(token) ? FIELD_SUBSTRING : 0
}

function scoreToken(candidate: { title: string; words: string[]; type: string; status: string }, token: string): number {
  let title = 0
  if (candidate.title === token) title = TITLE_EXACT
  else if (candidate.title.startsWith(token)) title = TITLE_PREFIX
  else if (candidate.words.some((word) => word.startsWith(token))) title = TITLE_WORD_PREFIX
  else if (candidate.title.includes(token)) title = TITLE_SUBSTRING
  return Math.max(title, scoreField(candidate.type, token), scoreField(candidate.status, token))
}

// Every word of the query must match the title, type, or status. Title matches rank above type and status
// matches; equal scores keep canvas order. An empty query finds nothing.
export function searchNodes(
  candidates: readonly SearchCandidate[],
  query: string,
  limit = SEARCH_RESULT_LIMIT
): SearchResult[] {
  const tokens = tokenize(query)
  if (tokens.length === 0) return []
  const matches: Array<{ result: SearchResult; order: number }> = []
  candidates.forEach((candidate, order) => {
    const title = candidate.title.toLocaleLowerCase()
    const prepared = {
      title,
      words: tokenize(title.replace(/[^\p{L}\p{N}]+/gu, ' ')),
      type: candidate.typeLabel.toLocaleLowerCase(),
      status: (candidate.status ?? '').toLocaleLowerCase()
    }
    let score = 0
    for (const token of tokens) {
      const tokenScore = scoreToken(prepared, token)
      if (tokenScore === 0) return
      score += tokenScore
    }
    matches.push({ result: { ...candidate, score }, order })
  })
  return matches
    .sort((a, b) => b.result.score - a.result.score || a.order - b.order)
    .slice(0, limit)
    .map((match) => match.result)
}
