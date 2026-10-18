// Configuration defaults shared by loading, services and worker startup. The
// budget covers retained cache estimates; requested working memory is separate.
export const DEFAULT_CHART_CACHE = Object.freeze({ cacheDays: 7, cacheBytes: 1024 * 1024 * 1024 });
