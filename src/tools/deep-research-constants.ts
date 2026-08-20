// Shared constants for the deep_research pipeline (deep-research-*.ts).

export const FC_BASE = "https://api.firecrawl.dev/v1";
export const MAX_PER_DOMAIN = 2;          // source diversity - cap hits per domain
export const EXCERPT_CHARS_PER_CHUNK = 600;
export const EXCERPT_TOP_CHUNKS = 4;       // pick top N relevant chunks per source

// Quality scoring - higher = more trustworthy primary source
export const DOMAIN_TIER_BONUS: Array<[RegExp, number]> = [
  [/\.gov(\b|\/|$)/i, 4],
  [/\.edu(\b|\/|$)/i, 3],
  [/(?:nature|science|nih|arxiv|acm|ieee|sciencedirect)\.(?:org|com)/i, 3],
  // Crypto primary-source boost - these are the authoritative data sources
  // for protocol TVL, yields, prices, and on-chain analytics. Rank above
  // generic news for crypto queries.
  [/(?:defillama|tokenterminal|coingecko|coinmarketcap|dune|messari|artemis)\.(?:com|fi)/i, 3],
  [/(?:etherscan|basescan|arbiscan|solscan|polygonscan|optimistic\.etherscan)\.(?:io|com)/i, 2],
  [/(?:reuters|apnews|bbc|economist|ft|wsj|bloomberg)\.com/i, 2],
  [/(?:coindesk|theblock|cointelegraph|decrypt|theinformation)\.(?:co|com|io)/i, 1],
  [/(?:wikipedia|github|stackoverflow)\.(?:org|com)/i, 1],
  [/(?:medium|substack|reddit|twitter|x)\.com/i, -1],
];

// News-domain bonus - applied additionally in fresh mode
export const NEWS_DOMAIN_BOOST_RE = /(?:reuters|apnews|bbc|economist|ft|wsj|bloomberg|cnbc|theverge|techcrunch|axios|coindesk|theinformation|nytimes|guardian|aljazeera)\.com/i;

// Keywords that signal a time-sensitive query - trigger fresh mode auto.
export const FRESH_TRIGGER_RE = /\b(today|tonight|tomorrow|yesterday|this week|last week|past week|latest|breaking|just now|recent|currently|now|live|happening|this month|last month|past month|past \d+ days?|last \d+ days?|q[1-4]|h[12]|202[6-9])\b/i;

export const STOPWORDS = new Set([
  "the","and","for","with","that","this","what","when","where","how","why",
  "have","has","had","are","was","were","will","would","could","should","does",
  "did","being","been","from","into","over","under","about","into","than","then",
  "your","yours","their","they","them","there","here","just","also","more","most",
]);
