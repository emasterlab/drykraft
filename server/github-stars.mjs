const repositoryApi = 'https://api.github.com/repos/emasterlab/drykraft';
let count = null;
let refreshAfter = 0;
let pending;

export function getGitHubStars() {
  if (Date.now() < refreshAfter) return Promise.resolve(count);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(repositoryApi, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DryKraft website' },
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) throw new Error('GitHub star count unavailable');
        const { stargazers_count: stars } = await response.json();
        if (!Number.isSafeInteger(stars) || stars < 0) throw new Error('Invalid star count');
        count = stars;
        refreshAfter = Date.now() + 300_000;
      } catch {
        refreshAfter = Date.now() + 60_000;
      } finally {
        pending = undefined;
      }
      return count;
    })();
  }
  return pending;
}
